// electron/store/low-memory-mode.ts — 低内存开关的内存快照（无依赖）
//
// 窗口退役与后台释放的定时器每秒都要读这个开关。若直接从 app-settings-store 读取，
// 每次调用都会 structuredClone 一份全量设置，而且会让 window-factory / diagnostics
// 与设置存储互相依赖（architecture:check 会判为循环依赖）。
//
// 本模块刻意不导入任何运行时模块，只保存一个布尔值；由 app-settings-repository
// 在读、写设置时同步，因此开关切换后一秒内即对新设的截止期生效。

let lowMemoryMode = false

/** 由设置存储同步；非 true 一律视为关闭 */
export function setLowMemoryMode(enabled: unknown): void {
  lowMemoryMode = enabled === true
}

/** 当前是否开启低内存模式 */
export function isLowMemoryMode(): boolean {
  return lowMemoryMode
}

/** 测试辅助：恢复默认（关闭） */
export function resetLowMemoryModeForTest(): void {
  lowMemoryMode = false
}
