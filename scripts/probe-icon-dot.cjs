// scripts/probe-icon-electron-dot.cjs — run as: electron . with this as extra? 
// Instead: emulate electron-vite entry='.' by requiring package main? 
// Simpler: call app.getAppPath when launched as electron <this file> from repo root
const { app, nativeImage, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
app.whenReady().then(() => {
  const file = path.join(app.getAppPath(), 'resources', 'icons', 'icon.ico')
  const png = path.join(app.getAppPath(), 'resources', 'icons', 'icon.png')
  const imgIco = fs.existsSync(file) ? nativeImage.createFromPath(file) : null
  const imgPng = fs.existsSync(png) ? nativeImage.createFromPath(png) : null
  console.log('PROBE', JSON.stringify({
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    argv1: process.argv[1],
    ico: { exists: fs.existsSync(file), empty: imgIco && imgIco.isEmpty(), size: imgIco && imgIco.getSize() },
    png: { exists: fs.existsSync(png), empty: imgPng && imgPng.isEmpty(), size: imgPng && imgPng.getSize() },
    pngRep: imgPng && imgPng.getSize(),
  }))
  // create a frameless window like the product and see if icon applies
  const win = new BrowserWindow({
    width: 400, height: 300, frame: false, show: true,
    thickFrame: false, roundedCorners: false,
    icon: imgIco && !imgIco.isEmpty() ? imgIco : undefined,
    title: 'IconProbe'
  })
  if (imgIco && !imgIco.isEmpty()) win.setIcon(imgIco)
  else if (imgPng && !imgPng.isEmpty()) win.setIcon(imgPng)
  console.log('ICON_SET done')
  setTimeout(() => { win.close(); app.exit(0) }, 3000)
})
