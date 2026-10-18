const MINIMUM = [22, 12, 0]

function assertNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  const parts = match?.slice(1).map(Number)
  const supported = parts && (parts[0] > 22 || parts[0] === 22 && parts[1] >= 12)
  if (!supported) throw new Error(`Node.js >=${MINIMUM.join('.')} is required; received ${version}. Use the documented Node 24 development runtime.`)
}

module.exports = { assertNodeVersion }
if (require.main === module) {
  try { assertNodeVersion(); console.log(`Node.js ${process.versions.node} is supported`) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
