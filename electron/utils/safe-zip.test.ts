// electron/utils/safe-zip.test.ts — 安全解压的防护单测
//
// 覆盖 zip-slip（路径穿越）、绝对路径、盘符、控制字符、符号链接条目与规模上限。

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import pathMod from 'path'
import AdmZip from 'adm-zip'
import { isSafeEntryName, resolveSafeTarget, safeExtractAll } from './safe-zip.js'

describe('isSafeEntryName', () => {
  it('接受普通相对路径', () => {
    expect(isSafeEntryName('settings.db')).toBe(true)
    expect(isSafeEntryName('a/b/c.txt')).toBe(true)
    expect(isSafeEntryName('win\\path\\file.txt')).toBe(true)
  })

  it('拒绝路径穿越', () => {
    expect(isSafeEntryName('../evil.txt')).toBe(false)
    expect(isSafeEntryName('a/../../evil.txt')).toBe(false)
    expect(isSafeEntryName('..\\evil.txt')).toBe(false)
  })

  it('拒绝绝对路径与盘符', () => {
    expect(isSafeEntryName('/etc/passwd')).toBe(false)
    expect(isSafeEntryName('C:/Windows/win.ini')).toBe(false)
    expect(isSafeEntryName('\\\\server\\share\\x')).toBe(false)
  })

  it('拒绝空值与控制字符', () => {
    expect(isSafeEntryName('')).toBe(false)
    expect(isSafeEntryName('a\u0000b')).toBe(false)
    expect(isSafeEntryName('a\u0007b')).toBe(false)
  })
})

describe('resolveSafeTarget', () => {
  const dest = 'C:\\tmp\\sidekick-restore'

  it('把相对路径解析到 destDir 之内', () => {
    const r = resolveSafeTarget(dest, 'sub/file.txt')
    expect(r).toBe(`${dest}\\sub\\file.txt`)
  })

  it('flatten 模式只取文件名', () => {
    const r = resolveSafeTarget(dest, 'whisper-bin-x64/main.exe', true)
    expect(r).toBe(`${dest}\\main.exe`)
  })

  it('对不安全的条目名返回 null', () => {
    expect(resolveSafeTarget(dest, '..')).toBeNull()
    expect(resolveSafeTarget(dest, '../x')).toBeNull()
  })
})

describe('safeExtractAll', () => {
  /** 构造一个可控条目的假 zip，用于模拟攻击者构造的恶意 zip */
  function fakeZip(entries: Array<Record<string, unknown>>) {
    const extracted: string[] = []
    return {
      extracted,
      zip: {
        getEntries: () => entries,
        extractEntryTo: (e: { entryName: string }) => {
          extracted.push(e.entryName)
        },
      } as unknown as AdmZip,
    }
  }

  const entry = (entryName: string, extra: Record<string, unknown> = {}) => ({
    entryName,
    isDirectory: false,
    header: { size: 8, attr: 0 },
    ...extra,
  })

  it('只解压安全条目，跳过路径穿越 / 绝对路径 / 盘符 / 控制字符', () => {
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'safe-zip-'))
    const dest = pathMod.join(tmp, 'out')

    const { extracted, zip } = fakeZip([
      entry('good.txt'),
      entry('sub/nested.txt'),
      entry('../evil.txt'),
      entry('/etc/passwd'),
      entry('C:/Windows/win.ini'),
      entry('bad\u0007name.txt'),
    ])

    const written = safeExtractAll(zip, dest)

    expect(extracted).toEqual(['good.txt', 'sub/nested.txt'])
    expect(written).toBe(2)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('跳过 zip 内携带的符号链接条目（S_IFLNK）', () => {
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'safe-zip-'))
    const dest = pathMod.join(tmp, 'out')

    const { extracted, zip } = fakeZip([
      entry('real.txt'),
      // (attr >>> 16) & 0xF000 === 0xA000 → 符号链接
      entry('link.txt', { header: { size: 0, attr: 0xa000 << 16 } }),
    ])

    safeExtractAll(zip, dest)
    expect(extracted).toEqual(['real.txt'])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('跳过超过单条体积上限的条目', () => {
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'safe-zip-'))
    const dest = pathMod.join(tmp, 'out')

    const { extracted, zip } = fakeZip([
      entry('normal.txt'),
      entry('huge.bin', { header: { size: 600 * 1024 * 1024, attr: 0 } }),
    ])

    safeExtractAll(zip, dest)
    expect(extracted).toEqual(['normal.txt'])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('真实 zip 可正常解压（回归：安全策略不误伤正常流程）', () => {
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'safe-zip-'))
    const dest = pathMod.join(tmp, 'out')

    const zip = new AdmZip()
    zip.addFile('settings.db', Buffer.from('db-content'))
    zip.addFile('manifest.json', Buffer.from('{}'))

    const written = safeExtractAll(zip, dest)

    expect(written).toBe(2)
    expect(fs.readFileSync(pathMod.join(dest, 'settings.db'), 'utf-8')).toBe('db-content')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('空 zip 返回 0', () => {
    const zip = new AdmZip()
    expect(safeExtractAll(zip, 'C:\\tmp\\does-not-matter')).toBe(0)
  })
})
