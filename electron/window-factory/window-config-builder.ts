// electron/window-factory/window-config-builder.ts — 跨平台 BrowserWindow 配置构建器
//
// 统一处理 Windows DWM 专属字段、macOS 交通灯/毛玻璃、Linux 透明窗限制、
// hasShadow 平台差异。所有 createXxxWindow 函数应通过 buildWindowConfig(config)
// 生成最终构造参数，避免平台分支散落在各窗口文件中。
//
// 设计要点：
//   - Windows 专属字段（thickFrame / roundedCorners / backgroundMaterial）仅 win32 应用，
//     非 Windows 平台显式删除，避免无效配置干扰。
//   - macOS 采用 titleBarStyle:'hiddenInset' + frame:true 保留交通灯（spec 验证标准 #1）。
//     frame:false 在 macOS 会移除交通灯，故此处覆盖 base.frame。
//   - Linux 关闭 transparent（Wayland 黑屏），交由调用方用 backgroundColor 兜底。
//   - hasShadow：macOS true（立体感），Windows true（系统圆角阴影），Linux false。
//
// 注意：录音指示器等无交通灯的特殊悬浮窗不应使用本构建器，需在调用处内联处理
// （见 main.ts createRecordIndicatorWindow）。

import { app, type BrowserWindowConstructorOptions } from 'electron'
import path from 'node:path'

/**
 * 判断当前平台是否为 macOS
 */
export function isMacOS(): boolean {
  return process.platform === 'darwin'
}

/**
 * 判断当前平台是否为 Linux
 */
export function isLinux(): boolean {
  return process.platform === 'linux'
}

/**
 * 构建跨平台 BrowserWindow 配置。
 *
 * 在 base 配置之上叠加平台专属字段，并清理非当前平台的无效字段。
 * 调用方传入的 base 配置无需关心平台差异，仅需提供业务相关参数
 * （尺寸、alwaysOnTop、webPreferences 等）。
 *
 * @param base 业务侧基础配置（可包含 frame/hasShadow 等，将被平台规则覆盖）
 * @returns 可直接传给 new BrowserWindow(...) 的最终配置
 */
export function buildWindowConfig(
  base: BrowserWindowConstructorOptions,
): BrowserWindowConstructorOptions {
  const platform = process.platform
  const mac = isMacOS()
  const linux = isLinux()

  const result: BrowserWindowConstructorOptions = { ...base }
  result.icon ??= path.join(app.getAppPath(), 'resources', 'icons', platform === 'win32' ? 'icon.ico' : 'icon.png')

  // Windows 专属字段仅 Windows 应用；其它平台显式移除避免无效字段
  // roundedCorners:false 取消系统级圆角（用户决策：窗口圆角怎么调整都不合适，统一取消）
  // thickFrame:false 保留无边框外观
  // 注意：若调用方已设置 transparent:true，则不再设置 backgroundMaterial，
  //       避免透明窗口的 CSS 圆角被背景材质覆盖。
  if (platform === 'win32') {
    result.thickFrame = false
    result.roundedCorners = false
    if (!base.transparent) {
      result.backgroundMaterial = 'none'
    }
  } else {
    delete result.thickFrame
    delete result.roundedCorners
    delete result.backgroundMaterial
  }

  if (mac) {
    // macOS：保留交通灯的隐藏标题栏样式。
    // frame:false 会同时移除交通灯，故此处强制 frame:true 配合 titleBarStyle。
    result.frame = true
    result.titleBarStyle = 'hiddenInset'
    result.trafficLightPosition = { x: 12, y: 12 }
    // 可选毛玻璃；当前渲染层背景不透明故不显效，留作后续启用
    result.vibrancy = 'under-window'
  }

  if (linux) {
    // Linux 无边框（复用 base.frame=false）；Wayland 下 transparent 不稳定
    result.frame = false
    result.transparent = false
  }

  // hasShadow 平台差异：mac/Windows 需要 true（立体感 + 圆角阴影），Linux false
  result.hasShadow = linux ? false : true

  return result
}
