// electron/presets/devices.ts — 设备预设字典
//
// 内置 5 个常见设备配置，每个预设包含 UA + viewport + DPR + Client Hints 一致性配置。
// 用户创建 Profile 时引用预设 id，避免手动填写易错的 UA 字符串。

import type { DevicePreset } from '../shared/types.js'

/** iPhone 15 Pro / Safari 移动端 UA（单一数据源，供 devices.ts 预设与 ai-platforms.ts 共用） */
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

/** iPhone 15 Pro 视口尺寸（单一数据源） */
export const IPHONE_VIEWPORT = { width: 390, height: 844 }

/** Windows / Chrome 125 桌面端 UA（单一数据源） */
export const WIN_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

export const PRESETS: DevicePreset[] = [
  {
    id: 'win-chrome-125',
    name: 'Windows / Chrome 125',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    platform: 'desktop',
    viewport: { width: 1920, height: 1080 },
    devicePixelRatio: 1,
    navigatorPlatform: 'Win32',
    vendor: 'Google Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Windows',
    chPlatformVersion: '10.0.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
  {
    id: 'mac-safari-17',
    name: 'macOS / Safari 17',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    platform: 'desktop',
    viewport: { width: 1680, height: 1050 },
    devicePixelRatio: 2,
    navigatorPlatform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 0,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'macOS',
    chPlatformVersion: '14.5.0',
    chMobile: false,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
  {
    id: 'iphone-15-pro-safari',
    name: 'iPhone 15 Pro / Safari',
    userAgent: IPHONE_UA,
    platform: 'mobile',
    viewport: IPHONE_VIEWPORT,
    devicePixelRatio: 3,
    navigatorPlatform: 'iPhone',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 6,
    deviceMemory: 4,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
  {
    id: 'ipad-pro-safari',
    name: 'iPad Pro / Safari',
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    platform: 'mobile',
    viewport: { width: 1024, height: 1366 },
    devicePixelRatio: 2,
    navigatorPlatform: 'iPad',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    brands: [],
    chPlatform: 'iOS',
    chPlatformVersion: '17.5.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
  {
    id: 'pixel-8-chrome',
    name: 'Pixel 8 Pro / Chrome',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    platform: 'mobile',
    viewport: { width: 412, height: 892 },
    devicePixelRatio: 3.5,
    navigatorPlatform: 'Linux armv8l',
    vendor: 'Google Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 12,
    brands: [
      { brand: 'Google Chrome', version: '125' },
      { brand: 'Chromium', version: '125' },
      { brand: 'Not.A/Brand', version: '24' },
    ],
    chPlatform: 'Android',
    chPlatformVersion: '14.0.0',
    chMobile: true,
    language: 'zh-CN',
    timezone: 'Asia/Shanghai',
  },
]


