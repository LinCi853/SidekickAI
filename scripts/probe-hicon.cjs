const { app, BrowserWindow, nativeImage } = require('electron')
const { spawnSync } = require('child_process')
const icoPath = 'E:\\SidekickAI\\resources\\icons\\icon.ico'
const img = nativeImage.createFromPath(icoPath)

app.whenReady().then(() => {
  console.log('IMG empty=', img.isEmpty(), 'size=', JSON.stringify(img.getSize()))
  const a = new BrowserWindow({ width: 320, height: 240, frame: false, show: false, thickFrame: false, roundedCorners: false, icon: img })
  a.setIcon(img)
  const b = new BrowserWindow({ width: 320, height: 240, frame: false, show: false, thickFrame: false, roundedCorners: false, icon: icoPath })
  const c = new BrowserWindow({ width: 320, height: 240, frame: true, show: false, icon: img })
  c.setIcon(img)
  a.show(); b.show(); c.show()
  setTimeout(() => {
    const args = []
    for (const [name, win] of [['A', a], ['B', b], ['C', c]]) {
      const buf = win.getNativeWindowHandle()
      const hwnd = buf.readBigUInt64LE ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))
      args.push(name + ':' + hwnd.toString())
    }
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'E:\\SidekickAI\\local\\check-hicon.ps1', ...args], { encoding: 'utf8' })
    console.log(r.stdout)
    console.log(r.stderr)
    app.exit(0)
  }, 800)
})
