'use strict'

module.exports = context => {
  if (context.electronPlatformName === 'win32') require('./build-startup-helper.cjs').build({ resources: true })
}
