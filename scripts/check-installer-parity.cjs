const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const relative = 'installer-shared/presentation'
const manifest = JSON.parse(fs.readFileSync(path.join(root, relative, 'manifest.json'), 'utf8'))
const peer = process.argv[2] ? path.resolve(process.argv[2]) : null
const files = [...manifest.files, 'manifest.json'].map(file => {
  assert(!file.includes('/') && !file.includes('\\') && !file.includes('..'))
  const bytes = fs.readFileSync(path.join(root, relative, file))
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (peer) assert(bytes.equals(fs.readFileSync(path.join(peer, relative, file))), 'Shared wizard differs: ' + file)
  return { file, sha256: digest }
})
assert(fs.readFileSync(path.join(root, relative, 'Wizard.tsx'), 'utf8').includes("WIZARD_DESIGN_VERSION = '" + manifest.designVersion + "'"))
console.log(JSON.stringify({ designVersion: manifest.designVersion, peer, files, ok: true }, null, 2))
