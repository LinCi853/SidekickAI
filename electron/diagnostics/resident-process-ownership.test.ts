import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ contents: vi.fn(), owner: vi.fn() }))
vi.mock('electron', () => ({
  webContents: { getAllWebContents: fixture.contents },
  BrowserWindow: { fromWebContents: fixture.owner },
}))
import { backgroundWindowForProcess } from './resident-process-ownership'
const window = (focused = false) => ({ isDestroyed: () => false, isFocused: () => focused })
const contents = (owner: unknown, hostWebContents: unknown = null) => ({
  owner,
  hostWebContents,
  isDestroyed: () => false,
  getOSProcessId: () => 7,
})
beforeEach(() => {
  fixture.contents.mockReturnValue([])
  fixture.owner.mockImplementation((contents) => contents.owner)
})

it('allows a shell and its guest only when their whole renderer belongs to one background window', () => {
  const owner = window(),
    host = contents(owner),
    guest = contents(null, host)
  fixture.contents.mockReturnValue([host, guest])
  expect(backgroundWindowForProcess(7)).toBe(owner)
})
it('rejects foreground, shared, destroyed and unknown window ownership', () => {
  for (const values of [
    [contents(window(true))],
    [contents(window()), contents(window())],
    [contents({ ...window(), isDestroyed: () => true })],
    [contents(null)],
    [],
  ]) {
    fixture.contents.mockReturnValue(values)
    expect(backgroundWindowForProcess(7)).toBeNull()
  }
})
it('fails closed when renderer identity cannot be read', () => {
  fixture.contents.mockReturnValue([
    {
      ...contents(window()),
      getOSProcessId: () => {
        throw Error('renderer exited')
      },
    },
  ])
  expect(backgroundWindowForProcess(7)).toBeNull()
})
