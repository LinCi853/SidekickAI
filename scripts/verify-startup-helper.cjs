'use strict'

const path = require('node:path')

module.exports = async (context) => {
  if (context.electronPlatformName === 'win32') {
    require('./build-startup-helper.cjs').verifyResources(
      path.join(context.appOutDir, 'resources/windows'),
      { root: path.resolve(__dirname, '..') },
    )
    await require('./build-host-backup.cjs').afterPack(context)
  }
}
