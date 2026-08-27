// electron/store/import-guard.ts — 数据导入进行中标志
//
// 独立模块，避免 backup-restore.ts 和 main-window.ts 之间循环依赖。
// main-window.ts 的 closed 事件和 main.ts 的 window-all-closed 事件
// 检查此标志来决定是否退出进程。

/** 导入进行中标志（阻止 window-all-closed / closed 退出进程） */
export let isImportingData = false

export function setImportingData(value: boolean): void {
  isImportingData = value
}
