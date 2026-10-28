// electron/platform/hotkey/hotkey-conflict.ts — 唤出键冲突定位与处置指引
//
// 沉淀 2026-10-28 Alt+Space 占用排查的方法论：
//   1. 「是否被占」以 RegisterHotKey 为准（globalShortcut.register 本身就是探针），
//      不依赖任何应用自报的设置界面；
//   2. 「被谁占」无法从系统直接读出归属，定位靠「进程候选 + 处置知识表」启发式排序，
//      只提示、不强制结束其它进程；
//   3. 处置指引来自已核实的真实案例（如 Trae 的悬浮球开关不控注册）；
//   4. 候选按置信分级：high=已证实会注册全局唤出键的应用；
//      medium=常见抢注者（输入法 AI 键、聊天/安全/浏览器类的呼出键、老板键）；
//      low=运行中的其它用户程序，仅作补充线索。
import { execFile } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  name: string
  commandLine: string
}

export type ConflictConfidence = 'high' | 'medium' | 'low'

export interface ConflictCandidate {
  pid: number
  name: string
  /** 同名进程数（>1 时按去重聚合展示） */
  instances: number
  /** 置信：high=明确抢注者；medium=常见抢注者；low=一般用户程序 */
  confidence: ConflictConfidence
  /** 为什么怀疑它持有全局快捷键 */
  reason: string
  /** 处置指引；未知应用为 null */
  hint: string | null
}

interface GrabberEntry {
  match: RegExp
  confidence: 'high' | 'medium'
  reason: string
  hint: string
}

/** 已知会注册全局唤出键的应用 → 置信、怀疑理由与处置指引 */
export const KNOWN_HOTKEY_GRABBERS: GrabberEntry[] = [
  {
    match: /Trae\s*CN\.exe/i,
    confidence: 'high',
    reason: 'Trae 的悬浮球模块启动时会无条件注册全局唤出键（默认 Alt+Space）',
    hint: '在 Trae 的 settings.json 把 trae.floatingChat.shortcut 改为其它组合或留空；「启用桌面悬浮球/宠物」开关不控制此注册',
  },
  {
    match: /PowerLauncher\.exe|PowerToys/i,
    confidence: 'high',
    reason: 'PowerToys Run 的默认唤出键是 Alt+Space',
    hint: 'PowerToys → PowerToys Run → Activation shortcut 改键',
  },
  {
    match: /Listary\.exe|uTools\.exe|Wox\.exe|FluentSearch/i,
    confidence: 'high',
    reason: '启动器/搜索类工具普遍注册全局唤出键',
    hint: '在该工具的设置中查找「全局快捷键/唤出热键」改键',
  },
  {
    match: /Doubao|ImeService\.exe|ImeWatchdog\.exe|豆包/i,
    confidence: 'high',
    reason: '豆包输入法的 AI/工具箱功能会注册全局唤出键（ImeService 为提权常驻进程）',
    hint: '豆包输入法设置 → 快捷键/工具箱 检查唤出键并改键；注意其服务进程随输入法常驻',
  },
  {
    match: /ToDesk\.exe/i,
    confidence: 'medium',
    reason: 'ToDesk 可配置全局呼出键',
    hint: 'ToDesk 设置 → 呼出热键 改键或清除',
  },
  {
    match: /^QQ\.exe$|QQNT|TIM\.exe/i,
    confidence: 'medium',
    reason: 'QQ/TIM 的提取消息、截图等全局快捷键可被自定义为任意组合',
    hint: 'QQ 设置 → 热键 检查「提取消息/截图」等快捷键并改键',
  },
  {
    match: /ChatGLM|Zhipu|智谱/i,
    confidence: 'medium',
    reason: '智谱清言类 AI 客户端可能带全局唤出键',
    hint: '在该客户端设置中查找「唤出/快捷键」改键',
  },
  {
    match: /360/i,
    confidence: 'medium',
    reason: '360 系软件（安全卫士/浏览器/桌面）常带加速球、老板键等全局热键',
    hint: '在对应 360 软件的设置中查找「快捷键/老板键」改键或关闭',
  },
  {
    match:
      /chrome|msedge|firefox|qqbrowser|browser|quark|ucbrowser|2345explorer|sogouexplorer|maxthon/i,
    confidence: 'medium',
    reason: '浏览器/浏览器外壳可能带全局呼出键（老板键、快速唤出等）',
    hint: '检查浏览器设置与已装扩展的全局快捷键（如老板键、快速唤出）',
  },
  {
    match: /Xiaomi MiMo\.exe|Cherry Studio\.exe|DeepSeek Harness\.exe/i,
    confidence: 'medium',
    reason: 'AI 助手类桌面客户端常带全局唤出键',
    hint: '在该应用设置中查找「唤出/快捷键」改键',
  },
  {
    match: /Ditto\.exe/i,
    confidence: 'medium',
    reason: 'Ditto 剪贴板可配置全局粘贴/唤出键',
    hint: 'Ditto 选项 → 快捷键 改键',
  },
  {
    match: /Everything\.exe/i,
    confidence: 'medium',
    reason: 'Everything 可配置全局窗口热键',
    hint: 'Everything 选项 → 常规 → 快捷键 检查「显示窗口」热键',
  },
]

/** 系统/宿主进程，永远不会是快捷键占用者，直接排除 */
const IGNORED_PROCESS =
  /^(System|Registry|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|fontdrvhost|WUDFHost|conhost|OpenConsole|RuntimeBroker|SearchHost|SearchIndexer|SearchProtocolHost|ShellExperienceHost|ShellHost|StartMenuExperienceHost|sihost|taskhostw|TextInputHost|TabTip|ctfmon|ChsIME|audiodg|spoolsv|dllhost|WmiPrvSE|WMIADAP|taskkill|cmd|bash|powershell|git|sed|clinfo|LockApp|smartscreen|backgroundTaskHost|CrossDeviceResume|SecurityHealthService|NgcIso|LsaIso|Secure System|vmcompute|vmms|vmwp|vmmem|vmnat|vmnetdhcp|vmware-authd|vmware-tray|vmware-usbarbitrator|wsl|wslhost|wslservice|msrdc|inetinfo|logi_lamparray|GameInput|dasHost|FlClashHelper|WifiAutoInstall|RTUWPSrvc|vivo|AMDRSServ|AMDRSSrcExt|AMDADLXServ|atiesrxx|atieclxx|amdfendrsr|amdow|AmdPpkgSvc|RadeonSoftware|cncmd|CPUMetrics|AUEPDU|MSI\.|MSI_|LEDKeeper|HipsDaemon|HipsTray|wsctrlsvc|parfait_crash_handler|crashpad|msedgewebview2|node)(\.exe)?$/i

const CONFIDENCE_ORDER: Record<ConflictConfidence, number> = { high: 0, medium: 1, low: 2 }

/**
 * 对进程列表做冲突候选排序：
 *   1. 命中知识表的按置信排前（high 先于 medium，同级按表顺序）；
 *   2. 未命中的一般用户程序排最后（按名字字典序），仅作补充线索；
 *   3. 同名进程去重聚合计数；系统/宿主进程排除。
 * 只做排序与提示，不结束任何进程。
 */
export function rankConflictCandidates(processes: ProcessInfo[]): ConflictCandidate[] {
  const byName = new Map<
    string,
    { proc: ProcessInfo; instances: number; hit?: GrabberEntry; tableIndex: number }
  >()
  for (const proc of processes) {
    if (!proc.name || IGNORED_PROCESS.test(proc.name)) continue
    const existing = byName.get(proc.name)
    if (existing) {
      existing.instances += 1
      continue
    }
    const tableIndex = KNOWN_HOTKEY_GRABBERS.findIndex((entry) => entry.match.test(proc.name))
    const hit = tableIndex >= 0 ? KNOWN_HOTKEY_GRABBERS[tableIndex] : undefined
    byName.set(proc.name, { proc, instances: 1, hit, tableIndex })
  }
  const ranked = [...byName.values()].map(({ proc, instances, hit, tableIndex }) => ({
    pid: proc.pid,
    name: proc.name,
    instances,
    confidence: hit ? hit.confidence : ('low' as ConflictConfidence),
    reason: hit ? hit.reason : '运行中的用户程序（未命中已知清单）',
    hint: hit ? hit.hint : null,
    tableIndex,
  }))
  ranked.sort((a, b) => {
    const tier = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence]
    if (tier !== 0) return tier
    // 同层内按知识表顺序（表即优先级），未命中者按名字字典序殿后
    if (a.confidence === 'low') return a.name.localeCompare(b.name)
    return a.tableIndex - b.tableIndex
  })
  return ranked.map(({ tableIndex: _tableIndex, ...candidate }) => candidate)
}

/** 枚举当前会话进程（name + commandLine），供 rankConflictCandidates 排序 */
export function listProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { $_.ProcessId.ToString() + "|" + $_.Name + "|" + (($_.CommandLine -replace "\\s+"," ")) }',
      ],
      { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        const result: ProcessInfo[] = []
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          const first = trimmed.indexOf('|')
          const second = trimmed.indexOf('|', first + 1)
          if (first <= 0 || second < 0) continue
          const pid = Number.parseInt(trimmed.slice(0, first), 10)
          if (!Number.isInteger(pid) || pid <= 0) continue
          result.push({
            pid,
            name: trimmed.slice(first + 1, second),
            commandLine: trimmed.slice(second + 1),
          })
        }
        resolve(result)
      },
    )
  })
}

/**
 * 一次完整的冲突定位：给出候选进程与处置指引。
 * 「是否被占」由调用方以 globalShortcut 探测结果为准（本函数只解释「被谁占」）。
 */
export async function locateHotkeyConflict(): Promise<ConflictCandidate[]> {
  return rankConflictCandidates(await listProcesses())
}
