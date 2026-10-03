import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export function assertAssetClearAllowed(enabled: boolean, busy: boolean): void {
  if (enabled) throw new Error('请先关闭 AI资产组件，再清除数据')
  if (busy) throw new Error('请先结束 API 响应、备份、文件导入和原件传输，再清除数据')
}

/** Moves only owned directories; SQL failure restores the original vault. */
export function clearAssetDirectories(userData: string, clearDatabase: () => void): void {
  const root = path.resolve(userData)
  const staging = path.join(root, '.ai-assets-clearing')
  const marker = path.join(staging, 'state.json')
  const names = ['ai-assets', '.ai-assets-pending']
  const restore = () => {
    for (const name of names) {
      const source = path.join(staging, name)
      const destination = path.join(root, name)
      if (!existsSync(source)) continue
      if (existsSync(destination)) throw new Error('清除中断的原件与当前仓库同时存在，请先备份并检查')
      renameSync(source, destination)
    }
    rmSync(staging, { recursive: true, force: true })
  }
  if (existsSync(staging)) {
    const state = JSON.parse(readFileSync(marker, 'utf8')) as { committed: boolean }
    if (state.committed) rmSync(staging, { recursive: true, force: true })
    else restore()
  }
  mkdirSync(staging)
  writeFileSync(marker, JSON.stringify({ committed: false }))
  let committed = false
  try {
    for (const name of names) {
      const source = path.join(root, name)
      if (existsSync(source)) renameSync(source, path.join(staging, name))
    }
    clearDatabase()
    committed = true
    writeFileSync(marker, JSON.stringify({ committed: true }))
    rmSync(staging, { recursive: true, force: true })
  } catch (error) {
    if (!committed) restore()
    else throw new Error(`记录已清除，原件目录清理未完成，请重试：${String(error)}`)
    throw error
  }
}
