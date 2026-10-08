const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { DatabaseSync } = require('node:sqlite')
const esbuild = require('esbuild')
const workspace = path.resolve(__dirname, '..')
const edition = Object.entries(require(path.join(workspace, 'packages/product-contract/manifest.json')).editions)
  .find(([, product]) => product.packageName === require(path.join(workspace, 'package.json')).name)[0]
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-durable-test-'))
let core
const options = { basicData: true, cookies: true, indexedDB: true, cache: true }
const evidence = []

before(async () => {
  await esbuild.build({ bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', external: ['electron', 'better-sqlite3'],
    stdin: { resolveDir: workspace, contents: `export * from './packages/backup-core/offline'; export * from './packages/backup-core/jobs'; export * from './packages/backup-core/io'; export * from './packages/backup-core/file-crypto'; export * from './packages/backup-core/stream-archive'; export * from './packages/backup-core/cli';` }, outfile: path.join(base, 'core.cjs') })
  core = require(path.join(base, 'core.cjs'))
})
after(() => {
  const output = path.join(workspace, 'local/development/2026-10-07-reliable-lifecycle')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'backup-core-runtime.json'), JSON.stringify({ checkedAt: new Date().toISOString(), workspace, tests: evidence }, null, 2))
  assert.equal(path.dirname(base), os.tmpdir())
  assert.ok(path.basename(base).startsWith('sidekick-durable-test-'))
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function fixture(name, megabytes = 0) {
  const directory = path.join(base, name)
  const sourceRoot = path.join(directory, 'source')
  const targetDirectory = path.join(directory, 'target')
  const tempRoot = path.join(directory, 'jobs')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(targetDirectory)
  const database = new DatabaseSync(path.join(sourceRoot, 'settings.db'))
  database.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT); INSERT INTO app_settings VALUES ('fixture','original'); CREATE TABLE module_state (id TEXT PRIMARY KEY)")
  database.close()
  if (megabytes) {
    const descriptor = fs.openSync(path.join(sourceRoot, 'payload.bin'), 'w')
    const buffer = randomBytes(1024 * 1024)
    for (let index = 0; index < megabytes; index++) fs.writeSync(descriptor, buffer)
    fs.closeSync(descriptor)
  }
  return { directory, sourceRoot, targetDirectory, tempRoot, targetPath: path.join(targetDirectory, 'backup.zip'), edition, version: 'fixture', options, strict: false }
}
function retained(job, target) { return path.join(core.backupJobDirectory(job.id, target.tempRoot), job.encrypted ? 'artifact.sabackup' : 'artifact.zip') }
async function interrupted(target, encrypted = false) {
  const controller = new AbortController()
  const result = await core.exportOfflineBackup({ ...target, password: encrypted ? 'fixture-password' : undefined, signal: controller.signal, onProgress: job => {
    if (job.progress.phase === 'copying-target' && job.progress.completedBytes >= core.COPY_CHUNK_BYTES) controller.abort()
  } })
  assert.equal(result.status, 'cancelled', result.error)
  assert.equal(fs.existsSync(target.targetPath), false)
  const job = core.queryBackupJob(result.jobId, target.tempRoot)
  assert.equal(job.snapshotReady, true)
  assert.ok(job.transfer.completedBytes >= core.COPY_CHUNK_BYTES)
  assert.ok(job.transfer.completedBytes < job.artifactBytes)
  return { result, job }
}

test('a retained authenticated artifact resumes verified blocks without rereading changed source data', { timeout: 60000 }, async () => {
  const target = fixture('resumable', 18)
  const { job } = await interrupted(target, true)
  const original = { snapshotId: job.snapshotId, artifactSha256: job.artifactSha256, artifactMtime: fs.statSync(retained(job, target)).mtimeMs, offset: job.transfer.completedBytes }
  fs.writeFileSync(path.join(target.sourceRoot, 'later-edit.txt'), 'new edits belong to the next backup')
  let observedOffset = 0
  const result = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot, onProgress: state => { if (state.progress.phase === 'copying-target' && !observedOffset) observedOffset = state.progress.completedBytes } })
  assert.equal(result.success, true, result.error)
  assert.equal(observedOffset, original.offset)
  assert.equal(result.snapshotId, original.snapshotId)
  assert.equal(result.artifactSha256, original.artifactSha256)
  assert.equal(fs.statSync(retained(job, target)).mtimeMs, original.artifactMtime)
  const decrypted = path.join(target.directory, 'decrypted.zip')
  assert.equal(await core.decryptFileStream(result.filePath, decrypted, 'fixture-password'), `${edition}-offline`)
  const manifest = await core.readStreamingArchive(decrypted)
  assert.equal(Object.hasOwn(manifest.entries, 'later-edit.txt'), false)
  evidence.push({ name: 'encrypted block continuation', continuedAtBytes: observedOffset, bytes: job.artifactBytes, snapshotUnchanged: true, artifactUnchanged: true })
})

test('a replacement target directory waits and an explicitly chosen new target reuses the same artifact', { timeout: 60000 }, async () => {
  const target = fixture('device-change', 12)
  const { job } = await interrupted(target)
  const held = `${target.targetDirectory}-original`
  assert.equal(path.dirname(held), target.directory)
  fs.renameSync(target.targetDirectory, held)
  fs.mkdirSync(target.targetDirectory)
  const waited = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
  assert.equal(waited.status, 'waiting')
  assert.equal(waited.waitingReason, 'device-changed')
  assert.deepEqual(fs.readdirSync(target.targetDirectory), [])
  const next = path.join(target.directory, 'rerouted.zip')
  const resumed = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot, targetPath: next })
  assert.equal(resumed.success, true, resumed.error)
  assert.equal(resumed.snapshotId, job.snapshotId)
  assert.equal(resumed.artifactSha256, job.artifactSha256)
  assert.ok(fs.existsSync(path.join(held, path.basename(job.transfer.partialPath))))
  evidence.push({ name: 'replacement device and explicit target change', result: 'passed' })
})

test('a corrupted retained target block cannot be silently accepted or overwritten', { timeout: 60000 }, async () => {
  const target = fixture('corrupt-block', 12)
  const { job } = await interrupted(target)
  const descriptor = fs.openSync(job.transfer.partialPath, 'r+')
  fs.writeSync(descriptor, Buffer.from('corrupt'), 0, 7, 99)
  fs.closeSync(descriptor)
  const before = await core.hashFile(job.transfer.partialPath)
  const result = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
  assert.equal(result.success, false)
  assert.match(result.error, /block failed verification/)
  assert.equal(await core.hashFile(job.transfer.partialPath), before)
  assert.equal(fs.existsSync(target.targetPath), false)
  evidence.push({ name: 'corrupt checkpoint block', result: 'rejected without publication' })
})

test('a killed exporter resumes its durable checkpoint in another process', { timeout: 60000 }, async () => {
  const target = fixture('process-loss', 16)
  const script = path.join(target.directory, 'interrupted.cjs')
  fs.writeFileSync(script, `const fs=require('node:fs');const core=require(${JSON.stringify(path.join(base, 'core.cjs'))});const request=${JSON.stringify(target)};core.exportOfflineBackup({...request,onProgress:job=>{if(job.progress.phase==='copying-target'&&job.progress.completedBytes>=4194304){fs.writeFileSync(${JSON.stringify(path.join(target.directory, 'job-id.txt'))},job.id);process.exit(77)}}}).catch(error=>{console.error(error);process.exit(1)});`)
  const child = spawnSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', timeout: 45000 })
  assert.equal(child.status, 77, child.stderr)
  const id = fs.readFileSync(path.join(target.directory, 'job-id.txt'), 'utf8')
  const before = core.queryBackupJob(id, target.tempRoot)
  assert.equal(before.status, 'running')
  assert.equal(before.transfer.completedBytes, core.COPY_CHUNK_BYTES)
  const result = await core.resumeBackupJob(id, { tempRoot: target.tempRoot })
  assert.equal(result.success, true, result.error)
  assert.equal(result.snapshotId, before.snapshotId)
  assert.equal(result.artifactSha256, before.artifactSha256)
  evidence.push({ name: 'process termination', checkpointBytes: before.transfer.completedBytes, result: 'resumed' })
})

test('source, staging and target budgets are grouped by real volume and low space is explicit', () => {
  const target = fixture('space')
  const grouped = core.checkDiskSpace([{ path: target.sourceRoot, bytes: 123, purpose: 'source' }, { path: target.tempRoot, bytes: 234, purpose: 'staging' }, { path: target.targetDirectory, bytes: 345, purpose: 'target' }], 0)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].requiredBytes, 702)
  assert.throws(() => core.checkDiskSpace([{ path: target.directory, bytes: Number.MAX_SAFE_INTEGER - 64 * 1024 * 1024, purpose: 'fixture' }]), error => error.reason === 'space')
  evidence.push({ name: 'per-volume capacity', combinedBudget: grouped[0].requiredBytes, lowSpace: 'rejected' })
})

test('private staging has explicit current-account and System ACLs on Windows', { skip: process.platform !== 'win32' }, async () => {
  const target = fixture('acl')
  const result = await core.exportOfflineBackup(target)
  assert.equal(result.success, true, result.error)
  const directory = core.backupJobDirectory(result.jobId, target.tempRoot)
  const acl = spawnSync('icacls.exe', [directory], { windowsHide: true, encoding: 'utf8' })
  assert.equal(acl.status, 0)
  assert.match(acl.stdout, /SYSTEM/)
  assert.doesNotMatch(acl.stdout, /\(I\)/)
  evidence.push({ name: 'restricted staging ACL', inheritedEntries: false, plaintextPolicy: core.queryBackupJob(result.jobId, target.tempRoot).stagingPolicy })
})

test('a large ZIP64 backup and restore stay within bounded process memory', { timeout: 180000 }, async () => {
  const target = fixture('large')
  const payload = path.join(target.sourceRoot, 'large.bin')
  const descriptor = fs.openSync(payload, 'w')
  fs.ftruncateSync(descriptor, 600 * 1024 * 1024)
  fs.closeSync(descriptor)
  const script = path.join(target.directory, 'large.cjs')
  const report = path.join(target.directory, 'large-result.json')
  fs.writeFileSync(script, `const fs=require('node:fs');const core=require(${JSON.stringify(path.join(base, 'core.cjs'))});(async()=>{const result=await core.exportOfflineBackup(${JSON.stringify(target)});if(!result.success)throw new Error(result.error);const restored=${JSON.stringify(path.join(target.directory, 'restored'))};fs.mkdirSync(restored);const manifest=await core.readStreamingArchive(result.filePath,{extractTo:restored});fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({success:true,size:fs.statSync(require('node:path').join(restored,'large.bin')).size,maxRssKiB:process.resourceUsage().maxRSS,entryBytes:manifest.inventory.find(x=>x.path==='large.bin').size}));})().catch(error=>{console.error(error);process.exitCode=1});`)
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', script], { windowsHide: true, encoding: 'utf8', timeout: 160000 })
  assert.equal(child.status, 0, child.stderr)
  const result = JSON.parse(fs.readFileSync(report, 'utf8'))
  assert.equal(result.size, 600 * 1024 * 1024)
  assert.equal(result.entryBytes, result.size)
  assert.ok(result.maxRssKiB < 350 * 1024, `Unexpected peak RSS: ${result.maxRssKiB} KiB`)
  evidence.push({ name: '600 MiB ZIP64 roundtrip under 128 MiB heap', ...result })
})

test('the standalone CLI verifies and restores encrypted archives without the application runtime', { timeout: 60000 }, async () => {
  const target = fixture('cli')
  const result = await core.exportOfflineBackup({ ...target, password: 'fixture-password' })
  assert.equal(result.success, true, result.error)
  const cli = path.join(base, 'standalone.cjs')
  const built = spawnSync(process.execPath, [path.join(workspace, 'scripts/build-backup-cli.cjs'), cli], { windowsHide: true, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)
  const restored = path.join(target.directory, 'restored')
  const child = spawnSync(process.execPath, [cli, 'restore', '--file', result.filePath, '--target', restored, '--password-stdin'], { input: 'fixture-password\n', windowsHide: true, encoding: 'utf8', cwd: base })
  assert.equal(child.status, 0, child.stderr)
  const report = JSON.parse(child.stdout)
  assert.equal(report.success, true)
  const database = new DatabaseSync(path.join(restored, 'settings.db'), { readOnly: true })
  assert.equal(database.prepare("SELECT value FROM app_settings WHERE key='fixture'").get().value, 'original')
  database.close()
  const wrong = path.join(target.directory, 'wrong.zip')
  assert.equal(await core.decryptFileStream(result.filePath, wrong, 'incorrect-password'), null)
  assert.equal(fs.existsSync(wrong), false)
  evidence.push({ name: 'independent encrypted restore', applicationProcessRequired: false, wrongPasswordPublishesNothing: true })
})

test('independent restore does not publish an invalid archive and can retry the same destination', async () => {
  const target = fixture('invalid-restore')
  const result = await core.exportOfflineBackup(target)
  assert.equal(result.success, true, result.error)
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(result.filePath)
  const manifest = JSON.parse(zip.readAsText('manifest.json'))
  manifest.entries['settings.db'] = '0'.repeat(64)
  manifest.inventory.find(entry => entry.path === 'settings.db').sha256 = '0'.repeat(64)
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const damaged = path.join(target.directory, 'damaged.zip')
  zip.writeZip(damaged)
  const restored = path.join(target.directory, 'restored')
  await assert.rejects(core.runBackupCli(['restore', '--file', damaged, '--target', restored]), /integrity check failed/)
  assert.equal(fs.existsSync(restored), false)
  assert.equal((await core.runBackupCli(['restore', '--file', result.filePath, '--target', restored])).success, true)
  evidence.push({ name: 'invalid restore publication and retry', result: 'passed' })
})

test('verified snapshot inventory sizes agree with the archive payload', async () => {
  const target = fixture('inventory-size')
  const result = await core.exportOfflineBackup(target)
  assert.equal(result.success, true, result.error)
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(result.filePath)
  const manifest = JSON.parse(zip.readAsText('manifest.json'))
  manifest.inventory.find(entry => entry.path === 'settings.db').size++
  zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  const damaged = path.join(target.directory, 'damaged.zip')
  zip.writeZip(damaged)
  await assert.rejects(core.readStreamingArchive(damaged), /inventory size/)
  evidence.push({ name: 'snapshot inventory size consistency', result: 'rejected' })
})

test('strict publication supports targets without hard links while retaining exclusive creation', async () => {
  const target = { ...fixture('without-hardlinks'), strict: true }
  const link = fs.linkSync
  fs.linkSync = () => { throw Object.assign(new Error('Hard links are unsupported.'), { code: 'ENOSYS' }) }
  let result
  try { result = await core.exportOfflineBackup({ ...target, password: 'fixture-password' }) }
  finally { fs.linkSync = link }
  assert.equal(result.success, true, result.error)
  const original = await core.hashFile(target.targetPath)
  const repeated = await core.exportOfflineBackup(target)
  assert.equal(repeated.success, false)
  assert.equal(repeated.waitingReason, 'target-exists')
  assert.equal(await core.hashFile(target.targetPath), original)
  evidence.push({ name: 'exclusive publication without hard links', mechanism: 'simulated ENOSYS', result: 'passed' })
})

test('an interrupted encryption requests a password again without retaining the password', async () => {
  const target = fixture('password-reentry')
  const password = 'private-fixture-password-not-a-credential'
  const controller = new AbortController()
  const stopped = await core.exportOfflineBackup({ ...target, password, signal: controller.signal, onProgress: job => {
    if (job.progress.phase === 'encrypting') controller.abort()
  } })
  assert.equal(stopped.status, 'cancelled', stopped.error)
  const waiting = await core.resumeBackupJob(stopped.jobId, { tempRoot: target.tempRoot })
  assert.equal(waiting.status, 'waiting')
  assert.equal(waiting.waitingReason, 'password')
  const directory = core.backupJobDirectory(stopped.jobId, target.tempRoot)
  for (const name of fs.readdirSync(directory).filter(name => /\.jsonl?$/.test(name))) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8').includes(password), false)
  const resumed = await core.resumeBackupJob(stopped.jobId, { tempRoot: target.tempRoot, password })
  assert.equal(resumed.success, true, resumed.error)
  assert.equal(resumed.snapshotId, stopped.snapshotId)
  evidence.push({ name: 'password reentry after interrupted encryption', persistedPassword: false, result: 'passed' })
})

test('snapshot corruption is rejected and explicit discard removes only the selected task', async () => {
  const target = fixture('snapshot-corruption')
  const controller = new AbortController()
  const stopped = await core.exportOfflineBackup({ ...target, signal: controller.signal, onProgress: job => {
    if (job.progress.phase === 'snapshot-ready') controller.abort()
  } })
  assert.equal(stopped.status, 'cancelled', stopped.error)
  const job = core.queryBackupJob(stopped.jobId, target.tempRoot)
  fs.writeFileSync(path.join(core.backupSnapshotDirectory(job, target.tempRoot), 'settings.db'), 'damaged snapshot')
  const resumed = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
  assert.equal(resumed.success, false)
  assert.match(resumed.error, /snapshot integrity check failed/)
  assert.equal(fs.existsSync(target.targetPath), false)
  assert.equal(core.listBackupJobs(target.tempRoot).length, 1)
  core.cancelBackupJob(job.id, target.tempRoot, { discard: true })
  assert.deepEqual(core.listBackupJobs(target.tempRoot), [])
  assert.equal(fs.existsSync(path.join(target.sourceRoot, 'settings.db')), true)
  evidence.push({ name: 'corrupt snapshot and explicit discard', result: 'rejected with source retained' })
})

test('the published SABK v1 vector decrypts with both readers and rejects ciphertext tampering', async () => {
  const vector = JSON.parse(fs.readFileSync(path.join(workspace, 'packages/backup-core/sabk-v1-vector.json'), 'utf8'))
  const target = fixture('public-vector')
  const input = path.join(target.directory, 'vector.sabackup')
  const syncOutput = path.join(target.directory, 'sync.txt')
  const streamOutput = path.join(target.directory, 'stream.txt')
  const bytes = Buffer.from(vector.sabkHex, 'hex')
  fs.writeFileSync(input, bytes)
  assert.equal(core.decryptFile(input, syncOutput, vector.password), vector.deviceId)
  assert.equal(await core.decryptFileStream(input, streamOutput, vector.password), vector.deviceId)
  assert.equal(fs.readFileSync(syncOutput).toString('hex'), vector.plaintextHex)
  assert.equal(fs.readFileSync(streamOutput).toString('hex'), vector.plaintextHex)
  bytes[bytes.length - 1] ^= 1
  fs.writeFileSync(input, bytes)
  const rejectedOutput = path.join(target.directory, 'tampered.txt')
  assert.equal(await core.decryptFileStream(input, rejectedOutput, vector.password), null)
  assert.equal(fs.existsSync(rejectedOutput), false)
  evidence.push({ name: 'published encryption test vector', readers: ['sync', 'stream'], tampering: 'rejected' })
})

test('legacy streaming reads reject cookie snapshots with unsupported session paths', async () => {
  const target = fixture('legacy-session')
  const AdmZip = require('adm-zip')
  const zip = new AdmZip()
  zip.addFile('settings.db', fs.readFileSync(path.join(target.sourceRoot, 'settings.db')))
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ appVersion: 'legacy', cookieSnapshots: [{ path: '../unrelated', cookies: [] }] })))
  zip.writeZip(target.targetPath)
  await assert.rejects(core.readStreamingArchive(target.targetPath, { allowLegacy: true }), /session path/)
  evidence.push({ name: 'legacy cookie session validation', result: 'rejected' })
})

function interruptedPublication(target) {
  const script = path.join(target.directory, 'publication.cjs')
  const identifier = path.join(target.directory, 'job-id.txt')
  fs.writeFileSync(script, `const fs=require('node:fs');const core=require(${JSON.stringify(path.join(base, 'core.cjs'))});fs.linkSync=()=>{throw Object.assign(new Error('Unsupported hard link'),{code:'ENOSYS'})};core.exportOfflineBackup({...${JSON.stringify(target)},strict:true,onProgress:job=>{if(job.transfer?.publication?.completedBytes>=4194304){fs.writeFileSync(${JSON.stringify(identifier)},job.id);process.exit(78)}}}).then(result=>{console.error(JSON.stringify(result));process.exit(1)}).catch(error=>{console.error(error);process.exit(1)});`)
  const child = spawnSync(process.execPath, [script], { windowsHide: true, encoding: 'utf8', timeout: 45000 })
  assert.equal(child.status, 78, child.stderr)
  const job = core.queryBackupJob(fs.readFileSync(identifier, 'utf8'), target.tempRoot)
  assert.equal(job.status, 'running')
  assert.equal(job.transfer.publication.completedBytes, core.COPY_CHUNK_BYTES)
  assert.equal(fs.statSync(target.targetPath).size, core.COPY_CHUNK_BYTES)
  assert.ok(job.artifactBytes > core.COPY_CHUNK_BYTES)
  return job
}

test('a killed exclusive publication resumes the same owned output from verified blocks', { timeout: 60000 }, async () => {
  const target = fixture('publication-resume', 12)
  const job = interruptedPublication(target)
  const identity = core.diskIdentity(target.targetPath)
  let resumedAt = 0
  const result = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot, onProgress: state => {
    if (state.progress.phase === 'publishing' && state.progress.completedBytes === core.COPY_CHUNK_BYTES) resumedAt = state.progress.completedBytes
  } })
  assert.equal(result.success, true, result.error)
  assert.equal(resumedAt, core.COPY_CHUNK_BYTES)
  assert.deepEqual(core.diskIdentity(target.targetPath), identity)
  assert.equal(await core.hashFile(target.targetPath), job.artifactSha256)
  evidence.push({ name: 'terminated exclusive publication', continuedAtBytes: resumedAt, sameOwnedFile: true, result: 'passed' })
})

test('exclusive publication never resumes over replaced files or changed verified blocks', { timeout: 60000 }, async () => {
  for (const mode of ['replaced', 'modified']) {
    const target = fixture(`publication-${mode}`, 12)
    const job = interruptedPublication(target)
    if (mode === 'replaced') { fs.renameSync(target.targetPath, `${target.targetPath}.owned`); fs.writeFileSync(target.targetPath, 'unrelated file') }
    else { const descriptor = fs.openSync(target.targetPath, 'r+'); fs.writeSync(descriptor, Buffer.from('external edit'), 0, 13, 100); fs.closeSync(descriptor) }
    const before = await core.hashFile(target.targetPath)
    const result = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
    assert.equal(result.success, false)
    assert.equal(result.status, 'waiting')
    assert.equal(result.waitingReason, 'target-changed')
    assert.equal(await core.hashFile(target.targetPath), before)
    assert.equal(core.queryBackupJob(job.id, target.tempRoot).transfer.publication.completedBytes, core.COPY_CHUNK_BYTES)
  }
  evidence.push({ name: 'replaced or modified publication destination', result: 'preserved without overwrite' })
})

test('strict publication rechecks source changes before claiming completion', async () => {
  const target = fixture('publication-source-change')
  const link = fs.linkSync
  fs.linkSync = () => { throw Object.assign(new Error('Hard links are unsupported.'), { code: 'ENOSYS' }) }
  let result
  try {
    result = await core.exportOfflineBackup({ ...target, strict: true, onProgress: job => {
      if (job.transfer?.publication && job.transfer.publication.completedBytes === job.artifactBytes) fs.writeFileSync(path.join(target.sourceRoot, 'later-edit.txt'), 'new source data')
    } })
  } finally { fs.linkSync = link }
  assert.equal(result.success, false)
  assert.equal(result.status, 'recovery-required')
  assert.equal(fs.existsSync(path.join(target.sourceRoot, 'later-edit.txt')), true)
  evidence.push({ name: 'strict source mutation during publication', result: 'requires new coordinated snapshot' })
})

test('private staging removes inherited grants and rejects foreign explicit grants', { skip: process.platform !== 'win32' }, async () => {
  const target = fixture('private-parent')
  fs.mkdirSync(target.tempRoot)
  const grant = directory => {
    const result = spawnSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  grant(target.tempRoot)
  const exported = await core.exportOfflineBackup(target)
  assert.equal(exported.success, true, exported.error)
  const jobDirectory = core.backupJobDirectory(exported.jobId, target.tempRoot)
  const acl = spawnSync('icacls.exe', [jobDirectory], { windowsHide: true, encoding: 'utf8' })
  assert.equal(acl.status, 0, acl.stderr)
  assert.doesNotMatch(acl.stdout, /Everyone|S-1-1-0|\(I\)/)
  const shared = path.join(target.directory, 'precreated')
  fs.mkdirSync(shared)
  grant(shared)
  assert.throws(() => core.createPrivateDirectory(shared), /private|access|ACL/i)
  grant(jobDirectory)
  assert.throws(() => core.queryBackupJob(exported.jobId, target.tempRoot), /private|access|ACL/i)
  evidence.push({ name: 'inherited and foreign explicit Windows ACL grants', newJobPrivate: true, precreatedAndModifiedSharedJobs: 'rejected' })
})

async function emptyTransfer(target) {
  const controller = new AbortController()
  const result = await core.exportOfflineBackup({ ...target, signal: controller.signal, onProgress: job => {
    if (job.progress.phase === 'copying-target' && job.progress.completedBytes === 0) controller.abort()
  } })
  assert.equal(result.status, 'cancelled', result.error)
  const job = core.queryBackupJob(result.jobId, target.tempRoot)
  assert.equal(job.transfer.blockCount, 0)
  return job
}

test('a replaced empty transfer file is preserved by resume and discard', async () => {
  for (const action of ['resume', 'discard']) {
    const target = fixture(`partial-replaced-${action}`)
    const job = await emptyTransfer(target)
    fs.renameSync(job.transfer.partialPath, `${job.transfer.partialPath}.owned`)
    fs.writeFileSync(job.transfer.partialPath, 'unrelated content at the same path')
    if (action === 'resume') {
      const result = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
      assert.equal(result.status, 'waiting')
      assert.equal(result.waitingReason, 'target-changed')
    } else assert.throws(() => core.cancelBackupJob(job.id, target.tempRoot, { discard: true }), error => error.reason === 'target-changed')
    assert.equal(fs.readFileSync(job.transfer.partialPath, 'utf8'), 'unrelated content at the same path')
    assert.equal(fs.existsSync(core.backupJobDirectory(job.id, target.tempRoot)), true)
  }
  evidence.push({ name: 'replaced zero-checkpoint partial', resume: 'preserved', discard: 'preserved' })
})

test('matching transfer bytes do not substitute for the original file identity', async () => {
  const target = fixture('partial-matching-bytes', 12)
  const { job } = await interrupted(target)
  const held = `${job.transfer.partialPath}.owned`
  fs.renameSync(job.transfer.partialPath, held)
  fs.copyFileSync(held, job.transfer.partialPath, fs.constants.COPYFILE_EXCL)
  const before = await core.hashFile(job.transfer.partialPath)
  const resumed = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
  assert.equal(resumed.status, 'waiting')
  assert.equal(resumed.waitingReason, 'target-changed')
  assert.equal(await core.hashFile(job.transfer.partialPath), before)
  evidence.push({ name: 'same-byte different-file partial', result: 'rejected without overwrite' })
})

test('legacy transfer records without file identity cannot claim existing partial files', async () => {
  const target = fixture('partial-without-identity')
  const job = await emptyTransfer(target)
  delete job.transfer.partialIdentity
  core.saveBackupJob(job, { tempRoot: target.tempRoot })
  const resumed = await core.resumeBackupJob(job.id, { tempRoot: target.tempRoot })
  assert.equal(resumed.status, 'waiting')
  assert.equal(resumed.waitingReason, 'target-changed')
  assert.throws(() => core.cancelBackupJob(job.id, target.tempRoot, { discard: true }), error => error.reason === 'target-changed')
  assert.equal(fs.existsSync(job.transfer.partialPath), true)
  evidence.push({ name: 'legacy partial without ownership identity', result: 'preserved for explicit rerouting' })
})
