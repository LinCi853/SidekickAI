// electron/modules/plugins/tts/test-ipc.ts — TTS 测试连通性 IPC
//
// v0.5.2 regress-2：向 OpenAI 兼容 /audio/speech 端点发送短文本合成请求，
// 成功则返回 base64 编码的 audio/mpeg dataURL，渲染层可播放预览。
//
// 由 tts 插件的 init 调用 registerTtsTestIpc(scope) 完成注册。
//
// 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。

import { ipcMain } from 'electron'
import { request } from 'undici'
import { IPC_CHANNELS } from '../../../shared/types.js'
import { aiProviderStore, deriveAudioEndpoint } from '../../../store/ai-provider-store.js'
import { getProxyDispatcher } from '../../../store/proxy-helper.js'
import type { EffectScope } from '../../effect-scope.js'

/**
 * 注册 TTS 测试连通性 IPC（TTS 模块专属，独立于语音输入模块）。
 *
 * 已迁移到统一注入管线：支持 EffectScope 管理 IPC handler 生命周期。
 */
export function registerTtsTestIpc(scope?: EffectScope): void {
  const requests = new Set<AbortController>()
  scope?.create('event-sub', 'tts.requests', () => {
    for (const controller of requests) controller.abort()
    requests.clear()
  })
  // 辅助函数：根据是否有 scope 选择注册方式
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = scope
    ? (channel: string, fn: (...args: any[]) => any) => scope.ipcHandle(channel, fn as any)
    : (channel: string, fn: (...args: any[]) => any) => ipcMain.handle(channel, fn as any)

  handle(IPC_CHANNELS.VOICE_TEST_TTS, async (_e: unknown, input: { providerId: string }) => {
    const controller = new AbortController()
    requests.add(controller)
    try {
      const provider = aiProviderStore.get(input.providerId)
      if (!provider) {
        return { ok: false, message: '供应商不存在' }
      }
      if (!provider.apiEndpoint || !provider.apiKey || !provider.ttsModel) {
        return { ok: false, message: '供应商未配置 TTS 模型或端点/API Key' }
      }
      const endpoint = deriveAudioEndpoint(provider.apiEndpoint, 'speech')
      const res = await request(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: provider.ttsModel,
          input: '测试合成',
        }),
        headersTimeout: 15000,
        bodyTimeout: 15000,
        dispatcher: getProxyDispatcher(),
        signal: controller.signal,
      })
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const text = await res.body.text().catch(() => '')
        return {
          ok: false,
          message: `HTTP ${res.statusCode}: ${text.slice(0, 200)}`,
        }
      }
      const buf = await res.body.arrayBuffer()
      controller.signal.throwIfAborted()
      if (buf.byteLength === 0) {
        return { ok: false, message: '端点返回空响应，可能不支持 TTS 格式' }
      }
      const contentType = (res.headers['content-type'] as string) || 'audio/mpeg'
      const mime = contentType.split(';')[0].trim()
      const audioDataUrl = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
      return { ok: true, message: '合成成功', audioDataUrl }
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      }
    } finally {
      requests.delete(controller)
    }
  })
}
