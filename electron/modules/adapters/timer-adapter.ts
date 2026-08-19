// electron/modules/adapters/timer-adapter.ts — 定时器适配器
//
// 处理 setInterval / setTimeout 的注册和清除。

import type { TargetAdapter } from './types.js'
import type { TimerPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class TimerAdapterImpl implements TargetAdapter {
  readonly kind = 'timer' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as TimerPayload
    const { fn, ms, type } = payload

    let timerId: ReturnType<typeof setTimeout>

    if (type === 'interval') {
      timerId = setInterval(fn, ms)
    } else {
      timerId = setTimeout(() => {
        fn()
      }, ms)
    }

    return scope.create('timer', request.capabilityId, () => {
      if (type === 'interval') {
        clearInterval(timerId)
      } else {
        clearTimeout(timerId)
      }
    }, request.target?.id)
  }
}

export const timerAdapter = new TimerAdapterImpl()
