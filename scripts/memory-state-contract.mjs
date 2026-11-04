export const MiB = 1024 * 1024
export const STATES = Object.freeze({
  minimum: { limitBytes: 70 * MiB, exclusive: true, windows: 0, browserWindows: 0, guests: 0 },
  standard: { limitBytes: 300 * MiB, exclusive: true, windows: 1, browserWindows: 0 },
  shells: { limitBytes: 1024 * MiB, windows: 10, browserWindows: 0, guests: 0 },
  browsers: { limitBytes: 5 * 1024 * MiB, windows: 11, browserWindows: 10, browserGuests: 10 },
})

export function selectProcessTree(rows, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Invalid root PID')
  const byPid = new Map(rows.map(row => [Number(row.ProcessId), row]))
  if (!byPid.has(rootPid)) throw new Error('Target root process is missing')
  const selected = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      const pid = Number(row.ProcessId)
      const parentPid = Number(row.ParentProcessId)
      const parent = byPid.get(parentPid)
      // Windows can reuse the PID of an exited parent.
      const predatesParent = row.CreatedAt && parent?.CreatedAt
        && Date.parse(row.CreatedAt) < Date.parse(parent.CreatedAt)
      if (!selected.has(pid) && selected.has(parentPid) && !predatesParent) {
        selected.add(pid)
        changed = true
      }
    }
  }
  return [...selected].map(pid => {
    const row = byPid.get(pid)
    const bytes = Number(row.WorkingSetSize)
    if (!Number.isFinite(bytes) || bytes < 0 || row.WorkingSetSize == null) {
      throw new Error('Missing working set for PID ' + pid)
    }
    return { pid, parentPid: Number(row.ParentProcessId), bytes, name: row.Name }
  })
}

export function assessState(state, samples, checks = []) {
  const contract = STATES[state]
  if (!contract) throw new Error('Unknown memory state: ' + state)
  if (!samples.length) throw new Error('No samples collected')
  const failures = [...checks]
  for (const sample of samples) {
    if (!sample.processes?.length || !Number.isFinite(sample.totalBytes) || sample.totalBytes < 0) {
      failures.push('Invalid process measurement')
      continue
    }
    const inventory = sample.inventory
    if (!inventory) { failures.push('Missing application inventory'); continue }
    if (inventory.windows !== contract.windows) failures.push('Wrong number of application windows')
    if (inventory.browserWindows !== contract.browserWindows) failures.push('Wrong number of browser windows')
    if (contract.guests !== undefined && inventory.guests !== contract.guests) failures.push('Wrong number of live webpages')
    if (contract.browserGuests !== undefined && inventory.browserGuests !== contract.browserGuests) failures.push('Wrong number of live browser webpages')
    if (state === 'browsers' && inventory.readyBrowserWindows !== 10) failures.push('Not all ten browser windows are ready')
    if (state === 'minimum' && inventory.renderers !== 0) failures.push('Full application renderer remains resident')
    if (contract.limitBytes !== null && (contract.exclusive
      ? sample.totalBytes >= contract.limitBytes : sample.totalBytes > contract.limitBytes)) failures.push('Memory limit exceeded')
  }
  const totals = samples.map(sample => sample.totalBytes).sort((a, b) => a - b)
  return {
    state, status: failures.length ? 'FAIL' : 'PASS',
    failures: [...new Set(failures)], sampleCount: samples.length,
    peakBytes: totals.at(-1), medianBytes: totals[Math.floor(totals.length / 2)],
    limitBytes: contract.limitBytes,
  }
}
