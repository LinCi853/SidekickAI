'use strict'

const fs = require('node:fs')
const path = require('node:path')
const runtime = require('./application-runtime.cjs')
const u = require('./build-utils.cjs')

function installationContract(edition, root = path.resolve(__dirname, '..')) {
  const file = path.join(root, 'contracts/installation-contract.json')
  u.assertFile(file)
  if (fs.statSync(file).size > 256 * 1024)
    throw new Error('Application installation contract exceeds its byte limit')
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (
    value.schemaVersion !== 1 ||
    value.productId !== 'sidekickai' ||
    value.edition !== edition ||
    !Array.isArray(value.licenses)
  ) {
    throw new Error('Application installation contract identity mismatch')
  }
  value.licenses = value.licenses.map((doc) => {
    if (!doc || Object.keys(doc).sort().join('|') !== 'defaultOpen|file|id|title')
      throw new Error('Invalid application license reference')
    runtime.validateRelativePath(doc.file)
    const source = path.join(root, ...doc.file.split('/'))
    u.assertFile(source)
    if (fs.statSync(source).size > 128 * 1024)
      throw new Error('Application license exceeds its byte limit')
    return {
      id: doc.id,
      title: doc.title,
      defaultOpen: doc.defaultOpen,
      body: fs.readFileSync(source, 'utf8'),
    }
  })
  const bytes = Buffer.from(runtime.canonicalJson(value) + '\n')
  if (bytes.length > 256 * 1024)
    throw new Error('Application installation contract exceeds its byte limit')
  return bytes
}

module.exports = { installationContract }
