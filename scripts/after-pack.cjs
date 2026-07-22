// scripts/after-pack.cjs
// electron-builder afterPack 钩子：删除 Chromium 自带的 LICENSES.chromium.html
// 该文件 10MB+，用户可在线查阅 https://chromium.googlesource.com/chromium/src/+/main/LICENSE
// 同时删除其他不必要的 Chromium 附属文件以进一步减小体积
const fs = require('fs')
const path = require('path')

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = function afterPack(context) {
  const appOutDir = context.appOutDir
  const targets = [
    'LICENSES.chromium.html',
    'LICENSE.electron.txt',
  ]

  for (const name of targets) {
    const full = path.join(appOutDir, name)
    if (fs.existsSync(full)) {
      try {
        fs.unlinkSync(full)
        console.log(`[after-pack] 已删除 ${name}`)
      } catch (err) {
        console.warn(`[after-pack] 删除 ${name} 失败:`, err.message)
      }
    }
  }
}
