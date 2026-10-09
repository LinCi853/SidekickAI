'use strict'

const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.resolve(__dirname, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function rootPackageVersion(root = ROOT) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error('Root package.json version is not a valid semver')
  return version
}

function planVersions(root = ROOT) {
  const version = rootPackageVersion(root)
  const file = 'package-lock.json'
  const location = path.join(root, file)
  if (!fs.existsSync(location)) return { version, findings: [], requiredMissing: [file] }
  const lock = JSON.parse(fs.readFileSync(location, 'utf8'))
  const findings = [['version', lock.version], ['packages[""].version', lock.packages?.['']?.version]]
    .filter(([, current]) => current !== version)
    .map(([locator, current]) => ({ file, locator, current: current ?? null, expected: version }))
  return { version, findings, requiredMissing: [] }
}

function applyVersions(root = ROOT) {
  const plan = planVersions(root)
  if (plan.requiredMissing.length) throw new Error('Required version files are missing: ' + plan.requiredMissing.join(', '))
  if (plan.findings.some(finding => finding.current === null)) throw new Error('Required version fields are missing')
  const changed = []
  if (plan.findings.length) {
    const file = path.join(root, 'package-lock.json')
    const source = fs.readFileSync(file, 'utf8')
    const value = JSON.parse(source)
    value.version = plan.version
    value.packages[''].version = plan.version
    const indent = source.match(/\n([ \t]+)"/)?.[1] ?? '  '
    fs.writeFileSync(file, JSON.stringify(value, null, indent) + (/\n$/.test(source) ? '\n' : ''))
    changed.push('package-lock.json')
  }
  return { version: plan.version, changed, remaining: planVersions(root).findings }
}

function main(args = process.argv.slice(2)) {
  let root = ROOT
  let apply = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') apply = true
    else if (args[index] === '--check') apply = false
    else if (args[index] === '--root' && args[index + 1]) root = path.resolve(args[++index])
    else throw new Error('Usage: sync-versions.cjs [--check|--apply] [--root <directory>]')
  }
  const result = apply ? applyVersions(root) : planVersions(root)
  if (result.requiredMissing?.length) throw new Error('Required version files are missing: ' + result.requiredMissing.join(', '))
  if (result.findings?.length || result.remaining?.length) throw new Error('Product version drift; run with --apply')
  console.log(JSON.stringify(result, null, 2))
  return result
}

module.exports = { ROOT, rootPackageVersion, planVersions, applyVersions, main }
if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
