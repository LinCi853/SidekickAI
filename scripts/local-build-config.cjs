'use strict'

const fs = require('node:fs')
const path = require('node:path')

function object(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid local distribution build configuration')
  return value
}

function readLocalBuildConfiguration(root) {
  const file = path.join(root, 'local/distribution-build.json')
  if (!fs.existsSync(file)) return {}
  let config
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch { throw new Error('Cannot parse local distribution build configuration') }
  object(config, ['schemaVersion', 'publicConfiguration', 'toolDirectories'])
  if (config.schemaVersion !== 1) throw new Error('Unsupported local distribution build configuration')
  if (config.publicConfiguration !== undefined) {
    const publicConfig = object(config.publicConfiguration, ['origin', 'distributionKeys', 'resourceKeys', 'allowedHosts'])
    if (publicConfig.origin !== undefined && typeof publicConfig.origin !== 'string'
      || ['distributionKeys', 'resourceKeys', 'allowedHosts'].some(key => publicConfig[key] !== undefined && !Array.isArray(publicConfig[key]))) {
      throw new Error('Invalid local public distribution configuration')
    }
  }
  if (config.toolDirectories !== undefined && (!Array.isArray(config.toolDirectories)
    || config.toolDirectories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory)))) {
    throw new Error('Local build tool directories must be absolute')
  }
  return config
}

function localBuildEnvironment(root, env = process.env) {
  const config = readLocalBuildConfiguration(root)
  const publicConfig = config.publicConfiguration || {}
  const defaults = {}
  if (publicConfig.origin !== undefined) defaults.SIDEKICK_OXY_ORIGIN = publicConfig.origin
  for (const [key, variable] of [['distributionKeys', 'SIDEKICK_DISTRIBUTION_TRUST_KEYS_JSON'],
    ['resourceKeys', 'SIDEKICK_RESOURCE_TRUST_KEYS_JSON'], ['allowedHosts', 'SIDEKICK_RESOURCE_ALLOWED_HOSTS_JSON']]) {
    if (publicConfig[key] !== undefined) defaults[variable] = JSON.stringify(publicConfig[key])
  }
  const result = { ...defaults, ...env }
  if (config.toolDirectories?.length) {
    const seen = new Set()
    result.PATH = [...config.toolDirectories, ...(env.PATH || env.Path || '').split(path.delimiter)].filter(directory => {
      if (!directory || seen.has(directory.toLowerCase())) return false
      seen.add(directory.toLowerCase())
      return true
    }).join(path.delimiter)
  }
  return result
}

module.exports = { readLocalBuildConfiguration, localBuildEnvironment }
