// electron/store/device-id.ts — 设备唯一码生成与持久化
//
// 首次启动生成随机 UUID 存入 settings.db，后续调用直接读取。
// 用于备份加密盐值和关于页面展示。
//
// 注意：JsonStore 会捕获当时的 settings.db 连接。导出流程会 closeModuleStateDb()，
// 因此 getDeviceId() 必须在关闭连接之前调用并缓存（见 backup-restore.exportAllData）。

import { createSqliteJsonStore } from './module-state-store.js'

interface DeviceIdStore {
  deviceId: string
}

let store: ReturnType<typeof createSqliteJsonStore<DeviceIdStore>> | null = null
let cachedId: string | null = null

function getStore() {
  if (!store) {
    store = createSqliteJsonStore<DeviceIdStore>({
      tableName: 'device_id',
      defaults: { deviceId: '' },
    })
  }
  return store
}

/** 获取设备唯一码（首次自动生成 UUID） */
export function getDeviceId(): string {
  if (cachedId) return cachedId
  let id = getStore().get('deviceId')
  if (!id) {
    id = crypto.randomUUID()
    getStore().set('deviceId', id)
  }
  cachedId = id
  return id
}

/** 获取设备唯一码短格式（前 8 位，UI 展示用） */
export function getDeviceIdShort(): string {
  return getDeviceId().slice(0, 8)
}