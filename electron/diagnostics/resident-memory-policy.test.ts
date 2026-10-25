import { describe, expect, it } from 'vitest'
import { createResidentMemoryPolicy, type ResidentSample } from './resident-memory-policy.js'

const MiB = 1024 * 1024
const sample = (now = 30000): ResidentSample => ({
  now,
  totalPhysicalBytes: 8 * 1024 * MiB,
  availablePhysicalBytes: 4 * 1024 * MiB,
  lastActivityAt: 0,
  protected: false,
  processes: [
    {
      pid: 2,
      creationTime: 1000,
      type: 'Tab',
      workingSetBytes: 200 * MiB,
      privateBytes: 300 * MiB,
      cpuPercent: 0,
    },
  ],
})
const result = { beforeBytes: 200 * MiB, afterBytes: 60 * MiB, durationMs: 17 }

describe('resident memory policy', () => {
  it('uses proven background renderer idle without exempting it from CPU or task protection', () => {
    const background = {
      ...sample(),
      lastActivityAt: 29000,
      processes: [{ ...sample().processes[0], lastActivityAt: 0 }],
    }
    expect(createResidentMemoryPolicy().select(background)).not.toBeNull()
    expect(createResidentMemoryPolicy().select({ ...background, protected: true })).toBeNull()
    expect(
      createResidentMemoryPolicy().select({
        ...background,
        processes: [{ ...background.processes[0], lastActivityAt: 29000 }],
      }),
    ).toBeNull()
    expect(
      createResidentMemoryPolicy().select({
        ...background,
        processes: [{ ...background.processes[0], cpuPercent: 2 }],
      }),
    ).toBeNull()
  })
  it('protects busy work, recent application input and CPU activity', () => {
    const policy = createResidentMemoryPolicy()
    expect(policy.select({ ...sample(), protected: true })).toBeNull()
    expect(policy.select({ ...sample(), lastActivityAt: 20000 })).toBeNull()
    expect(
      policy.select({ ...sample(), processes: [{ ...sample().processes[0], cpuPercent: 1.01 }] }),
    ).toBeNull()
  })

  it('permits quiet housekeeping below one percent of a core only after application idle', () => {
    const quiet = { ...sample(), processes: [{ ...sample().processes[0], cpuPercent: 0.75 }] }
    expect(createResidentMemoryPolicy().select(quiet)).not.toBeNull()
    expect(createResidentMemoryPolicy().select({ ...quiet, lastActivityAt: 20000 })).toBeNull()
    expect(createResidentMemoryPolicy().select({ ...quiet, protected: true })).toBeNull()
  })

  it('retries successful native calls above 10ms after a bounded cooldown', () => {
    const policy = createResidentMemoryPolicy()
    const candidate = policy.select(sample())!
    policy.recordResult(candidate, result, 30000)
    expect(policy.select(sample(89000))).toBeNull()
    expect(policy.select(sample(90000))).not.toBeNull()
    const reused = sample(95000)
    reused.processes[0].creationTime = 2000
    expect(policy.select(reused)).not.toBeNull()
  })

  it('backs off very slow calls without permanently disabling their PID', () => {
    const policy = createResidentMemoryPolicy()
    policy.recordResult(policy.select(sample())!, { ...result, durationMs: 250 }, 30000)
    expect(policy.select(sample(149000))).toBeNull()
    expect(policy.select(sample(150000))).not.toBeNull()
  })

  it('counts a rapid rebound once per reclaim and eventually retries', () => {
    const policy = createResidentMemoryPolicy()
    policy.recordResult(policy.select(sample())!, result, 30000)
    for (const time of [40000, 45000, 50000, 149000]) expect(policy.select(sample(time))).toBeNull()
    expect(policy.select(sample(150000))).not.toBeNull()
  })

  it('never permanently disables a process after repeated rebounds', () => {
    const policy = createResidentMemoryPolicy()
    let now = 30000
    for (let attempt = 0; attempt < 6; attempt++) {
      const candidate = policy.select(sample(now))!
      expect(candidate).not.toBeNull()
      policy.recordResult(candidate, result, now)
      expect(policy.select(sample(now + 10000))).toBeNull()
      now += 15 * 60000
    }
    expect(policy.select(sample(now))).not.toBeNull()
  })

  it('spaces out repeat successes when the application is already small', () => {
    const policy = createResidentMemoryPolicy()
    policy.recordResult(policy.select(sample())!, result, 30000)
    const next = policy.select(sample(90000))!
    policy.recordResult(next, result, 90000)
    expect(policy.select(sample(209000))).toBeNull()
    expect(policy.select(sample(210000))).not.toBeNull()
  })

  it('does not increase successful spacing while the whole application remains large', () => {
    const policy = createResidentMemoryPolicy()
    const large = (now: number) => ({
      ...sample(now),
      processes: [{ ...sample().processes[0], workingSetBytes: 400 * MiB }],
    })
    for (const now of [30000, 90000, 150000]) {
      const candidate = policy.select(large(now))!
      expect(candidate).not.toBeNull()
      policy.recordResult(candidate, { ...result, beforeBytes: 400 * MiB }, now)
    }
  })

  it('reserves skipped attempts briefly and backs off ineffective native results', () => {
    const policy = createResidentMemoryPolicy()
    expect(policy.select(sample())).not.toBeNull()
    expect(policy.select(sample(35000))).toBeNull()
    const next = policy.select(sample(60000))!
    expect(next).not.toBeNull()
    policy.recordResult(next, { ...result, afterBytes: 198 * MiB }, 60000)
    expect(policy.select(sample(900000))).toBeNull()
    expect(policy.select(sample(960000))).not.toBeNull()
  })

  it('uses the multi-window allowance when increasing successful spacing', () => {
    const policy = createResidentMemoryPolicy()
    const multi = (now: number) => ({
      ...sample(now),
      workingSetBudgetBytes: 4 * 1024 * MiB,
      processes: [{ ...sample().processes[0], workingSetBytes: 400 * MiB }],
    })
    const cleared = { ...result, beforeBytes: 400 * MiB }
    policy.recordResult(policy.select(multi(30000))!, cleared, 30000)
    policy.recordResult(policy.select(multi(90000))!, cleared, 90000)
    expect(policy.select(multi(150000))).toBeNull()
    expect(policy.select(multi(210000))).not.toBeNull()
  })

  it('includes small utility processes and ignores invalid metrics', () => {
    const policy = createResidentMemoryPolicy()
    expect(policy.select({ ...sample(), totalPhysicalBytes: NaN })).toBeNull()
    expect(policy.select({ ...sample(), availablePhysicalBytes: -1 })).toBeNull()
    expect(
      policy.select({
        ...sample(),
        processes: [{ ...sample().processes[0], workingSetBytes: 40 * MiB }],
      }),
    ).not.toBeNull()
  })

  it('permits later idle reclaim on roomy machines', () => {
    const policy = createResidentMemoryPolicy()
    const roomy = {
      ...sample(),
      totalPhysicalBytes: 24 * 1024 * MiB,
      availablePhysicalBytes: 12 * 1024 * MiB,
    }
    expect(policy.select(roomy)).toMatchObject({ reason: 'startup' })
    expect(
      policy.select({
        ...roomy,
        now: 200000,
        processes: [{ ...roomy.processes[0], creationTime: 2000 }],
      }),
    ).toMatchObject({ reason: 'idle' })
  })
})
