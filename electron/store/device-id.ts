// electron/store/device-id.ts — 设备唯一码生成与持久化
//
// 首次启动生成随机 UUID 存入 settings.db，后续调用直接读取。
// 用于备份加密盐值和关于页面展示。

import { createSqliteJsonStore } from './module-state-store.js'

interface DeviceIdStore {
  deviceId: string
}

const store = createSqliteJsonStore<DeviceIdStore>({
  tableName: 'device_id',
  defaults: { deviceId: '' },
})

let cachedId: string | null = null

/** 获取设备唯一码（首次自动生成 UUID） */
export function getDeviceId(): string {
  if (cachedId) return cachedId
  let id = store.get('deviceId')
  if (!id) {
    id = crypto.randomUUID()
    store.set('deviceId', id)
  }
  cachedId = id
  return id
}

/** 获取设备唯一码短格式（前 8 位，UI 展示用） */
export function getDeviceIdShort(): string {
  return getDeviceId().slice(0, 8)
}
