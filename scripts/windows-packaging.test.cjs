'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const build = require('./application-packaging.cjs')
const portable = require('./pack-portable.cjs')
const { createRuntime } = require('./test-fixtures/application-runtime.cjs')
const u = require('./build-utils.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-windows-package-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('each green archive carries one native runtime without recovery, installation state or official proofs', async (t) => {
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const before = {}
  for (const arch of ['x64', 'arm64'])
    before[arch] = build.applicationFingerprint(await createRuntime(applications, arch))
  const output = path.join(root, 'green')
  const artifacts = await portable.packPortable({
    output,
    applications,
    minimumZipBytes: 1,
  })
  assert.deepEqual(
    artifacts.map((artifact) => artifact.arch),
    ['x64', 'arm64'],
  )
  for (const artifact of artifacts) {
    const arch = artifact.arch
    assert.equal(
      path.basename(artifact.path),
      `SidekickAI-Portable-${build.VERSION}-${arch}-win.zip`,
    )
    const zip = new AdmZip(artifact.path)
    const names = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => entry.entryName)
    assert.ok(names.includes('SidekickAI/SidekickAI.exe'))
    assert.ok(names.includes('SidekickAI/resources/app.asar'))
    // 绿色包不带卸载器：卸载由通用卸载器按包内契约执行
    assert.ok(!names.some((name) => /uninstall/i.test(name)))
    assert.ok(!names.some((name) => name.startsWith('SidekickAI/resources/host-backup/')))
    // 包根标记内容固定为 portable，通用卸载器据此识别绿色包
    assert.equal(zip.readFile('SidekickAI/portable.txt').toString('utf8'), 'portable')
    // 包内清单声明产品身份、安装根归属与数据根，卸载范围以此为准
    const contract = JSON.parse(
      zip.readFile('SidekickAI/maintenance/portable.json').toString('utf8'),
    )
    assert.deepEqual(contract, {
      schemaVersion: 1,
      kind: 'portable-manifest',
      product: { productId: 'sidekickai-opensource', version: build.VERSION },
      rootOwned: true,
      dataRoots: [{ scope: 'install-root', path: 'data', recursive: true }],
      registrations: [],
    })
    // 单架构包内只有本架构运行目录，不再有并列目录、启动器或布局契约文件
    assert.ok(
      !names.some((name) => name.startsWith('SidekickAI/' + build.TARGETS[arch].directory + '/')),
    )
    assert.ok(
      !names.some((name) =>
        /(?:recover\.exe|lifecycle-package|installation-contract|proof\.json|backup-runtime\.zip|install-receipt|Start-SidekickAI\.cmd|portable-layout\.json)/i.test(
          name,
        ),
      ),
    )
    // 除契约清单外，包内不得混入其它维护期文件
    assert.ok(
      !names.some(
        (name) => name.includes('/maintenance/') && name !== 'SidekickAI/maintenance/portable.json',
      ),
    )
    assert.ok(!names.some((name) => /^SidekickAI\/data\/.+/.test(name)))
    const manifest = JSON.parse(zip.readFile('SidekickAI/portable-manifest.json').toString())
    assert.deepEqual(manifest.architectures, [arch])
    assert.match(manifest.contents.uninstallContract, /portable\.txt/)
    assert.match(manifest.contents.excludedMaintenanceRuntime, /host-backup/)
    for (const file of manifest.files) {
      const bytes = zip.readFile('SidekickAI/' + file.path)
      assert.equal(bytes.length, file.size)
      assert.equal(u.hash(bytes), file.sha256)
    }
    assert.deepEqual(
      names
        .filter((name) => !name.endsWith('/portable-manifest.json'))
        .map((name) => name.slice('SidekickAI/'.length))
        .sort(),
      manifest.files.map((file) => file.path).sort(),
    )
    assert.deepEqual(
      build.applicationFingerprint(path.join(applications, build.TARGETS[arch].directory)),
      before[arch],
    )
  }
  await assert.rejects(
    portable.packPortable({
      output,
      applications,
      minimumZipBytes: 1,
    }),
    /already exists/,
  )
})

test('portable packaging can produce a single architecture archive on demand', async (t) => {
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  await createRuntime(applications, 'x64')
  const output = path.join(root, 'green')
  const artifacts = await portable.packPortable({
    output,
    applications,
    architectures: ['x64'],
    minimumZipBytes: 1,
  })
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].arch, 'x64')
  assert.equal(path.basename(artifacts[0].path), `SidekickAI-Portable-${build.VERSION}-x64-win.zip`)
  const names = new AdmZip(artifacts[0].path)
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName)
  assert.ok(names.includes('SidekickAI/SidekickAI.exe'))
})

test('portable paths reject configuration secrets, maintenance tools and runtime user data', () => {
  for (const name of [
    'resources/oxy-deployment.json',
    'oxy-service.json',
    'data/chat.db',
    'maintenance/uninstall.exe',
    'recover.exe',
    'backup-runtime.zip',
    'distribution-proof.json',
    'install-receipt.json',
    '.env.local',
  ]) {
    assert.throws(() => portable.validatePortablePath(name), /non-distributable|user data/)
  }
  // 绿色包只保留契约文件：卸载器三元组不再随包分发
  for (const name of [
    'uninstall.exe',
    'SidekickAI/uninstall.exe',
    'SidekickAI/uninstall-manifest.json',
  ])
    assert.throws(() => portable.validatePortablePath(name), /non-distributable/)
  assert.equal(
    portable.validatePortablePath('SidekickAI/maintenance/portable.json'),
    'SidekickAI/maintenance/portable.json',
  )
  for (const name of ['resources/uninstall.exe', 'maintenance/uninstall.exe'])
    assert.throws(() => portable.validatePortablePath(name), /non-distributable/)
  assert.equal(
    portable.validatePortablePath('resources/oxy-service.json'),
    'resources/oxy-service.json',
  )
})

test('green archive drops the maintenance runtime and carries the uninstall contract', async (t) => {
  const root = fixture(t)
  const applications = path.join(root, 'applications')
  const source = await createRuntime(applications, 'x64')
  const plain = path.join(root, 'green-plain')
  await portable.packPortable({
    output: plain,
    applications,
    architectures: ['x64'],
    minimumZipBytes: 1,
  })
  const baseline = JSON.parse(
    new AdmZip(path.join(plain, `SidekickAI-Portable-${build.VERSION}-x64-win.zip`))
      .readFile('SidekickAI/portable-manifest.json')
      .toString(),
  ).files
  const hostBackup = path.join(source, 'resources', 'host-backup')
  fs.mkdirSync(hostBackup, { recursive: true })
  for (const [name, bytes] of Object.entries({
    'backup-component.cjs': Buffer.from('fixture backup component'),
    'LICENSE.application.txt': Buffer.from('application license'),
    'THIRD-PARTY-NOTICES.txt': Buffer.from('notices'),
    'component.json': Buffer.from('{}'),
  }))
    fs.writeFileSync(path.join(hostBackup, name), bytes)
  const output = path.join(root, 'green')
  await portable.packPortable({
    output,
    applications,
    architectures: ['x64'],
    minimumZipBytes: 1,
  })
  const zip = new AdmZip(path.join(output, `SidekickAI-Portable-${build.VERSION}-x64-win.zip`))
  const names = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory)
    .map((entry) => entry.entryName)
  const files = JSON.parse(zip.readFile('SidekickAI/portable-manifest.json').toString()).files
  assert.ok(!names.some((name) => name.startsWith('SidekickAI/resources/host-backup/')))
  assert.ok(names.includes('SidekickAI/maintenance/portable.json'))
  assert.ok(names.includes('SidekickAI/portable.txt'))
  // 源目录多出 4 个维护期组件文件，包内不计入；包内新增标记与契约清单两个文件
  assert.equal(files.length, u.listFiles(source, new Set()).length - 4 + 2)
  assert.equal(files.length, baseline.length)
})

test('Windows architectures reject duplicates and unsupported values', () => {
  for (const values of [[], ['x64', 'x64'], ['ia32'], 'arm64'])
    assert.throws(() => build.validateArchitectures(values), /architectures/)
  assert.deepEqual(build.validateArchitectures(['arm64']), ['arm64'])
})
