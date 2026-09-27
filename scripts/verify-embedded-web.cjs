'use strict'

// Proof that a built Tauri wizard/uninstaller carries its web UI inside the PE
// instead of pointing at a build-machine directory.
//
// Background: the release build used to pass an absolute `frontendDist` through the
// Tauri CLI `--config` override. `tauri-utils` deserialises `frontendDist` with an
// untagged enum, and `Url::parse` happily accepts `E:\...\dist` as the URL scheme
// `e:`. The config therefore became `FrontendDist::Url(file:///E:/.../installer-tauri/dist/)`:
// no assets were embedded and the runtime webview loaded `file:///E:/.../dist/`
// straight from the build machine, which renders a directory index - or, on any other
// machine, "file not found". The standalone uninstaller has it worse: it relocates
// itself into a private temporary directory before showing its UI, so it can never
// reach the build directory at all.
//
// Two independent gates keep that from shipping again:
//   1. `assertEmbeddableFrontendDist` rejects the config value that causes it.
//   2. `verifyEmbeddedWebAssets` proves the built executable really embeds the UI, by
//      inspecting the per-asset brotli streams `tauri-codegen` emitted for this build
//      in the Cargo output directory. A byte missing there cannot be in the binary:
//      the generated code puts every one of them behind `include_bytes!`.

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex')

/** List every file below `directory`, depth first, sorted by URL-style key. */
function distEntries(directory) {
  const entries = []
  const visit = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(file, key)
      else if (entry.isFile()) entries.push({ key, file, bytes: fs.readFileSync(file) })
    }
  }
  visit(directory, '')
  return entries
}

/**
 * Reject a production `frontendDist` that Tauri would read as a URL.
 *
 * `tauri-utils::config::FrontendDist` is an untagged enum ordered Url first, and
 * `Url::parse("E:\\app\\dist")` succeeds with scheme `e:`. An absolute path is
 * therefore silently accepted as an external URL: no assets are embedded, and the
 * webview is pointed at `file:///E:/app/dist/` - a directory index on the build
 * machine and "file not found" anywhere else. Only a relative path keeps the
 * directory semantics that produce an embedded asset map.
 */
function assertEmbeddableFrontendDist(value, label = 'frontendDist') {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  const problems = []
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{1,2}/.test(value)) problems.push('it is an absolute path')
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) problems.push(`it parses as the URL scheme "${value.split(':')[0]}:"`)
  if (problems.length) {
    throw new Error(
      `${label} "${value}" would not be embedded because ${problems.join(' and ')}. ` +
      'tauri-utils reads such a value as FrontendDist::Url, so the wizard and the standalone ' +
      'uninstaller would load their UI from the build machine instead of carrying it inside the ' +
      'executable. Use a path relative to src-tauri, for example "../dist".',
    )
  }
  return { value, relative: true }
}

/** Validate that the built entry document can only refer to embedded assets. */
function assertEmbeddedEntryReferences(htmlBytes, label = 'index.html') {
  const html = htmlBytes.toString('utf8')
  const references = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map(match => match[1])
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]*)"/g)].map(match => match[1])
  if (!scripts.length) throw new Error(`${label} loads no script`)
  for (const reference of [...scripts, ...references]) {
    if (reference === '') continue
    if (/^(?:https?:)?\/\//i.test(reference)) throw new Error(`${label} references a remote asset: ${reference}`)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(reference)) throw new Error(`${label} references a non-relative asset: ${reference}`)
    if (reference.startsWith('/')) {
      throw new Error(`${label} references a root-absolute asset: ${reference}. An embedded asset map is keyed relative to the dist root, so the webview would request it from the custom-protocol origin root and miss.`)
    }
  }
  return { references }
}

/** Newest `out` directory of the build script that expands the context macro. */
function codegenOutputDirectory(targetDir, targetTriple, cratePrefix) {
  const buildRoot = path.join(targetDir, targetTriple, 'release', 'build')
  if (!fs.existsSync(buildRoot)) return null
  const candidates = fs.readdirSync(buildRoot)
    .filter(name => name.startsWith(cratePrefix))
    .map(name => path.join(buildRoot, name, 'out'))
    .filter(directory => fs.existsSync(path.join(directory, 'tauri-codegen-assets')))
    .map(directory => ({ directory, at: fs.statSync(directory).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return candidates.length ? candidates[0].directory : null
}

/**
 * Read the per-asset brotli streams `tauri-codegen` produced for this build and match
 * them against the production web output by decompressed content hash.
 */
function verifyCodegenAssets(outDir, dist) {
  const assetsDir = path.join(outDir, 'tauri-codegen-assets')
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`tauri-codegen produced no embedded asset directory for this build: ${assetsDir}`)
  }
  const streams = fs.readdirSync(assetsDir).map(name => {
    const file = path.join(assetsDir, name)
    try {
      return zlib.brotliDecompressSync(fs.readFileSync(file))
    } catch (error) {
      throw new Error(`Embedded asset stream is not readable brotli (${file}): ${error.message}`)
    }
  })
  const byDigest = new Map(streams.map(stream => [sha256(stream), stream]))
  const entries = distEntries(dist)
  const missing = entries.filter(entry => !byDigest.has(sha256(entry.bytes))).map(entry => entry.key)
  return { outDir, assetsDir, streams: streams.length, files: entries.map(entry => entry.key), missing }
}

/**
 * Verify the production web output is embeddable and that this build really embedded
 * it. Returns the evidence written into the release record.
 *
 * @param {string} app Tauri app directory (installer-tauri / uninstaller-tauri)
 * @param {object} options
 * @param {string} options.targetDir CARGO_TARGET_DIR used for the build
 * @param {string} options.targetTriple rust target triple used for the build
 * @param {string} options.cratePrefix build-script directory prefix, e.g. sidekickai-installer
 * @param {string} [options.executable] built executable, checked for the disk-path leak
 */
function verifyEmbeddedWebAssets(app, { targetDir, targetTriple, cratePrefix, executable } = {}) {
  const dist = path.join(app, 'dist')
  if (!fs.existsSync(dist)) throw new Error(`Production web output is missing: ${dist}`)
  const entries = distEntries(dist)
  const html = entries.find(entry => entry.key === 'index.html')
  if (!html) throw new Error(`Production web output has no index.html: ${dist}`)
  const references = assertEmbeddedEntryReferences(html.bytes)

  const outDir = codegenOutputDirectory(targetDir, targetTriple, cratePrefix)
  if (!outDir) {
    throw new Error(
      `No tauri-codegen asset directory found under ${path.join(targetDir, targetTriple, 'release', 'build')} for ${cratePrefix}. ` +
      'The executable was reused from an earlier build, so this run cannot prove what it embeds. ' +
      'Rebuild after changing the product version or any frontend/Rust source that feeds the fingerprint.',
    )
  }
  const codegen = verifyCodegenAssets(outDir, dist)
  if (codegen.missing.length) {
    throw new Error(
      `This build did not embed its web UI (missing ${codegen.missing.join(', ')}). ` +
      'The wizard would load its UI from the build machine at runtime and show a directory index ' +
      'or "file not found" instead of the installer. Do not pass an absolute frontendDist through ' +
      'the Tauri CLI --config override: tauri-utils parses it as a URL, so no assets are embedded. ' +
      'Let tauri.conf.json drive frontendDist with a path relative to src-tauri.',
    )
  }

  const evidence = {
    app,
    dist,
    executable: executable || null,
    references: references.references,
    files: codegen.files,
    streams: codegen.streams,
    codegenOutDir: outDir,
    missing: [],
  }
  if (executable && fs.existsSync(executable)) {
    const bytes = fs.readFileSync(executable)
    evidence.executableBytes = bytes.length
    // A disk-loading build bakes the build-machine dist path into the binary.
    evidence.diskPathLeak = bytes.includes(Buffer.from(dist.replaceAll('\\', '/'), 'utf8')) || bytes.includes(Buffer.from(dist, 'utf8'))
  }
  return evidence
}

module.exports = { verifyEmbeddedWebAssets, verifyCodegenAssets, assertEmbeddableFrontendDist, assertEmbeddedEntryReferences, codegenOutputDirectory, distEntries }
