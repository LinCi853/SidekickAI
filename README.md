# 工百窗 / SidekickAI

> AI 时代的个人操作台 — 省时间，不绕路

不是 AI，不是 AI 开发工具，而是你操作 AI、管理事务、节省时间的一站式平台。

## 定位

AI harness（Claude Code、Cursor、Codex）让 AI 替开发者写代码。工百窗让**所有人**更高效地使用 AI、管理自己的工作。

| | AI harness | 工百窗 |
|---|---|---|
| 目标用户 | 开发者 | 所有使用 AI 的人 |
| 核心交互 | 代码、终端 | 任务、时间、项目、对话 |
| AI 角色 | AI 替你干活 | 你驱动 AI，工具帮你省时间 |

## 设计原则

- **省时间** — 每个功能都在减少操作步骤、降低上下文切换成本
- **一站式** — 任务、时间、AI、笔记、项目管理在一个地方完成
- **用户驱动** — 你决定用什么 AI、怎么组织工作，工具不替你思考
- **本地优先** — 数据在本机，语音在本机，不依赖云端

## 核心能力

### 记录与笔记

- 灵感笔记：随时记录想法，不影响当前工作
- 对话历史：所有 AI 对话本地落库，可搜索可回溯
- 白板：整合多源信息，截图、文字、绘图自由组合

### AI 聚合与交互

- **多 AI 平台聚合**：内置 Kimi、DeepSeek、智谱清言、豆包、通义千问、文心一言、ChatGPT、Claude、Gemini 等预设，支持自定义接入
- **多账号隔离**：每个 AI 平台独立 Profile，同一平台可同时登录多个账号
- **语音输入**：`Alt+V` 后台语音，直接注入当前 AI 输入框
- **页面冻结与复制**：冻结后精确选择复制文本，防撤回场景一键抓取
- **智能屏蔽**：自动隐藏 AI 平台的下载引导、升级横幅、原生弹窗
- **提示词管理**：模板库 + 三段注入 + 发送前预览
- **反检测指纹**：可自定义设备指纹，避免被平台识别为同一设备

### 交互体系

#### 全局快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+Space` | 一键呼出 / 隐藏主窗口（触发阈值可自定义，避免误触） |
| `Alt+Q` | 切换进阶面板显隐 |
| `Alt+V` | 后台语音输入（按住说话，松开发送；默认禁用，需在设置启用） |

#### 软件内快捷键

| 快捷键 | 功能 |
|---|---|
| `Alt+1` ~ `Alt+9` | 切换到第 N 个标签 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 向前 / 向后循环切换标签 |
| `Ctrl+T` | 脱离当前标签为独立窗口 |
| `Ctrl+W` | 主窗口：关闭当前标签；独立窗口：关闭整个窗口 |
| `Esc` | 独立窗口：先关闭打开的浮窗（设置 / 抽屉 / 弹窗等），无浮窗时关闭窗口 |
| `F4` / `F5` / `F6` | 后退 / 刷新 / 前进 |
| `F10` | 切换主题 |
| `F12` | 切换窗口置顶 |
| `` ` `` / `~` / `?` | 呼出 / 关闭快捷键说明面板 |
| 长按 `Tab` | 切换底栏（展开 ↔ 收起） |
| `Ctrl+G` | 网页空间导航开关 |

#### 窗口与界面

- **多标签主窗口**：顶栏 + 标签栏 + 多 webview + 底栏应用抽屉，标签栏与底栏默认抽屉式收起，悬停展开
- **脱离窗口**：任意 AI 应用可脱离主窗口独立运行，支持置顶、最大化
- **桌面 / 移动 UA 切换**：窄屏自动切换移动端 UA，也可手动三态切换
- **三档 UI 缩放**：紧凑 / 中档 / 大号
- **AI 切换器按最近使用排序**：自定义供应商按最近使用时间排序，最常用的排在最前

### 数据与隐私

- **跨设备数据迁移**：导出 / 导入完整数据包（含对话记录、登录状态和个性化设置），新设备导入后无需重新登录
- **缓存与下载管理**：缓存清理（手动 + 每日 / 每周 / 每月自动），仅清缓存保留登录；文件可下载到指定目录
- **文件拖拽导入**：将文件拖入窗口即可自动注入当前 AI 应用

### 外观与个性化

- **主题模式**：浅色 / 深色 / 跟随系统
- **平台主题色**：每个 AI 平台可自定义主题色，底栏切换器同步显示色点
- **顶栏按钮自定义**：6 组按钮按需显隐
- **关闭行为可选**：直接关闭或最小化到托盘

### 网络与代理

- **代理模式**：系统代理 / 直连 / 自定义
- **协议支持**：HTTP / SOCKS5，提供认证与地址绕过
- **连通性测试**：一键测试代理可用性

## 快速开始

推荐使用项目根目录的启动脚本，菜单式操作：

- **Windows**：双击 `launch.bat`

脚本已内置国内镜像配置，无需手动设置环境变量。

## 开发构建

### 环境要求

- **Node.js** ≥ 20（开发环境为 Node 22 / npm 10）
- **Windows**：本项目当前仅支持 Windows 桌面端（x64 / ARM64）
- **Rust 工具链**：仅构建 Tauri 单文件安装器时需要（edition 2021）

### 常用命令

```bash
npm install                    # 安装依赖（postinstall 用 electron-rebuild 重建 better-sqlite3 / uiohook-napi 原生模块）
npm run dev                    # 开发模式启动
npm test                       # 单元测试（Vitest）
npm run typecheck              # 类型检查（tsc --noEmit）

npm run build:win-x64          # 构建 x64 免安装目录 → dist/win-unpacked
npm run build:win-arm64        # 构建 ARM64 免安装目录 → dist/win-arm64-unpacked
npm run build:win              # 上两者顺序执行
npm run build:portable         # 便携版
npm run build:tauri-installer  # 构建单文件安装器（向导 exe + 载荷自解压）
```

安装器载荷包含 x64 与 ARM64 两个架构的产物，因此构建安装器前需先产出双架构目录（`npm run build:win`）。

> 构建安装器前还需要单独安装向导子项目的依赖：`cd installer-tauri && npm install`（该目录是独立的 npm 子项目，有自己的 `package-lock.json`）。
>
> 说明：`build/tools/7zr.exe` 为运行时解压载荷所需，已随仓库分发（见下方 7-Zip 署名）。

## 商标声明

本项目为用户侧 AI 操作工具，不隶属于所聚合的任何 AI 服务提供商。所有第三方平台名称、Logo、品牌标识（包括但不限于 ChatGPT、Claude、Gemini、豆包、文心一言、Kimi、通义千问、智谱清言、DeepSeek、Mimo、Grok、Perplexity 等）均为各自所有者的注册商标，本项目不持有、不主张任何权利。

- 应用内仅使用平台名称的**首字母 + 自定义渐变色**作为视觉标识，未内置、未分发任何平台 Logo 或商标图形
- 项目仅提供 URL 聚合与浏览器隔离能力，所有 AI 服务的实际使用需用户自行遵守对应平台的服务条款（ToS）
- 用户基于本项目产生的任何商业活动，应自行确认与所涉及平台的合规性

## 开源依赖

本项目基于众多开源组件构建，关键依赖许可证如下：

- **MIT**：Electron、React、Excalidraw（白板组件）、better-sqlite3、electron-store、undici、adm-zip、uiohook-napi、Tiptap、Vite、Zustand
- **Apache-2.0**：opencc-js
- **ISC**：lucide-react（图标库）
- **BSD-3-Clause**：highlight.js（代码高亮，二进制分发需保留版权声明）
- **(MPL-2.0 OR Apache-2.0)**：DOMPurify（HTML 消毒，本项目选择适用 Apache-2.0 分支）
- **LGPL-2.1-or-later**：7-Zip 命令行 7zr（`build/tools/7zr.exe`，安装器运行时解压载荷用）

Excalidraw 内嵌字体（Cascadia、Liberation、Nunito、Xiaolai、Virgil、Excalifont 等）均为 SIL Open Font License 或同类宽松字体许可，允许商用与再分发。

> **7-Zip 署名**：本项目的安装器在运行时分发并使用 7-Zip 的精简命令行版本 `7zr.exe`（仅支持 7z 格式）。
> 7-Zip 版权所有 © 1999-2026 Igor Pavlov，以 **GNU LGPL-2.1-or-later** 许可分发；LZMA SDK 部分为公有领域。
> GNU LGPL 全文见 <https://www.gnu.org/licenses/lgpl-2.1.html>，源码见 <https://www.7-zip.org/>。
> 如需替换，可将 `build/tools/7zr.exe` 换为自行编译的同版本二进制。

完整依赖许可证清单可通过 `npx license-checker --production` 生成。

## 参与贡献

- 想改代码：先读 [CONTRIBUTING.md](./CONTRIBUTING.md)（开发环境、代码约定、提交规范）
- 发现安全漏洞：**不要提 Issue**，见 [SECURITY.md](./SECURITY.md) 的私密报告通道
- 版本变更记录：[CHANGELOG.md](./CHANGELOG.md)

## 许可证

[MIT License](./LICENSE) © 2026 LinCi853
