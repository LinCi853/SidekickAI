// electron/modules/adapters/event-sub-adapter.ts — 事件订阅适配器
//
// 处理 EventEmitter 的事件订阅和取消订阅。
// 支持 once 模式。

import type { TargetAdapter } from './types.js'
import type { EventSubPayload } from './types.js'
import type { EffectHandle, EffectScope } from '../effect-scope.js'
import type { InjectionRequest } from '../injection-broker.js'

class EventSubAdapterImpl implements TargetAdapter {
  readonly kind = 'event-sub' as const

  async apply(request: InjectionRequest, scope: EffectScope): Promise<EffectHandle> {
    const payload = request.payload as EventSubPayload
    const { emitter, event, listener, once } = payload

    if (once) {
      emitter.once(event, listener)
    } else {
      emitter.on(event, listener)
    }

    return scope.create('event-sub', request.capabilityId, () => {
      emitter.removeListener(event, listener)
    }, request.target?.id)
  }
}

export const eventSubAdapter = new EventSubAdapterImpl()
