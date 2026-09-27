function parsed(value) {
  if (typeof value !== 'string') throw new Error('Invalid resource version.');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.-]+))?$/.exec(value);
  if (!match) throw new Error('Invalid resource version.');
  return { core: match.slice(1, 4).map(BigInt), prerelease: match[4]?.split('.') ?? null };
}

export function compareResourceVersions(left, right) {
  const a = parsed(left); const b = parsed(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease === null) return b.prerelease === null ? 0 : 1;
  if (b.prerelease === null) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const l = a.prerelease[index]; const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l); const rn = /^\d+$/.test(r);
    if (ln && rn) { if (BigInt(l) !== BigInt(r)) return BigInt(l) < BigInt(r) ? -1 : 1; continue; }
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

export function nextResourceVersion(versions) {
  if (!versions.length) return '1.0.0';
  const latest = [...versions].sort((left, right) => compareResourceVersions(right, left))[0];
  const { core, prerelease } = parsed(latest);
  if (prerelease === null) core[2] += 1n;
  const next = core.join('.');
  if (next.length > 32) throw new Error('The next resource version exceeds the supported length.');
  return next;
}
