'use strict'

module.exports = function versionedPe(arch = 'x64') {
  const { NtExecutable, NtExecutableResource, Resource } = require('resedit')
  const executable = NtExecutable.createEmpty(false, false)
  executable.newHeader.fileHeader.machine = require('../uninstaller-build-utils.cjs').MACHINES[arch]
  const resources = NtExecutableResource.from(executable)
  const version = Resource.VersionInfo.create({ lang: 1033, fixedInfo: {}, strings: [] })
  version.setFileVersion(1, 0, 0, 0, 1033)
  version.setProductVersion(1, 0, 0, 0, 1033)
  version.setStringValue({ lang: 1033, codepage: 1200 }, 'ProductName', 'Maintenance')
  version.outputToResourceEntries(resources.entries)
  resources.outputResource(executable)
  return Buffer.from(executable.generate())
}
