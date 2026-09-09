// scripts/gen-installer-assets.cjs
// 以 resources/icons/icon.png 为源重建多尺寸 resources/icons/icon.ico（electron 运行时）。
// （原 NSIS 品牌位图生成已随旧安装器移除，Tauri 安装器 UI 为 React 自绘，不需要 bmp。）
//
// 运行方式：npm run gen:installer-assets

const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ICON_PNG = path.join(ROOT, 'resources', 'icons', 'icon.png')
const ICO_OUT = path.join(ROOT, 'resources', 'icons', 'icon.ico')

/**
 * 以 icon.png 为源重建多尺寸 icon.ico。
 * ICO 结构：ICONDIR(6) + ICONDIRENTRY[N](16) + 图像数据。
 * 256px 帧用 PNG 压缩；16-48px 用 32bpp BMP（BITMAPINFOHEADER，高度含 AND 掩码翻倍）。
 */
function genIco() {
  const sizes = [16, 24, 32, 48, 256]
  const entries = []
  for (const size of sizes) {
    if (size >= 256) {
      const png = nativeImage.createFromPath(ICON_PNG).resize({ width: 256, height: 256, quality: 'best' }).toPNG()
      entries.push({ size, data: png, isPng: true })
    } else {
      const img = nativeImage.createFromPath(ICON_PNG).resize({ width: size, height: size, quality: 'best' })
      const w = size
      const h = size
      const src = img.getBitmap() // BGRA 预乘，自上而下
      const xorStride = w * 4
      const andStride = Math.ceil(w / 8 / 4) * 4
      const bmp = Buffer.alloc(40 + xorStride * h + andStride * h)
      bmp.writeUInt32LE(40, 0)
      bmp.writeInt32LE(w, 4)
      bmp.writeInt32LE(h * 2, 8)
      bmp.writeUInt16LE(1, 12)
      bmp.writeUInt16LE(32, 14)
      bmp.writeUInt32LE(0, 16) // BI_RGB（32bpp，alpha 生效）
      bmp.writeUInt32LE(xorStride * h + andStride * h, 20)
      for (let y = 0; y < h; y++) {
        const srcY = h - 1 - y
        src.copy(bmp, 40 + y * xorStride, srcY * xorStride, srcY * xorStride + xorStride)
      }
      entries.push({ size, data: bmp, isPng: false })
    }
  }

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.data.length
  })

  fs.writeFileSync(ICO_OUT, Buffer.concat([header, dir, ...entries.map((e) => e.data)]))
  return 6 + 16 * entries.length + entries.reduce((n, e) => n + e.data.length, 0)
}

app.whenReady().then(() => {
  try {
    console.log(`[gen-icon] icon.ico  ${genIco()} bytes (16/24/32/48/256)`)
    console.log('[gen-icon] 完成。替换正式设计稿时直接覆盖 icon.png 后重跑本脚本即可。')
    app.exit(0)
  } catch (err) {
    console.error('[gen-icon] 失败:', err)
    app.exit(1)
  }
})
