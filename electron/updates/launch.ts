import type { ChildProcess } from 'node:child_process'

export function awaitInstallerAdmission(child: ChildProcess, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error?: Error) => {
      if (timer) clearTimeout(timer)
      child.removeListener('error', fail); child.removeListener('exit', exited); child.removeListener('spawn', spawned)
      child.unref()
      if (error) reject(error); else resolve()
    }
    const fail = (error: Error) => finish(error)
    const exited = (code: number | null, signal: NodeJS.Signals | null) => finish(code === 0 ? undefined : new Error(code === 64
      ? '当前维护向导正在处理另一发行，请完成或关闭后重试。' : `安装入口未接受更新（${signal ?? code}）。`))
    const spawned = () => { timer = setTimeout(() => finish(), timeout) }
    child.once('error', fail); child.once('exit', exited); child.once('spawn', spawned)
  })
}
