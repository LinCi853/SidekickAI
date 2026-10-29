// electron/store/cache-maintenance.test.ts — 缓存清理的行为约束
//
// 覆盖启动路径上的三个关键点：
//   1. 磁盘兜底清理必须先于 partition session 打开，否则目录被自己锁住；
//   2. 报告的是实际释放的字节数，不是清理前的估算快照；
//   3. 被本进程占用的目录属于预期内情况，不按失败上报，也不逐条打印堆栈。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixture = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  probePath: '',
  profiles: [] as { id: string }[],
  fromPartitionCalls: [] as { partition: string; cacheStillPresent: boolean }[],
}))

vi.mock('electron', async () => {
  const fsModule = await import('node:fs')
  const fakeSession = () => ({
    clearCache: async () => {},
    clearAuthCache: async () => {},
    clearStorageData: async () => {},
  })
  return {
    app: {
      isReady: () => true,
      isPackaged: false,
      getPath: (name: string) => fixture.paths[name],
      getVersion: () => '0.1.7',
    },
    session: {
      defaultSession: fakeSession(),
      fromPartition: (partition: string) => {
        fixture.fromPartitionCalls.push({
          partition,
          cacheStillPresent: fsModule.existsSync(fixture.probePath),
        })
        return fakeSession()
      },
    },
  }
})
vi.mock('../browser/profile-store.js', () => ({
  profileStore: { list: () => fixture.profiles },
}))
vi.mock('../browser/tab-hibernate-store.js', () => ({
  tabHibernationStore: { prune: () => ({ removed: 0, expired: 0, orphans: 0 }) },
}))
vi.mock('./backup-restore.js', () => ({
  formatBytes: (bytes: number) => `${bytes} B`,
}))

import { cleanCacheData } from './cache-maintenance'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-cache-maintenance-'))
  fixture.paths = { userData: path.join(root, 'data'), temp: root }
  fixture.probePath = ''
  fixture.profiles = []
  fixture.fromPartitionCalls = []
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function writeBytes(relativePath: string, bytes: number): string {
  const file = path.join(fixture.paths.userData, relativePath)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(bytes, 1))
  return file
}

describe('cache maintenance', () => {
  it('removes cache directories and reports the bytes actually released', async () => {
    writeBytes('Cache/entry', 100)
    writeBytes('GPUCache/entry', 50)
    writeBytes('Partitions/p1/Cache/entry', 70)
    writeBytes('Partitions/p1/Code Cache/entry', 30)

    const result = await cleanCacheData()

    expect(fs.existsSync(path.join(fixture.paths.userData, 'Cache'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.paths.userData, 'GPUCache'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.paths.userData, 'Partitions/p1/Cache'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.paths.userData, 'Partitions/p1/Code Cache'))).toBe(false)
    // 清理前后体积之差，不是清理前的估算快照。
    expect(result.cleanedBytes).toBe(250)
  })

  it('sweeps partition directories before opening their session', async () => {
    fixture.profiles = [{ id: 'p1' }]
    fixture.probePath = path.join(fixture.paths.userData, 'Partitions/p1/Cache')
    writeBytes('Partitions/p1/Cache/entry', 40)

    await cleanCacheData()

    expect(fixture.fromPartitionCalls).toHaveLength(1)
    expect(fixture.fromPartitionCalls[0].partition).toBe('persist:p1')
    // session 打开时缓存目录已被删除：先删再开，才不会被自己锁住。
    expect(fixture.fromPartitionCalls[0].cacheStillPresent).toBe(false)
  })

  it('treats directories held by the running process as skipped, not failures', async () => {
    writeBytes('Cache/entry', 100)
    writeBytes('GPUCache/entry', 40)
    const heldDir = path.join(fixture.paths.userData, 'Cache')

    const originalRm = fs.promises.rm
    const rmSpy = vi
      .spyOn(fs.promises, 'rm')
      .mockImplementation(async (target: fs.PathLike, options?: fs.RmOptions) => {
        if (String(target) === heldDir) {
          const error = new Error('EPERM: operation not permitted, rm') as NodeJS.ErrnoException
          error.code = 'EPERM'
          throw error
        }
        return originalRm(target, options)
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await cleanCacheData()

    expect(rmSpy).toHaveBeenCalled()
    // 占用中的目录按预期跳过，不算失败，也不打印逐条堆栈。
    expect(warn).not.toHaveBeenCalled()
    // 被占用的 100 字节仍在树上，只有真正删掉的 40 字节计入释放量。
    expect(result.cleanedBytes).toBe(40)
  })
})
