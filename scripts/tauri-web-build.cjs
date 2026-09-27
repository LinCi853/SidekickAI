'use strict'

// Shared production web build for the Tauri wizard and the standalone uninstaller.
//
// Both apps run this through `tauri.conf.json > build.beforeBuildCommand`, so the
// command must not depend on a shell (the previous `set VAR=x&& ...` form only works
// in cmd.exe) and must not depend on whichever environment the Tauri CLI happens to
// forward. The Tauri env markers are set here, in-process, before Vite is loaded.
//
// Why the markers matter: `vite.config.ts` derives the asset base and the build
// target from them. Without `TAURI_ENV_PLATFORM=windows`, the generated HTML would
// reference `/assets/...` (absolute) instead of `./assets/...`, and an embedded asset
// whose URL does not resolve is exactly the failure that leaves the wizard showing a
// directory listing instead of its own UI.

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const APP = path.resolve(__dirname, '..')
const TARGET = 'chrome105'

function archMarker() {
  const arch = (process.env.TAURI_ENV_ARCH || '').toLowerCase()
  return arch === 'arm64' || arch === 'aarch64' ? 'arm64' : 'x64'
}

function resolveVite(app) {
  const candidates = [
    path.join(APP, 'installer-tauri', 'node_modules', 'vite'),
    path.join(app, 'node_modules', 'vite'),
    path.join(APP, 'node_modules', 'vite'),
  ]
  for (const candidate of candidates) {
    const entry = path.join(candidate, 'dist', 'node', 'index.js')
    if (fs.existsSync(entry)) return entry
  }
  throw new Error('Vite is missing: install installer-tauri dependencies before building the Tauri frontends')
}

/** Apply the exact Tauri production markers `vite.config.ts` reads. */
function applyTauriMarkers() {
  process.env.TAURI_ENV_PLATFORM = 'windows'
  process.env.TAURI_ENV_FAMILY = 'windows'
  process.env.TAURI_ENV_ARCH = archMarker()
  process.env.TAURI_ENV_TARGET_TRIPLE = process.env.TAURI_ENV_TARGET_TRIPLE || 'x86_64-pc-windows-msvc'
  process.env.TAURI_ENV_DEBUG = 'false'
}

// Vite prunes files it considers outdated, but a dist left behind by an interrupted
// or differently-configured build must never be trusted: every file in `dist` is
// embedded into the executable, so a stale stray would ship as well.
function clearOutput(outDir) {
  if (outDir === path.parse(outDir).root) throw new Error(`Refusing to clear a filesystem root: ${outDir}`)
  try {
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    throw new Error(`Cannot clear the previous web build output ${outDir}: ${error.message}`)
  }
}

async function buildFrontend(app) {
  const vite = resolveVite(app)
  applyTauriMarkers()
  clearOutput(path.join(app, 'dist'))
  process.chdir(app)
  const { build } = await import(pathToFileURL(vite).href)
  await build({ root: app, logLevel: 'info' })
  return { app, vite, target: TARGET }
}

/** Command string `tauri.conf.json` can run regardless of the active shell. */
function webBuildCommand(app) {
  return `"${process.execPath}" "${path.join(__dirname, 'tauri-web-build.cjs')}" "${app}"`
}

module.exports = { buildFrontend, webBuildCommand, archMarker, applyTauriMarkers, resolveVite, clearOutput }

if (require.main === module) {
  const app = path.resolve(process.argv[2] || process.cwd())
  if (!fs.existsSync(path.join(app, 'index.html'))) {
    console.error(`[tauri-web-build] Not a Tauri frontend: ${path.join(app, 'index.html')} is missing`)
    process.exitCode = 1
  } else {
    buildFrontend(app)
      .then(result => console.log(`[tauri-web-build] built ${result.app} (base=./, target=${result.target})`))
      .catch(error => {
        console.error(`[tauri-web-build] ${error.stack || error}`)
        process.exitCode = 1
      })
  }
}
