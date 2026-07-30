/* =====================================================================
   shared/system-hotkeys.ts —— 常见 Windows 系统快捷键冲突检测
   录制热键时除本软件冲突外，还检测是否匹配常见系统快捷键，给出警告。
   注意：globalShortcut.isRegistered 只能返回 true/false，无法获取占用方信息，
   因此维护静态列表做主动匹配，提供更友好的冲突提示。
   accelerator 格式与 Electron 一致：修饰键首字母大写，+ 分隔（如 "Super+L"）

   此文件位于 electron/shared/，可被主进程和渲染层同时导入。
   ===================================================================== */

/** 系统快捷键占用信息 */
export interface SystemHotkeyConflict {
  /** accelerator 字符串 */
  accelerator: string;
  /** 系统功能描述 */
  label: string;
}

/**
 * 常见 Windows 系统快捷键列表
 * Super 对应 Windows 键（Electron accelerator 中用 Super 表示 Win 键）
 */
export const COMMON_WIN_SYSTEM_HOTKEYS: SystemHotkeyConflict[] = [
  // Win 组合键
  { accelerator: 'Super+L', label: '锁定屏幕' },
  { accelerator: 'Super+D', label: '显示桌面' },
  { accelerator: 'Super+E', label: '打开文件资源管理器' },
  { accelerator: 'Super+R', label: '打开运行对话框' },
  { accelerator: 'Super+I', label: '打开设置' },
  { accelerator: 'Super+Tab', label: '任务视图' },
  { accelerator: 'Super+P', label: '投影' },
  { accelerator: 'Super+A', label: '操作中心' },
  { accelerator: 'Super+S', label: '搜索' },
  { accelerator: 'Super+G', label: '游戏栏' },
  { accelerator: 'Super+V', label: '剪贴板历史' },
  { accelerator: 'Super+Shift+Left', label: '窗口移到左侧显示器' },
  { accelerator: 'Super+Shift+Right', label: '窗口移到右侧显示器' },
  { accelerator: 'Super+Up', label: '窗口最大化' },
  { accelerator: 'Super+Down', label: '窗口最小化/还原' },
  { accelerator: 'Super+Left', label: '窗口贴靠左侧' },
  { accelerator: 'Super+Right', label: '窗口贴靠右侧' },
  // Ctrl+Alt 组合
  { accelerator: 'Ctrl+Alt+Del', label: '安全选项（锁定/任务管理器等）' },
  { accelerator: 'Ctrl+Shift+Escape', label: '任务管理器' },
  // Alt 组合
  { accelerator: 'Alt+F4', label: '关闭当前窗口' },
  { accelerator: 'Alt+Tab', label: '切换应用' },
  { accelerator: 'Alt+Space', label: '窗口系统菜单（本软件默认占用）' },
  // 其他
  { accelerator: 'F1', label: '帮助' },
  { accelerator: 'F2', label: '重命名' },
  { accelerator: 'F3', label: '搜索下一个' },
  { accelerator: 'PrintScreen', label: '截图' },
  { accelerator: 'Ctrl+C', label: '复制（通用）' },
  { accelerator: 'Ctrl+V', label: '粘贴（通用）' },
  { accelerator: 'Ctrl+X', label: '剪切（通用）' },
  { accelerator: 'Ctrl+Z', label: '撤销（通用）' },
  { accelerator: 'Ctrl+Y', label: '重做（通用）' },
  { accelerator: 'Ctrl+A', label: '全选（通用）' },
  { accelerator: 'Ctrl+S', label: '保存（通用）' },
  { accelerator: 'Ctrl+P', label: '打印（通用）' },
];

/**
 * 归一化 accelerator 字符串用于比较
 * 去除空格、统一大小写、按 + 分割后排序修饰键
 */
export function normalizeAccelerator(acc: string): string {
  if (!acc) return '';
  const parts = acc.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  // 最后一个视为非修饰键（主键），前面的为修饰键
  const mainKey = parts[parts.length - 1].toLowerCase();
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase()).sort();
  return [...mods, mainKey].join('+');
}

/**
 * 检测 accelerator 是否匹配常见系统快捷键
 * @param acc accelerator 字符串（如 "Win+L"、"Ctrl+Shift+Escape"）
 * @returns 匹配的系统快捷键信息，无匹配返回 null
 */
export function checkSystemHotkeyConflict(acc: string): SystemHotkeyConflict | null {
  if (!acc) return null;
  const normalized = normalizeAccelerator(acc);
  for (const sys of COMMON_WIN_SYSTEM_HOTKEYS) {
    if (normalizeAccelerator(sys.accelerator) === normalized) {
      return sys;
    }
  }
  return null;
}
