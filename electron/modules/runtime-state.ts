interface ModuleRuntime {
  enabled: boolean
  installed: boolean
}

const states = new Map<string, ModuleRuntime>()

export function getModuleRuntime(id: string): ModuleRuntime | undefined {
  const state = states.get(id)
  return state ? { ...state } : undefined
}

export function setModuleRuntime(id: string, state: ModuleRuntime): void {
  states.set(id, { ...state })
}

export function isModuleEnabled(id: string): boolean {
  return states.get(id)?.enabled ?? false
}

export function isModuleInstalled(id: string): boolean {
  return states.get(id)?.installed ?? false
}

export function assertModuleEnabled(id: string, actionLabel?: string): void {
  if (!isModuleEnabled(id)) {
    const label = actionLabel ? `（${actionLabel}）` : ''
    throw new Error(`[modules] 模块已关闭: ${id}${label}`)
  }
}
