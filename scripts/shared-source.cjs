'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const manifestPath = 'maintenance/shared-source.json'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function resolveFile(workspace, relative) {
  if (typeof relative !== 'string' || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)) || path.isAbsolute(relative)) throw new Error('Invalid shared path')
  const file = path.resolve(workspace, relative)
  if (!file.startsWith(path.resolve(workspace) + path.sep)) throw new Error('Shared path leaves workspace')
  for (let current = file; current !== path.resolve(workspace); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Shared source cannot use filesystem links: ' + relative)
  }
  return file
}

function readManifest(workspace) {
  const value = JSON.parse(fs.readFileSync(path.join(workspace, manifestPath), 'utf8'))
  if (value.schemaVersion !== 1 || value.owner !== 'concept' || !value.files || Array.isArray(value.files)) throw new Error('Unsupported shared-source manifest')
  for (const [file, digest] of Object.entries(value.files)) {
    resolveFile(workspace, file)
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid shared digest')
  }
  return value
}

function check(workspace = root) {
  const manifest = readManifest(workspace)
  const drift = Object.entries(manifest.files).filter(([relative, digest]) => {
    const file = resolveFile(workspace, relative)
    return !fs.existsSync(file) || hash(fs.readFileSync(file)) !== digest
  }).map(([file]) => file)
  if (drift.length) throw new Error('Shared source differs from its pinned revision: ' + drift.join(', '))
  if (manifest.revision !== hash(JSON.stringify(manifest.files))) throw new Error('Invalid shared revision')
  return { revision: manifest.revision, files: Object.keys(manifest.files).length }
}

function refresh(workspace = root) {
  if (JSON.parse(fs.readFileSync(path.join(workspace, 'product-edition.json'))).edition !== 'concept') throw new Error('Only the concept workspace owns shared source')
  const manifest = readManifest(workspace)
  manifest.files = Object.fromEntries(Object.keys(manifest.files).sort().map(relative => [relative, hash(fs.readFileSync(resolveFile(workspace, relative)))]))
  manifest.revision = hash(JSON.stringify(manifest.files))
  fs.writeFileSync(path.join(workspace, manifestPath), JSON.stringify(manifest, null, 2) + '\n')
  return check(workspace)
}

function atomicWrite(file, bytes, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + '.shared-' + crypto.randomUUID()
  try {
    io.writeFileSync(temporary, bytes, { flag: 'wx' })
    io.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function synchronize(source, destination = root, io = fs) {
  source = path.resolve(source)
  destination = path.resolve(destination)
  if (source === path.resolve(destination)) throw new Error('Source and destination must differ')
  if (JSON.parse(fs.readFileSync(path.join(source, 'product-edition.json'))).edition !== 'concept') throw new Error('Shared source must come from the concept workspace')
  if (JSON.parse(fs.readFileSync(path.join(destination, 'product-edition.json'))).edition !== 'community') throw new Error('Shared consumer must be the community workspace')
  const incoming = readManifest(source)
  const previous = readManifest(destination)
  if (incoming.revision !== hash(JSON.stringify(incoming.files)) || previous.revision !== hash(JSON.stringify(previous.files))) throw new Error('Invalid shared revision')
  const snapshot = new Map(Object.entries(incoming.files).map(([relative, digest]) => {
    const bytes = fs.readFileSync(resolveFile(source, relative))
    if (hash(bytes) !== digest) throw new Error('Shared source differs from its pinned revision: ' + relative)
    return [relative, bytes]
  }))
  const changes = []
  for (const file of new Set([...Object.keys(previous.files), ...Object.keys(incoming.files)])) {
    const target = resolveFile(destination, file)
    const original = fs.existsSync(target) ? fs.readFileSync(target) : null
    const existing = original === null ? null : hash(original)
    if (existing === incoming.files[file]) continue
    if ((existing === null && previous.files[file] && incoming.files[file]) || (existing !== null && existing !== previous.files[file])) throw new Error('Consumer has local changes: ' + file)
    changes.push({ file, target, original, bytes: snapshot.get(file) ?? null })
  }
  const manifestTarget = resolveFile(destination, manifestPath)
  const manifestBytes = Buffer.from(JSON.stringify(incoming, null, 2) + '\n')
  if (!changes.length && fs.readFileSync(manifestTarget).equals(manifestBytes)) return { ...check(destination), changed: [] }
  changes.push({ file: manifestPath, target: manifestTarget, original: fs.readFileSync(manifestTarget), bytes: manifestBytes })
  const build = resolveFile(destination, 'build')
  fs.mkdirSync(build, { recursive: true })
  const evidence = fs.mkdtempSync(path.join(build, 'shared-sync-'))
  const record = { sourceRevision: incoming.revision, previousRevision: previous.revision, status: 'prepared', files: [] }
  for (const change of changes) {
    if (change.original !== null) {
      const backup = path.join(evidence, 'before', change.file)
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      fs.writeFileSync(backup, change.original, { flag: 'wx' })
    }
    record.files.push({ file: change.file, before: change.original === null ? null : hash(change.original), after: change.bytes === null ? null : hash(change.bytes) })
  }
  const report = path.join(evidence, 'report.json')
  fs.writeFileSync(report, JSON.stringify(record, null, 2) + '\n')
  const applied = []
  try {
    for (const change of changes) {
      const current = fs.existsSync(change.target) ? hash(fs.readFileSync(change.target)) : null
      if (current !== (change.original === null ? null : hash(change.original))) throw new Error('Consumer changed during synchronization: ' + change.file)
      if (change.bytes === null) { if (current !== null) io.unlinkSync(change.target) }
      else atomicWrite(change.target, change.bytes, io)
      applied.push(change)
    }
    const result = check(destination)
    record.status = 'complete'
    fs.writeFileSync(report, JSON.stringify(record, null, 2) + '\n')
    return { ...result, changed: changes.filter(change => change.file !== manifestPath).map(change => change.file), evidence }
  } catch (error) {
    const conflicts = []
    for (const change of applied.reverse()) {
      const current = fs.existsSync(change.target) ? hash(fs.readFileSync(change.target)) : null
      if (current !== (change.bytes === null ? null : hash(change.bytes))) { conflicts.push(change.file); continue }
      try {
        if (change.original === null) { if (current !== null) fs.unlinkSync(change.target) }
        else atomicWrite(change.target, change.original)
      } catch { conflicts.push(change.file) }
    }
    record.status = conflicts.length ? 'recovery-required' : 'rolled-back'
    record.conflicts = conflicts
    record.error = error.message
    fs.writeFileSync(report, JSON.stringify(record, null, 2) + '\n')
    throw new Error(error.message + '; synchronization evidence: ' + evidence)
  }
}

module.exports = { check, refresh, synchronize, resolveFile }
if (require.main === module) {
  try {
    const args = process.argv.slice(2)
    const result = args.length === 0 ? check() : args.length === 1 && args[0] === '--refresh' ? refresh() : args.length === 2 && args[0] === '--from' ? synchronize(args[1]) : (() => { throw new Error('Usage: shared-source.cjs [--refresh | --from <concept-workspace>]') })()
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
