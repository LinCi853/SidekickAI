import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it } from 'vitest'
import { build } from 'vite'
import { compileStandalonePreloads, standalonePreloads } from './standalone-preloads'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})
async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sidekick-preloads-'))
  directories.push(directory)
  return directory
}

it('emits independently executable preloads and records both entries and their shared inputs', async () => {
  const root = await workspace()
  await writeFile(path.join(root, 'shared.ts'), 'export const answer = 42')
  for (const name of ['index', 'webview'])
    await writeFile(
      path.join(root, name + '.ts'),
      "import { ipcRenderer } from 'electron'; import { answer } from './shared'; ipcRenderer.send('" +
        name +
        "', answer)",
    )
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [standalonePreloads(root)],
    build: {
      write: false,
      outDir: path.join(root, 'out'),
      rollupOptions: {
        input: { index: path.join(root, 'index.ts'), webview: path.join(root, 'webview.ts') },
        output: { format: 'cjs' },
      },
    },
  })
  if (Array.isArray(result) || !('output' in result)) throw new Error('Unexpected Vite output')
  expect(result.output.map((file) => file.fileName).sort()).toEqual([
    'compilation-inputs.json',
    'index.cjs',
    'webview.cjs',
  ])
  const proofFile = result.output.find((file) => file.fileName === 'compilation-inputs.json')!
  if (proofFile.type !== 'asset') throw new Error('Missing compilation evidence')
  const proof = JSON.parse(String(proofFile.source))
  expect(proof.modules).toEqual(['index.ts', 'shared.ts', 'webview.ts'])
  expect(proof.outputs).toEqual([
    { file: 'index.cjs', sources: ['index.ts', 'shared.ts'] },
    { file: 'webview.cjs', sources: ['shared.ts', 'webview.ts'] },
  ])
  for (const name of ['index', 'webview']) {
    const file = result.output.find((file) => file.fileName === name + '.cjs')!
    if (file.type !== 'asset') throw new Error('Preload is not standalone')
    const calls: unknown[][] = []
    runInNewContext(
      typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8'),
      {
        require: (id: string) => {
          if (id !== 'electron') throw new Error('Sandbox cannot load ' + id)
          return { ipcRenderer: { send: (...args: unknown[]) => calls.push(args) } }
        },
      },
    )
    expect(calls).toEqual([[name, 42]])
  }
})

it('fails the build if a preload gains a Node module unavailable in the sandbox', async () => {
  const root = await workspace()
  await writeFile(
    path.join(root, 'index.ts'),
    "import fs from 'node:fs'; console.log(fs.readFileSync('secret'))",
  )
  await expect(
    compileStandalonePreloads(root, { index: path.join(root, 'index.ts') }, path.join(root, 'out')),
  ).rejects.toThrow('Sandbox preload has unsupported imports: node:fs')
})
