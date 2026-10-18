'use strict'

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const { peInfo } = require('./build-utils.cjs')

function signingConfiguration(env = process.env) {
  const thumbprint = env.SIDEKICK_AUTHENTICODE_CERTIFICATE_SHA1 || ''
  const tool = env.SIDEKICK_SIGNTOOL || ''
  const timestamp = env.SIDEKICK_AUTHENTICODE_TIMESTAMP || 'http://timestamp.digicert.com'
  if (!thumbprint && !tool) {
    if (env.SIDEKICK_REQUIRE_AUTHENTICODE === '1') throw new Error('Windows code signing must be configured before a public build')
    return null
  }
  if (!/^[a-fA-F0-9]{40}$/.test(thumbprint) || !tool || !fs.existsSync(tool)) throw new Error('Invalid Windows code signing configuration')
  const url = new URL(timestamp)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Windows timestamp service')
  return { thumbprint, tool, timestamp, store: env.SIDEKICK_AUTHENTICODE_STORE || 'My' }
}

function signExecutable(file, env = process.env) {
  const configuration = signingConfiguration(env)
  if (!configuration) return { signed: false, reason: 'local-candidate' }
  const signed = spawnSync(configuration.tool, ['sign', '/fd', 'SHA256', '/td', 'SHA256',
    '/tr', configuration.timestamp, '/s', configuration.store, '/sha1', configuration.thumbprint, file],
  { windowsHide: true, stdio: 'pipe' })
  if (signed.error || signed.status !== 0) throw new Error('Windows code signing failed')
  const verified = spawnSync(configuration.tool, ['verify', '/pa', file], { windowsHide: true, stdio: 'pipe' })
  if (verified.error || verified.status !== 0 || !peInfo(fs.readFileSync(file)).certificate) throw new Error('Windows code signature did not verify')
  return { signed: true }
}

module.exports = { signingConfiguration, signExecutable }
