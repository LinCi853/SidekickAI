'use strict'

// Product and maintenance versions have independent authoritative sources.
// The protocol core retains its own version. Checks never rewrite sources.

const fs = require('node:fs')
const path = require('node:path')
const { componentVersion } = require('./component-contract.cjs')

const ROOT = path.resolve(__dirname, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// Only the root lock follows the product version; other targets follow the component.
const TARGETS = [
  { file: 'package-lock.json', kind: 'json-lock' },
  { file: 'installer-tauri/package.json', kind: 'json-version' },
  { file: 'installer-tauri/package-lock.json', kind: 'json-lock' },
  { file: 'installer-tauri/src-tauri/tauri.conf.json', kind: 'json-version' },
  { file: 'installer-tauri/src-tauri/Cargo.toml', kind: 'cargo-package' },
  { file: 'installer-tauri/src-tauri/Cargo.lock', kind: 'cargo-lock', packages: ['sidekickai-installer', 'sidekickai-uninstall-host'] },
  { file: 'uninstaller-tauri/package.json', kind: 'json-version' },
  { file: 'uninstaller-tauri/package-lock.json', kind: 'json-lock', optional: true },
  { file: 'uninstaller-tauri/src-tauri/tauri.conf.json', kind: 'json-version' },
  { file: 'uninstaller-tauri/src-tauri/Cargo.toml', kind: 'cargo-package' },
  { file: 'uninstaller-tauri/src-tauri/Cargo.lock', kind: 'cargo-lock', packages: ['sidekickai-uninstaller', 'sidekickai-uninstall-host'] },
  { file: 'installer-shared/uninstall-host/Cargo.toml', kind: 'cargo-package' },
  { file: 'installer-shared/uninstall-host/Cargo.lock', kind: 'cargo-lock', packages: ['sidekickai-uninstall-host'], conditional: true },
]

/** The independent protocol crate: intentionally never rewritten by this tool. */
const INDEPENDENT = ['installer-shared/uninstall-core/Cargo.toml']

function targetsFor(root = ROOT) {
  return TARGETS.filter(target => !target.conditional || fs.existsSync(path.join(root, target.file)))
}

function rootPackageVersion(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) throw new Error(`Root package.json version is not a valid semver: ${JSON.stringify(manifest.version)}`)
  return manifest.version
}

// --- JSON helpers ----------------------------------------------------------

function indentation(source) {
  const match = source.match(/\n([ \t]+)"/)
  return { indent: match ? match[1] : '  ', trailing: /\n$/.test(source) ? '\n' : '' }
}

function jsonVersion(source, key = 'version') {
  const value = JSON.parse(source)
  return typeof value[key] === 'string' ? value[key] : null
}

function rewriteJsonVersion(source, version, key = 'version') {
  if (jsonVersion(source, key) === version) return source
  const value = JSON.parse(source)
  value[key] = version
  return JSON.stringify(value, null, indentation(source).indent) + indentation(source).trailing
}

function jsonLockVersions(source) {
  const value = JSON.parse(source)
  return {
    version: typeof value.version === 'string' ? value.version : null,
    root: value.packages && value.packages[''] && typeof value.packages[''].version === 'string' ? value.packages[''].version : null,
  }
}

function rewriteJsonLockVersion(source, version) {
  const current = jsonLockVersions(source)
  if (current.version === version && (current.root === null || current.root === version)) return source
  const value = JSON.parse(source)
  if (typeof value.version === 'string') value.version = version
  if (value.packages && value.packages[''] && typeof value.packages[''].version === 'string') value.packages[''].version = version
  return JSON.stringify(value, null, indentation(source).indent) + indentation(source).trailing
}

// --- Cargo helpers ---------------------------------------------------------

/** First `version = "..."` under [package], with its position for rewriting. */
function cargoPackageVersion(source) {
  const lines = source.split('\n')
  let inPackage = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\[package\]\s*\r?$/.test(line)) { inPackage = true; continue }
    if (inPackage && /^\[/.test(line)) break
    if (!inPackage) continue
    const match = line.match(/^(\s*)version\s*=\s*"([^"]*)"/)
    if (match) return { version: match[2], line: index, indent: match[1] }
  }
  return null
}

function rewriteCargoPackageVersion(source, version) {
  const found = cargoPackageVersion(source)
  if (!found) throw new Error('Cargo.toml has no [package] version')
  if (found.version === version) return source
  const lines = source.split('\n')
  const endOfLine = lines[found.line].endsWith('\r') ? '\r' : ''
  lines[found.line] = `${found.indent}version = "${version}"${endOfLine}`
  return lines.join('\n')
}

/** Version line of a named [[package]] entry in a Cargo.lock. */
function cargoLockVersion(source, name) {
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== `name = "${name}"`) continue
    for (let next = index + 1; next < lines.length && !/^\s*\[\[/.test(lines[next]); next++) {
      const match = lines[next].match(/^(\s*)version\s*=\s*"([^"]*)"(.*)$/)
      if (match) return { version: match[2], line: next, indent: match[1], suffix: match[3] }
    }
  }
  return null
}

function rewriteCargoLockVersions(source, version, packages) {
  let result = source
  for (const name of packages) {
    const found = cargoLockVersion(result, name)
    if (!found || found.version === version) continue
    const lines = result.split('\n')
    lines[found.line] = `${found.indent}version = "${version}"${found.suffix}`
    result = lines.join('\n')
  }
  return result
}

// --- Plan / apply ----------------------------------------------------------

function inspectTarget(root, version, target) {
  const file = path.join(root, target.file)
  if (!fs.existsSync(file)) return { missing: true, findings: [] }
  const source = fs.readFileSync(file, 'utf8')
  const findings = []
  const add = (locator, current) => {
    if (current !== version) findings.push({ file: target.file, locator, current, expected: version })
  }
  if (target.kind === 'json-version') add('version', jsonVersion(source))
  else if (target.kind === 'json-lock') {
    const current = jsonLockVersions(source)
    add('version', current.version)
    add('packages[""].version', current.root)
  } else if (target.kind === 'cargo-package') add('package.version', cargoPackageVersion(source)?.version ?? null)
  else if (target.kind === 'cargo-lock') for (const name of target.packages) add(`${name}.version`, cargoLockVersion(source, name)?.version ?? null)
  else throw new Error(`Unknown version target kind: ${target.kind}`)
  return { missing: false, findings }
}

function applyTarget(root, version, target) {
  const file = path.join(root, target.file)
  if (!fs.existsSync(file)) return false
  const source = fs.readFileSync(file, 'utf8')
  let rewritten = source
  if (target.kind === 'json-version') rewritten = rewriteJsonVersion(source, version)
  else if (target.kind === 'json-lock') rewritten = rewriteJsonLockVersion(source, version)
  else if (target.kind === 'cargo-package') rewritten = rewriteCargoPackageVersion(source, version)
  else if (target.kind === 'cargo-lock') rewritten = rewriteCargoLockVersions(source, version, target.packages)
  else throw new Error(`Unknown version target kind: ${target.kind}`)
  if (rewritten === source) return false
  fs.writeFileSync(file, rewritten)
  return true
}

function planVersions(root = ROOT, version = rootPackageVersion(root)) {
  const maintenanceVersion = componentVersion(root)
  const findings = []
  const missing = []
  const requiredMissing = []
  for (const target of targetsFor(root)) {
    const result = inspectTarget(root, target.file === 'package-lock.json' ? version : maintenanceVersion, target)
    if (result.missing) (target.optional ? missing : requiredMissing).push(target.file)
    findings.push(...result.findings)
  }
  return { version, componentVersion: maintenanceVersion, findings, missing, requiredMissing }
}

function applyVersions(root = ROOT, version = rootPackageVersion(root)) {
  const plan = planVersions(root, version)
  if (plan.requiredMissing.length) throw new Error(`Required version files are missing: ${plan.requiredMissing.join(', ')}`)
  const absentFields = plan.findings.filter(finding => finding.current === null)
  if (absentFields.length) throw new Error(`Required version fields are missing: ${absentFields.map(finding => `${finding.file} ${finding.locator}`).join(', ')}`)
  const changed = []
  for (const target of targetsFor(root)) if (applyTarget(root, target.file === 'package-lock.json' ? version : plan.componentVersion, target)) changed.push(target.file)
  const remaining = planVersions(root, version)
  return { version, componentVersion: plan.componentVersion, changed, remaining: remaining.findings, missing: remaining.missing }
}

function main(args = process.argv.slice(2)) {
  const options = { apply: false, root: ROOT }
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === '--apply') options.apply = true
    else if (name === '--check') options.apply = false
    else if (name === '--root' && args[index + 1]) options.root = path.resolve(args[++index])
    else throw new Error('Usage: sync-versions.cjs [--check|--apply] [--root <directory>]')
  }
  const version = rootPackageVersion(options.root)
  if (options.apply) {
    const result = applyVersions(options.root, version)
    console.log(`[sync-versions] Applied ${version}: ${result.changed.length} file(s) updated${result.changed.length ? `: ${result.changed.join(', ')}` : ''}`)
    if (result.missing.length) console.log(`[sync-versions] Missing optional files (not created): ${result.missing.join(', ')}`)
    if (result.remaining.length) throw new Error(`Version drift remains after apply: ${JSON.stringify(result.remaining)}`)
    return result
  }
  const { findings, missing, requiredMissing } = planVersions(options.root, version)
  if (missing.length) console.log(`[sync-versions] Skipped missing optional files: ${missing.join(', ')}`)
  if (requiredMissing.length) {
    for (const file of requiredMissing) console.error(`[sync-versions] ${file}: required version file is missing`)
    const error = new Error(`Required version files are missing: ${requiredMissing.join(', ')}`)
    error.requiredMissing = requiredMissing
    throw error
  }
  if (findings.length) {
    for (const finding of findings) console.error(`[sync-versions] ${finding.file} ${finding.locator}: ${finding.current} != ${finding.expected}`)
    const error = new Error(`${findings.length} version target(s) drifted from ${version}; run with --apply`)
    error.findings = findings
    throw error
  }
  console.log(`[sync-versions] Product ${version}; maintenance ${componentVersion(options.root)}`)
  return { version, componentVersion: componentVersion(options.root), findings: [] }
}

module.exports = {
  ROOT, TARGETS, INDEPENDENT, targetsFor, rootPackageVersion,
  jsonVersion, rewriteJsonVersion, jsonLockVersions, rewriteJsonLockVersion,
  cargoPackageVersion, rewriteCargoPackageVersion, cargoLockVersion, rewriteCargoLockVersions,
  planVersions, applyVersions, main,
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[sync-versions] ${error.message}`)
    process.exitCode = 1
  }
}
