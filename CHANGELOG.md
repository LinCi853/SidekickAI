# 更新日志

> 版本计数自 v0.0.1 重新开始。v0.0.x 与历史版本的对应关系：
> - v0.0.1 ≈ 历史 v0.5.1
> - v0.0.2 ≈ 历史 v0.5.2
> - v0.0.3 ≈ 历史 v0.5.3

---

## v0.0.3 — 2026-08-01

> 本版本重点：白板引擎迁移至 Excalidraw（MIT 可商用）；品牌色系从砖红切换为靛蓝并系统性修复对比度；恢复截图到白板功能。

### 重要更改

- **白板引擎迁移：tldraw → Excalidraw**
  原白板组件 tldraw 采用专有许可证，存在商用合规风险。本版本整体迁移至 Excalidraw（MIT），数据模型从卡片级 API 重构为 Excalidraw scene snapshot，遗留 v1 卡片数据自动迁移。CSP 配置同步移除 `cdn.tldraw.com` 白名单。

- **品牌色系迁移：砖红 → 靛蓝**
  品牌主色从暖砖红切换为靛蓝（`--primary` = `#4F46E5`、`--ring` = `#6366F1`），与 UI 2.0 设计方向对齐。brand 色阶完整替换为 Indigo 50–900，品牌渐变统一为 `#6366F1 → #4338CA`，亮 / 暗双主题一致。

### 新功能

- **截图 AI 页面到白板**（恢复）
  右键顶栏标签页 →「页面操作」→「截图到白板」，将当前 AI 页面截图推送至进阶面板白板。适配 v3 Excalidraw 架构：`webview.capturePage()` 捕获 → 存为 `whiteboard-asset://` 磁盘资源 → 主进程打开进阶面板并切到白板 tab → 注入为 Excalidraw image 元素并自动滚动到视口。图片宽度超过 400px 时按比例缩放，随机偏移避免多张截图重叠。

### 体验优化

- **对比度系统性修复**：11 处「浅色背景 + 白字」场景（用户气泡、主按钮渐变、AppSwitcher 图标、提示词库标签与分段选中态、数据导出预设选中态、供应商模型标签等）对比度从 ~1.4:1 提升至 4.7:1（亮色）/ ~7:1（暗色），达到 WCAG AA 标准。
- **红系反馈色收敛**：错误 / 危险红统一为 `--destructive` 单一来源，`--danger` 作为其别名，消除 `#ef4444` 与 `#e57373` 双值漂移；`--window-close`（窗口控制红）、`--highlight-recording`（录制状态红）作为语义专用变体独立保留。
- **警告徽章对比度修复**：快捷键冲突徽章从「白字 + 琥珀底」（~2:1）改用专用令牌 `--warning-badge-bg` / `-fg`（亮色深棕字、暗色提亮琥珀 + 深字），双主题一致。
- **字体与圆角**：`--font-sans` 首位改 Exo 2（原 Geist 未加载）；`index.html` 加载 Playfair Display 使 `--font-serif` 生效；按钮圆角统一到 `--radius-sm`。
- **WebviewTab 导航修复**：webview `src` 仅在挂载时设置一次，避免 SPA 内部导航触发 React 重渲染导致 `ERR_ABORTED`。

### 问题修复

- 修复暗色主题下 `--danger` 仍使用亮色值的历史缺陷。
- 清理死兜底值 `var(--x, #错误值)` 与硬编码 `#fff`（统一改用 `--foreground-inverse` / `--destructive-foreground`）。

### 开源合规

- README 新增商标声明：本项目不隶属于所聚合的任何 AI 服务提供商，仅使用平台名称首字母 + 自定义渐变色作为视觉标识，未内置 / 分发任何平台 Logo 或商标图形。
- README 新增开源依赖许可证清单（Electron / React / Excalidraw / better-sqlite3 / Tiptap / Vite / Zustand 等 MIT，opencc-js Apache-2.0，lucide-react ISC，highlight.js BSD-3-Clause，DOMPurify MPL-2.0 / Apache-2.0）。

---

## v0.0.2 — 2026-07-26

> AiApp 概念统一重构为 AdvancedPanel（高级面板），并完成一轮死代码清理与通用基础设施抽取。

### 新功能

- **AiApp → AdvancedPanel 重构**：原「AI 应用」概念统一重命名为「高级面板」。新增 `AdvancedPanelView`、`AdvancedPanelSettingsPanel`、`AdvancedPanelGeneralSection` 与 `advanced-panel-window` 窗口工厂；移除旧的 `AiAppSettingsPanel` / `AiAppGeneralSection` / `AiProviderAppView` / `ai-app-window`。
- **Combobox 通用组件**：新增下拉组合框 UI 组件，统一选择交互。
- **webview-preload**：新增 webview 预加载脚本，为后续 webview 内部能力注入打基础。
- **平台检测增强**：`platform-detector` 新增 `isMobile()` 导出。

### 工程优化

- **死代码清理**：删除 headless 模块及 `puppeteer-core` 依赖；删除 `stt-cleaner`、`useSwipeNavigation`、`Card` / `ListItem` 等孤立文件；清理 20+ 未使用的 electron-api wrapper。
- **主进程基础设施抽取**：新增 `ipc-utils`（安全 IPC 包装）、`broadcast`（窗口广播）；扩展 `store-paths` 提供 SQLite / JSON store 基础设施；拆分 `voice-ipc` 为 `downloader` + `zip-extractor` 模块；重构 `window-factory` 抽取 webPreferences / 单例弹窗 / 脱离窗口生命周期工厂。
- **渲染层基础设施抽取**：新增 `useWindowMaximizedAndPinned` / `useIsNarrow` / `useEscToCloseWindow` 等 7 个 hook；新增 `StandaloneWindowHeader` / `VoiceProviderConfig` / `TitleBar` 组件；重构 SettingsPanel 聚合 props 传递。
- **CSS 通用样式表**：新增 `app-layout` / `forms` / `cards` 通用样式表；扩展 `TitleBar.css` 通用顶栏类。

### 问题修复

- 修复 `tsconfig.json` 未完整排除移动端源码导致 `tsc` 检查废弃代码的问题。

---

## v0.0.1 — 2026-07-17

> 本版本对应历史 v0.5.1。安装包按 CPU 架构拆分发行，单架构体积下降超 50%；并补齐多开、自启、数据迁移、缓存 / 下载管理等实用能力。

### 重要更改

- **安装包按架构拆分**：x64 与 arm64 各出一个独立安装包，单架构体积从 180 MB 降至 78 MB（-56.6%），下载更快、占用更小。arm64 包在 x64 系统上运行时会弹窗提示，引导下载正确版本。

### 新功能

- **AI 应用多开与拖拽排序**：同一 AI 平台支持同时打开多个独立实例（如同时登录两个豆包账号），通过「复制」快速克隆配置，登录状态互不干扰；切换器、底部栏、设置面板均支持拖拽调整顺序。
- **开机自启动**：设置面板「通用」分区新增「开机自启动」开关，附带「静默启动」选项，自启后隐藏到托盘不弹出主窗口。
- **跨设备数据迁移**：设置面板「关于」分区可导出 / 导入完整数据包（含对话记录、登录状态和个性化设置），新设备导入后无需重新登录。导出支持细粒度选项，避免冗余体积。
- **缓存与下载管理**：新增缓存清理（手动 + 每日 / 每周 / 每月自动），仅清缓存保留登录；文本 / 代码文件可下载到指定目录，支持每次询问或自动保存。
- **浏览器文件拖拽导入**：将文件拖入窗口即可自动注入当前 AI 应用，三层兜底策略兼容智谱清言等延迟挂载输入框的平台。
- **Alt+Space 触发阈值可自定义**：设置面板「热键」分区新增次数配置（默认 6 次，范围 3-20），时间窗口随阈值自动放大，避免误触恢复窗口位置。
- **弹窗白名单机制**：连续 3 次拒绝弹窗后自动提示加入白名单，避免反复拦截登录 / OAuth 弹窗。

### 体验优化

- 清理设置面板内冗余的描述性说明文字，保留危险操作的二次确认提示与动态状态反馈。
- 设置面板折叠区块（AI 应用、设备预设）标题样式统一，展开 / 收起箭头反馈更清晰。
- 全部页面更新至 v0.0.1 版本标识。
