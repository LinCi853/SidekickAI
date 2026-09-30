'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function readContract(root = ROOT) {
  const value = JSON.parse(fs.readFileSync(path.join(root, 'maintenance/component-contract.json'), 'utf8'))
  if (value.schemaVersion !== 1 || !SEMVER.test(value.componentVersion ?? '')
    || value.setupProtocolVersion !== 2 || value.uninstallProtocolVersion !== 1
    || !Array.isArray(value.supportedFeatures) || !value.supportedOptions) throw new Error('Invalid maintenance component contract')
  return value
}

function componentVersion(root = ROOT) { return readContract(root).componentVersion }

module.exports = { ROOT, SEMVER, readContract, componentVersion }
