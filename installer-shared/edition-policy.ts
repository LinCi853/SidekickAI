import { editionId } from '../packages/product-contract/identity'

const policies = {
  community: {
    components: [] as string[],
    options: ['autoUpdate', 'autoLaunch', 'logLevel'],
    updateLabel: '启动时检查更新',
    updateDescription: '启动时检查是否有新版本。安装更新前会再次确认。',
    contentDescription: '安装会尝试获取默认内容；下载失败仍可完成基础安装。白板及其他工具插件请在应用中独立下载或导入。',
  },
  concept: {
    components: [] as string[],
    options: ['autoLaunch', 'logLevel', 'usageTracking'],
    updateLabel: '检查更新',
    updateDescription: '可在应用的关于页面检查更新。',
    contentDescription: '白板和其他内置工具随本体安装，默认内容无需另外下载。',
  },
}

export const installationPolicy = policies[editionId]

export function installationComponents<T extends { id: string; installRequired?: boolean; required?: boolean; defaultEnabled: boolean }>(modules: readonly T[]): T[] {
  return installationPolicy.components.map(id => {
    const module = modules.find(item => item.id === id)
    if (!module?.installRequired || module.required) throw new Error(`Invalid optional installation component: ${id}`)
    return { ...module, defaultEnabled: false }
  })
}
