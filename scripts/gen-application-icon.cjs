// Generate the application ICO from the approved PNG artwork.

const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ICON_PNG = path.join(ROOT, 'resources', 'icons', 'icon.png')
const ICO_OUT = path.join(ROOT, 'resources', 'icons', 'icon.ico')

/**
 * ICO entries use PNG at 256px and BGRA bitmaps for smaller sizes.
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
      const src = img.getBitmap() // Premultiplied BGRA in top-down order.
      const xorStride = w * 4
      const andStride = Math.ceil(w / 8 / 4) * 4
      const bmp = Buffer.alloc(40 + xorStride * h + andStride * h)
      bmp.writeUInt32LE(40, 0)
      bmp.writeInt32LE(w, 4)
      bmp.writeInt32LE(h * 2, 8)
      bmp.writeUInt16LE(1, 12)
      bmp.writeUInt16LE(32, 14)
      bmp.writeUInt32LE(0, 16) // BI_RGB with 32-bit alpha.
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
    console.log('[gen-icon] Application icon generated.')
    app.exit(0)
  } catch (err) {
    console.error('[gen-icon] Generation failed:', err)
    app.exit(1)
  }
})
