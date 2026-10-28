// electron/platform/hotkey/hotkey-conflict.ts — 唤出键冲突定位与处置指引
//
// 沉淀 2026-10-28 Alt+Space 占用排查的方法论：
//   1. 「是否被占」以 RegisterHotKey 为准（globalShortcut.register 本身就是探针），
//      不依赖任何应用自报的设置界面；
//   2. 「被谁占」无法从系统直接读出归属，定位靠「进程候选 + 处置知识表」启发式排序，
//      只提示、不强制结束其它进程；
//   3. 处置指引来自已核实的真实案例（如 Trae 的悬浮球开关不控注册）。
import { execFile } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  name: string
  commandLine: string
}

export interface ConflictCandidate {
  pid: number
  name: string
  /** 为什么怀疑它持有全局快捷键 */
  reason: string
  /** 处置指引；未知应用为 null */
  hint: string | null
}

/** 已知会静默注册全局唤出键的应用 → 怀疑理由与处置指引 */
export const KNOWN_HOTKEY_GRABBERS: Array<{ match: RegExp; reason: string; hint: string }> = [
  {
    match: /Trae\s*CN\.exe/i,
    reason: 'Trae 的悬浮球模块启动时会无条件注册全局唤出键（默认 Alt+Space）',
    hint: '在 Trae 的 settings.json 把 trae.floatingChat.shortcut 改为其它组合或留空；「启用桌面悬浮球/宠物」开关不控制此注册',
  },
  {
    match: /PowerLauncher\.exe|PowerToys/i,
    reason: 'PowerToys Run 的默认唤出键是 Alt+Space',
    hint: 'PowerToys → PowerToys Run → Activation shortcut 改键',
  },
  {
    match: /ToDesk\.exe/i,
    reason: 'ToDesk 可配置全局呼出键',
    hint: 'ToDesk 设置 → 呼出热键 改键或清除',
  },
  {
    match: /Listary\.exe|uTools\.exe|Wox\.exe|FluentSearch/i,
    reason: '启动器/搜索类工具普遍注册全局唤出键',
    hint: '在该工具的设置中查找「全局快捷键/唤出热键」改键',
  },
  {
    match: /Xiaomi MiMo\.exe|Cherry Studio\.exe|DeepSeek Harness\.exe/i,
    reason: 'AI 助手类桌面客户端常带全局唤出键',
    hint: '在该应用设置中查找「唤出/快捷键」改键',
  },
  {
    match: /Ditto\.exe/i,
    reason: 'Ditto 剪贴板可配置全局粘贴/唤出键',
    hint: 'Ditto 选项 → 快捷键 改键',
  },
  {
    match: /Everything\.exe/i,
    reason: 'Everything 可配置全局窗口热键',
    hint: 'Everything 选项 → 常规 → 快捷键 检查「显示窗口」热键',
  },
]

/** 系统/宿主进程，永远不会是快捷键占用者，直接排除 */
const IGNORED_PROCESS =
  /^(System|Registry|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|fontdrvhost|WUDFHost|conhost|OpenConsole|RuntimeBroker|SearchHost|SearchIndexer|SearchProtocolHost|ShellExperienceHost|ShellHost|StartMenuExperienceHost|sihost|taskhostw|TextInputHost|TabTip|ctfmon|ChsIME|ImeWatchdog|audiodg|spoolsv|dllhost|WmiPrvSE|WMIADAP|taskkill|cmd|bash|powershell|git|sed|clinfo|LockApp|smartscreen|backgroundTaskHost|CrossDeviceResume|SecurityHealthService|NgcIso|LsaIso|Secure System|vmcompute|vmms|vmwp|vmmem|vmnat|vmnetdhcp|vmware-authd|vmware-tray|vmware-usbarbitrator|wsl|wslhost|wslservice|msrdc|inetinfo|logi_lamparray|GameInput|dasHost|FlClashHelper|WifiAutoInstall|RTUWPSrvc|vivo|AMDRSServ|AMDRSSrcExt|AMDADLXServ|atiesrxx|atieclxx|amdfendrsr|amdow|AmdPpkgSvc|RadeonSoftware|cncmd|CPUMetrics|AUEPDU|MSI\.|MSI_|LEDKeeper|HipsDaemon|HipsTray|wsctrlsvc|parfait_crash_handler|crashpad|Xiaomi MiMo\.exe--type|msedgewebview2|node)(\.exe)?$/i

/**
 * 对进程列表做冲突候选排序：
 *   1. 命中 KNOWN_HOTKEY_GRABBERS 的排最前（按表顺序）；
 *   2. 其余带图形界面嫌疑的用户程序排后（按名字字典序），仅作补充线索；
 *   3. 系统/宿主进程排除。
 * 只做排序与提示，不结束任何进程。
 */
export function rankConflictCandidates(processes: ProcessInfo[]): ConflictCandidate[] {
  const known: ConflictCandidate[] = []
  const others: ConflictCandidate[] = []
  for (const proc of processes) {
    if (!proc.name || IGNORED_PROCESS.test(proc.name)) continue
    const hit = KNOWN_HOTKEY_GRABBERS.find((entry) => entry.match.test(proc.name))
    if (hit) {
      known.push({ pid: proc.pid, name: proc.name, reason: hit.reason, hint: hit.hint })
    } else {
      others.push({
        pid: proc.pid,
        name: proc.name,
        reason: '运行中的用户程序（未命中已知清单）',
        hint: null,
      })
    }
  }
  others.sort((a, b) => a.name.localeCompare(b.name))
  return [...known, ...others]
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
