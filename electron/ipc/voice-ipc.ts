// electron/ipc/voice-ipc.ts — 语音识别（STT）相关 IPC 注册
//
// 包含渲染进程主动调用的 STT 控制 IPC：
//   - STT_START：开始录音识别（渲染层自管路径，无预览窗）
//   - STT_STOP：停止录音并返回识别文本
//   - VOICE_TRIGGER_START/STOP：底栏语音按钮触发，走后台语音路径（含独立预览窗）
//
// 注意：Alt+V 后台语音流程（预览窗、startBackgroundVoice/stopBackgroundVoice）
// 与多个 main.ts 全局状态（previewWindow / lastFocusedWin / mainWindow / getVoiceConfig）
// 紧密耦合，保留在 main.ts 中；其热键注册由 hotkey-ipc.ts 通过 deps 注入调用。
//
// 在 app.whenReady 后由 main.ts 调用 registerVoiceIpc(deps) 完成注册。

import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC_CHANNELS } from '../shared/types.js'
import { broadcastToAllWindows } from '../shared/broadcast.js'
import { updateVoiceConfig, getVoiceConfig } from '../store/voice-store.js'
import { aiProviderStore, deriveAudioEndpoint } from '../store/ai-provider-store.js'
import {
  WHISPER_MODEL_FILES,
  isModelFileExists,
  listDownloadedModelIds,
  type SttEngine,
} from '../stt/engine.js'
import {
  WHISPER_CLI_BINARIES,
  getWhisperCliAssetInfo,
  getWhisperCliDownloadMirrors,
  getWhisperModelUrls,
} from '../stt/binary-resolver.js'
import type { AudioDeviceInfo } from '../shared/api.types.js'
import { downloadFile, downloadWithMirrors } from '../utils/downloader.js'
import { extractZip } from '../utils/zip-extractor.js'

/**
 * 校验 enumerateDevices 返回的设备对象，过滤掉非法项
 */
function isValidAudioDevice(d: unknown): d is AudioDeviceInfo {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return (
    typeof o.deviceId === 'string' &&
    typeof o.label === 'string' &&
    typeof o.groupId === 'string'
  )
}

/** 下载进度载荷类型 */
type DownloadProgressType = 'model' | 'cli'

/**
 * 向主窗口渲染层推送下载进度
 * @param type model/cli 区分
 * @param percent 0-100
 * @param status 精确状态字符串：'下载中' | '解压中' | '完成' | '下载失败' | '下载已在进行中…'
 * @param detail 可选明细，失败时附带具体错误描述（便于 UI 展示）
 */
function sendDownloadProgress(
  type: DownloadProgressType,
  percent: number,
  status: string,
  detail?: string,
): void {
  // 关键修复：广播到所有窗口（之前 getAllWindows()[0] 会漏发给非首个窗口，
  // 比如设置窗在第二个窗口时，UI 永远停在 'downloading'，但日志已显示 '完成'）
  broadcastToAllWindows(
    IPC_CHANNELS.VOICE_DOWNLOAD_PROGRESS,
    { type, percent, status, detail },
    'voice-download',
  )
}

/** 由 main.ts 注入的依赖（避免循环引用） */
export interface VoiceIpcDeps {
  sttEngine: SttEngine
  /** 触发后台语音录音（显示独立预览窗） */
  startBackgroundVoice: () => Promise<void>
  /** 停止后台语音录音并注入发送（隐藏预览窗） */
  stopBackgroundVoice: () => Promise<void>
}

/** 注册语音识别相关 IPC handler */
export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { sttEngine, startBackgroundVoice, stopBackgroundVoice } = deps

  ipcMain.handle(IPC_CHANNELS.STT_START, async () => {
    await sttEngine.start()
  })
  ipcMain.handle(IPC_CHANNELS.STT_STOP, async () => {
    return await sttEngine.stop()
  })

  /**
   * 测试当前 AI 接入配置连通性（用于设置页"测试连接"按钮）。
   * 发送 0.2s 静音 WAV，验证能拿到非空识别文本。
   */
  ipcMain.handle(
    IPC_CHANNELS.VOICE_TEST_AI,
    async (_e, input: { providerId: string }) => {
      try {
        return await sttEngine.testAiProvider(input.providerId)
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  /**
   * v0.5.2 regress-2：测试 TTS 配置连通性。
   * 向 OpenAI 兼容 /audio/speech 端点发送短文本合成请求，
   * 成功则返回 base64 编码的 audio/mpeg dataURL，渲染层可播放预览。
   */
  ipcMain.handle(
    IPC_CHANNELS.VOICE_TEST_TTS,
    async (_e, input: { providerId: string }) => {
      try {
        const provider = aiProviderStore.get(input.providerId)
        if (!provider) {
          return { ok: false, message: '供应商不存在' }
        }
        if (!provider.apiEndpoint || !provider.apiKey || !provider.ttsModel) {
          return { ok: false, message: '供应商未配置 TTS 模型或端点/API Key' }
        }
        const endpoint = deriveAudioEndpoint(provider.apiEndpoint, 'speech')
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: provider.ttsModel,
            input: '测试合成',
          }),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          return {
            ok: false,
            message: `HTTP ${res.status}: ${text.slice(0, 200)}`,
          }
        }
        const buf = await res.arrayBuffer()
        if (buf.byteLength === 0) {
          return { ok: false, message: '端点返回空响应，可能不支持 TTS 格式' }
        }
        // Derive MIME from Content-Type, fallback to audio/mpeg
        const contentType = res.headers.get('Content-Type') || 'audio/mpeg'
        const mime = contentType.split(';')[0].trim()
        const audioDataUrl = `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
        return { ok: true, message: '合成成功', audioDataUrl }
      } catch (e) {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        }
      }
    },
  )

  // 底栏语音按钮触发：走后台语音路径，显示独立预览窗
  ipcMain.handle(IPC_CHANNELS.VOICE_TRIGGER_START, async () => {
    await startBackgroundVoice()
  })
  ipcMain.handle(IPC_CHANNELS.VOICE_TRIGGER_STOP, async () => {
    await stopBackgroundVoice()
  })

  /**
   * 渲染层（RecordIndicator 客户端）请求强制停止当前录音。
   * 用于主进程 keyup 丢失 / IPC 卡住 等异常情况下的兜底恢复。
   * 调用 stopBackgroundVoice() 等同于"用户松开热键"，会触发正常的识别流程。
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_FORCE_STOP, async (_e, reason: string) => {
    console.warn(`[voice-ipc] 收到 forceStop 请求，原因: ${reason || '(未指定)'}`)
    try {
      await stopBackgroundVoice()
      return { ok: true, reason: 'stopped' }
    } catch (err) {
      console.error('[voice-ipc] forceStop 失败:', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 渲染层 → 主进程：检查单个 whisper 模型文件是否实际存在（不依赖 cfg）
   * 返回 { exists: boolean }
   * 用于设置页 UI 验证当前选中模型是否真的下载到磁盘（避免 cfg 与文件不一致）
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_CHECK_MODEL_EXISTS, async (_e, modelId: string) => {
    try {
      return { exists: isModelFileExists(modelId) }
    } catch (err) {
      console.error('[voice-ipc] checkModelExists 失败:', err)
      return { exists: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 渲染层 → 主进程：扫描 userData/models/ 目录，返回所有已下载的模型 id 列表
   * 关键用途：设置页 mount 时调用一次，把磁盘上真实存在的模型同步进 downloadedModels 数组。
   * 解决"之前下载过 / 手动放入了模型文件 / 切到其他模型后切回来仍提示下载"的问题。
   * 该调用会**主动修正** cfg.downloadedModels（若磁盘与配置不一致），并返回最新数组。
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_LIST_DOWNLOADED_MODELS, async () => {
    try {
      const ids = listDownloadedModelIds()
      console.log('[voice-ipc] 扫描到已下载模型:', ids)
      // 主动修正 cfg：以磁盘为最终标准
      const cfg = getVoiceConfig()
      const cfgIds = Array.isArray(cfg.downloadedModels) ? cfg.downloadedModels : []
      const needUpdate =
        ids.length !== cfgIds.length || ids.some((id) => !cfgIds.includes(id))
      if (needUpdate) {
        try {
          await updateVoiceConfig({ downloadedModels: ids })
          console.log('[voice-ipc] 已修正 downloadedModels:', cfgIds, '→', ids)
        } catch (cfgErr) {
          console.warn('[voice-ipc] 写回 downloadedModels 失败:', cfgErr)
        }
      }
      return { ok: true, models: ids }
    } catch (err) {
      console.error('[voice-ipc] listDownloadedModels 失败:', err)
      return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 渲染层上报麦克风设备列表（enumerateDevices 结果）。
   * 触发时机：RecordIndicator 启动、设置页"刷新设备"按钮。
   * 主进程保存到 voice-config.inputDeviceList，供设置页 UI 展示。
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_INPUT_DEVICES_UPDATE, async (_e, list: unknown[]) => {
    try {
      const safeList = Array.isArray(list) ? list.filter(isValidAudioDevice) : []
      await updateVoiceConfig({ inputDeviceList: safeList })
      console.info(`[voice-ipc] 已更新麦克风设备列表，共 ${safeList.length} 个设备`)
      return { ok: true, count: safeList.length }
    } catch (err) {
      console.error('[voice-ipc] 更新麦克风设备列表失败:', err)
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 主进程请求渲染层重新枚举设备。
   * 工作机制：广播一个内部事件，RecordIndicator 收到后调用 enumerateDevices 并上报。
   * 实际上设置页的"刷新"按钮可以直接调渲染层（无需经主进程），所以这个 handler
   * 主要用于未来其他场景（如系统设置变更后需要刷新）。
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_INPUT_DEVICES_REFRESH, async () => {
    // 由设置页直接调渲染层 enumerateDevices 即可，主进程无额外工作
    return { ok: true }
  })

  // 下载 whisper 模型（ggml-tiny/base/small.bin）
  // 国内访问 HuggingFace 常被墙，提供 hf-mirror.com 镜像 fallback
  let modelDownloading = false
  ipcMain.handle(
    IPC_CHANNELS.VOICE_DOWNLOAD_MODEL,
    async (_e, modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small') => {
      console.log('[voice-download] ====== 收到模型下载请求:', modelId, '======')
      if (modelDownloading) {
        console.warn('[voice-download] 模型下载已在进行中，忽略重复请求')
        sendDownloadProgress('model', 0, '下载已在进行中…')
        return
      }
      modelDownloading = true
      try {
        const sizeKey = modelId.replace('whisper-', '') // tiny | base | small
        const fileName = `ggml-${sizeKey}.bin`
        // 镜像列表统一从 binary-resolver 获取（hf-mirror 优先，HuggingFace 直连 fallback）
        const urls = getWhisperModelUrls(fileName)
        const modelsDir = path.join(app.getPath('userData'), 'models')
        const filePath = path.join(modelsDir, fileName)

        console.log('[voice-download] modelsDir:', modelsDir)
        fs.mkdirSync(modelsDir, { recursive: true })

        try {
          await updateVoiceConfig({ downloadStatus: 'downloading' })
        } catch (cfgErr) {
          console.error('[voice-download] updateVoiceConfig(downloading) 失败:', cfgErr)
        }
        sendDownloadProgress('model', 0, '下载中')

        console.log('[voice-download] 开始尝试下载模型，共', urls.length, '个镜像源')
        await downloadWithMirrors(urls, filePath, (percent) => {
          sendDownloadProgress('model', percent, '下载中')
        })
        try {
          await updateVoiceConfig({ downloadStatus: 'ready', downloadModel: modelId })
        } catch (cfgErr) {
          console.error('[voice-download] updateVoiceConfig(ready) 失败:', cfgErr)
        }
        console.log('[voice-download] ====== 模型下载完成 ======')
        sendDownloadProgress('model', 100, '完成')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[voice-download] ====== 模型下载全部失败 ======', msg)
        try {
          await updateVoiceConfig({ downloadStatus: 'failed' })
        } catch (cfgErr) {
          console.error('[voice-download] updateVoiceConfig(failed) 失败:', cfgErr)
        }
        sendDownloadProgress('model', 0, '下载失败', msg.slice(0, 200))
      } finally {
        modelDownloading = false
      }
    },
  )

  // 下载 whisper.cpp 预编译引擎二进制（Windows x64）
  // 并发守卫：防止用户多次点击下载按钮导致并发下载
  // v1.7.x 之前的 release 才提供 whisper-bin-x64.zip 预编译（v1.7.4 已无预编译，仅源码）。
  // 实测 v1.9.1 release 资产：`whisper-bin-x64.zip`（~8MB，包含 whisper-cli.exe 等）。
  // 仓库已从 ggerganov/whisper.cpp 迁移到 ggml-org/whisper.cpp。
  let cliDownloading = false
  ipcMain.handle(IPC_CHANNELS.VOICE_DOWNLOAD_WHISPER_CLI, async () => {
    console.log('[voice-download] ====== 收到 whisper-cli 下载请求 ======')
    if (cliDownloading) {
      console.warn('[voice-download] CLI 下载已在进行中，忽略重复请求')
      sendDownloadProgress('cli', 0, '下载已在进行中…')
      return
    }
    cliDownloading = true
    try {
      // 按当前平台+架构获取预编译包资产信息（文件名、URL、预期大小）
      const assetInfo = getWhisperCliAssetInfo()
      // 镜像列表统一从 binary-resolver 获取（国内镜像优先，GitHub 直连 fallback）
      const urls = getWhisperCliDownloadMirrors(assetInfo.fileName)
      const binDir = path.join(app.getPath('userData'), 'bin')
      const tmpZip = path.join(binDir, assetInfo.fileName)

      console.log('[voice-download] binDir:', binDir)
      fs.mkdirSync(binDir, { recursive: true })
      console.log('[voice-download] binDir 已创建，开始更新配置…')

      try {
        await updateVoiceConfig({ downloadStatus: 'downloading' })
      } catch (cfgErr) {
        console.error('[voice-download] updateVoiceConfig(downloading) 失败:', cfgErr)
        // 不中断流程，继续下载
      }
      sendDownloadProgress('cli', 0, '下载中')

      console.log('[voice-download] 开始尝试下载，共', urls.length, '个镜像源')
      await downloadWithMirrors(urls, tmpZip, (percent) => {
        sendDownloadProgress('cli', percent, '下载中')
      })
      console.log('[voice-download] 下载完成，开始解压…')
      sendDownloadProgress('cli', 100, '解压中')
      await extractZip(tmpZip, binDir)
      console.log('[voice-download] 解压完成，验证文件…')
      // 列出 binDir 内容用于调试
      try {
        const files = fs.readdirSync(binDir)
        console.log('[voice-download] bin 目录内容:', files)
      } catch (e: unknown) {
        console.warn('[voice-ipc] 读取 bin 目录失败:', e)
      }
      // 清理临时 zip
      try {
        fs.unlinkSync(tmpZip)
      } catch (e: unknown) {
        console.warn('[voice-ipc] 删除临时 zip 文件失败:', e)
      }
      try {
        // 关键修复：下载完成后**必须**将 cliDownloaded=true 持久化到 cfg。
        // 之前只写 downloadStatus='ready'，但前端 UI 不再依赖 downloadStatus 判断，
        // 而是依赖 cfg.cliDownloaded 字段。如果不写，下次启动 getVoiceConfig 扫描到
        // 文件存在会修正 cfg=true，但**写一次更可靠**且更即时。
        await updateVoiceConfig({ downloadStatus: 'ready', cliDownloaded: true })
      } catch (cfgErr) {
        console.error('[voice-download] updateVoiceConfig(ready) 失败:', cfgErr)
      }
      console.log('[voice-download] ====== whisper-cli 下载完成 ======')
      sendDownloadProgress('cli', 100, '完成')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[voice-download] ====== CLI 下载全部失败 ======', msg)
      try {
        // 关键修复：下载失败时**不**写 cliDownloaded=false。
        // 之前的逻辑会强行把 cliDownloaded 改为 false，导致：
        //   - 用户之前下载成功过（cliDownloaded=true），某次重新下载时网络失败
        //   - 状态被错误地降级为 false，"已就绪"消失，UI 又显示下载按钮
        // 现在只写 downloadStatus='failed'，cliDownloaded 保持用户历史成功状态不变。
        // 与"下载后离线使用"的持久化语义保持一致。
        await updateVoiceConfig({ downloadStatus: 'failed' })
      } catch (cfgErr) {
        console.error('[voice-download] updateVoiceConfig(failed) 失败:', cfgErr)
      }
      // 关键修复：必须传精确的状态字符串，让 UI 的 `p.status === '下载失败'` 命中
      // 之前是 '下载失败：' + msg 前缀，UI 严格匹配失败导致状态停留在 'downloading' 或 'ready'
      sendDownloadProgress('cli', 0, '下载失败', msg.slice(0, 200))
    } finally {
      cliDownloading = false
    }
  })

  /**
   * 检查 whisper-cli 二进制文件是否实际存在（不依赖 cfg.downloadStatus）。
   * 用于设置页挂载时校准：cfg 说 'ready' 但文件不在（被清理/移动）时返回 false。
   * 关键修复：之前 settings 每次打开都从 cfg 读 downloadStatus，但 cfg 没和文件系统联动；
   * 现在每次打开调用本接口，以"文件实际存在"为准，避免误判需要重新下载。
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_CHECK_CLI_EXISTS, async () => {
    const binDir = path.join(app.getPath('userData'), 'bin')
    for (const name of WHISPER_CLI_BINARIES) {
      const full = path.join(binDir, name)
      try {
        const s = await fs.promises.stat(full)
        if (s.isFile() && s.size > 1024) {
          return { exists: true, path: full, size: s.size }
        }
      } catch {
        // 不存在就继续找下一个候选名
      }
    }
    return { exists: false, path: null, size: 0 }
  })

  /**
   * 卸载 whisper-cli 引擎二进制：删除 userData/bin/ 下的所有可执行文件 + 配套资源 + 修正 cfg。
   * 返回 { ok, removed, reason? }：removed 是已删除的文件名列表。
   *
   * 删除范围（仅引擎目录 userData/bin/）：
   *   - WHISPER_CLI_BINARIES 中列出的可执行文件（whisper-cli.exe / whisper.exe / main.exe）
   *   - 引擎 zip 解压可能带出的 dll（*.dll，如 ggml.dll、whisper.dll）
   *   - 解压临时目录 _tmp_extract_*
   *   - 上次未清理的 zip（whisper-bin-x64.zip）
   * 不删除整个 bin 目录本身（避免误删用户后续手动放入的工具）。
   * 卸载完成后：
   *   - cfg.cliDownloaded = false
   *   - cfg.downloadStatus = 'idle'（避免 UI 误显示"已就绪"）
   *   - 清空 cfg.downloadModel（防止下拉选到刚卸载的模型）
   */
  ipcMain.handle(IPC_CHANNELS.VOICE_UNINSTALL_WHISPER_CLI, async () => {
    const removed: string[] = []
    const errors: string[] = []
    try {
      const binDir = path.join(app.getPath('userData'), 'bin')
      if (!fs.existsSync(binDir)) {
        // bin 目录不存在：直接认为已卸载
        await updateVoiceConfig({ cliDownloaded: false, downloadStatus: 'idle' })
        return { ok: true, removed }
      }
      // 收集要删除的文件：引擎可执行文件 + 同目录 dll + 残留 zip + 临时目录
      const entries = fs.readdirSync(binDir)
      const targets: string[] = []
      for (const name of entries) {
        const full = path.join(binDir, name)
        try {
          const s = fs.statSync(full)
          if (s.isDirectory()) {
            // 临时解压目录
            if (name.startsWith('_tmp_extract_')) {
              targets.push(full)
            }
            continue
          }
          if (s.isFile()) {
            // 引擎可执行文件
            if (WHISPER_CLI_BINARIES.includes(name)) {
              targets.push(full)
              continue
            }
            // 残留的 zip
            if (name === 'whisper-bin-x64.zip') {
              targets.push(full)
              continue
            }
            // 引擎 dll（如 ggml.dll、whisper.dll 等）
            if (/\.dll$/i.test(name)) {
              targets.push(full)
              continue
            }
          }
        } catch (statErr) {
          console.warn('[voice-ipc] 跳过无法 stat 的项:', name, statErr)
        }
      }
      // 逐个删除（容错：单个文件失败不阻塞其他文件）
      for (const target of targets) {
        try {
          const stat = fs.statSync(target)
          if (stat.isDirectory()) {
            fs.rmSync(target, { recursive: true, force: true })
          } else {
            fs.unlinkSync(target)
          }
          removed.push(path.basename(target))
        } catch (delErr) {
          const msg = delErr instanceof Error ? delErr.message : String(delErr)
          console.error('[voice-ipc] 删除失败:', target, '→', msg)
          errors.push(`${path.basename(target)}: ${msg}`)
        }
      }
      // 卸载完成后修正 cfg：cliDownloaded=false、downloadStatus=idle、downloadModel=''
      // 不修改 downloadModel 太激进（用户可能想保留偏好），但下载状态需要回到 idle，
      // 否则 UI 会误显示"已就绪"。downloadModel 保留用户的当前选择（切换到其他已下载模型即可）。
      await updateVoiceConfig({ cliDownloaded: false, downloadStatus: 'idle' })
      console.log(`[voice-ipc] whisper-cli 卸载完成，删除 ${removed.length} 项`)
      if (errors.length > 0) {
        return { ok: true, removed, reason: '部分删除失败：' + errors.join('; ') }
      }
      return { ok: true, removed }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[voice-ipc] 卸载 whisper-cli 失败:', msg)
      return { ok: false, removed, reason: msg }
    }
  })

  /**
   * 卸载指定 whisper 模型文件（按 modelId）：删除对应 ggml-*.bin + 从 cfg.downloadedModels 移除。
   * 返回 { ok, path?, reason? }。
   * 注意：如果当前选中的 model 就是要卸载的，会自动切换到第一个仍存在的模型（或空）。
   */
  ipcMain.handle(
    IPC_CHANNELS.VOICE_UNINSTALL_MODEL,
    async (
      _e,
      modelId: 'whisper-tiny' | 'whisper-base' | 'whisper-small',
    ) => {
      try {
        const fileName = WHISPER_MODEL_FILES[modelId]
        if (!fileName) {
          return { ok: false, reason: `未知的 modelId: ${modelId}` }
        }
        const modelsDir = path.join(app.getPath('userData'), 'models')
        const filePath = path.join(modelsDir, fileName)
        if (!fs.existsSync(filePath)) {
          return { ok: false, reason: '文件不存在', path: filePath }
        }
        // 删除文件
        fs.unlinkSync(filePath)
        console.log(`[voice-ipc] 已删除模型文件: ${filePath}`)
        // 从 cfg.downloadedModels 数组移除（主进程作为真值）
        const cfg = getVoiceConfig()
        const newDownloaded = (Array.isArray(cfg.downloadedModels)
          ? cfg.downloadedModels
          : []
        ).filter((id) => id !== modelId)
        // 如果当前选中的就是要卸载的，切换到第一个仍存在的模型（无则空）
        const newCurrent = cfg.downloadModel === modelId
          ? (newDownloaded[0] ?? '')
          : cfg.downloadModel
        // 如果没有任何已下载模型，把 downloadStatus 置 idle（避免 UI 误显示"已就绪"）
        const newStatus: 'idle' | 'ready' | 'downloading' | 'failed' = newDownloaded.length > 0 ? cfg.downloadStatus : 'idle'
        await updateVoiceConfig({
          downloadedModels: newDownloaded,
          downloadModel: newCurrent,
          downloadStatus: newStatus,
        })
        return { ok: true, path: filePath }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[voice-ipc] 卸载模型失败:', modelId, '→', msg)
        return { ok: false, reason: msg }
      }
    },
  )
}
