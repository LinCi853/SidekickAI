'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { listFiles } = require('./uninstaller-build-utils.cjs')

function toolInputs(root, names) {
  const visited = new Set()
  const visit = (name, from) => {
    let directory
    for (let current = from; ; current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', name, 'package.json')
      if (fs.existsSync(candidate)) { directory = path.dirname(candidate); break }
      if (path.dirname(current) === current) return
    }
    if (visited.has(directory)) return
    visited.add(directory)
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dependency, directory)
  }
  for (const name of names) visit(name, root)
  return [...new Set([...visited].flatMap(directory => listFiles(directory, new Set(['node_modules', '.git']))))].sort()
}

module.exports = { toolInputs }
