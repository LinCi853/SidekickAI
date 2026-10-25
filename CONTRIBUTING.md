# 贡献指南

## 工作范围

本仓库维护工百窗概念版，目标是把已有工具打磨得更方便。先读 [README](README.md) 了解功能与使用条件。安全问题按 [SECURITY.md](SECURITY.md) 私密报告；大范围行为或接口调整先通过 Issue 说明目标、范围和可验证的结果。

代码、标识符和注释使用英文，用户界面优先中文。注释解释概念和约束，不记录开发过程；不顺带格式化无关文件。渲染依赖放在 devDependencies，主进程运行依赖放在 dependencies；IPC 使用已有校验和受限 preload 接口。

## 本地开发与验证

使用 Windows、Node.js 和附带的 npm；准确兼容要求以 package.json 的 engines 为准。依赖以根目录锁文件为准。

开发建议使用项目根目录的 `launch.bat`，按菜单提示操作。不要手工改写锁文件来绕过依赖问题。

验证区分源码、桌面和软件打包回归。处理缺陷先建立可观察的失败场景，完成修复后验证关键路径；涉及数据库时使用独立临时数据。文档改动检查链接、命令和现行事实。

## 分层架构与门禁

主进程代码按四级分层组织：一级是 platform 基础服务（window / hotkey / security 等），二级是 window 容器与内嵌浏览器域（electron/browser），三级是 modules/plugins 内置插件；入口与装配文件不受层约束。完整的层级、域与规则定义以 [contracts/architecture-layers.json](contracts/architecture-layers.json) 为单一事实来源，本节不复制其内容。

三条机器门禁接入 `npm run verify`、`prebuild` 与 CI，违反即失败：

- `architecture:check`（scripts/architecture-check.mjs）：校验分层导入、进程边界与依赖环。豁免记录在 scripts/architecture-baseline.json，为只减不增的棘轮；有意消除某条边后随本次修改删除对应条目，不让豁免累积。`layerCrossings` 必须保持为空。
- `deadcode:check`（scripts/deadcode-check.mjs）：包装 knip 检查未使用文件、依赖、导出与类型。基线在 scripts/deadcode-baseline.json，同样只减不增；清理后用 `npm run deadcode:check -- --prune` 收紧。新死代码要么删除，要么在说明理由后显式入基线。
- `format:check` 与 `lint:check`（Biome）：风格由 biome.json 统一（单引号、无分号、行宽 100），lint 启用 correctness 规则组。提交前 `npm run format`；为误报关规则改 biome.json 全局配置，不留行内豁免注释。

## 公共源码与文档

产品版本以当前工作区 package.json 为准；共用品牌与路线身份由 packages/product-contract 管理。涉及共享软件代码时，核对 contracts/shared-source.json，并通过已有产品和共享检查；不要覆盖其他工作区的修改。

本仓构建双架构绿色版和逐架构标准应用载荷 ZIP，载荷随附文件清单、大小与 SHA-256。完整包入口通过固定版本与摘要的二进制待组装包生成 x64、ARM64 离线安装器，为与自建版本区分，官方发布采用密钥加密软件；自建版本的具体操作由 launch.bat 菜单提供，接口见 [二进制组件说明](media/formats/distribution-toolkit.md)。自行构建身份保留在忽略的本地目录，不能提交或公开；安装、卸载与恢复不依赖构建机上的身份文件。

官方预构建产物和校验和从发布页取得。官方发行的信任根和公众自行构建身份分别维护，不能互相冒充或直接覆盖安装；第三方也可自行开发安装维护实现，公开依据是 [SKSETUP3 纯格式说明](media/formats/SKSETUP3.md)。安装、卸载与独立恢复的实现源码不纳入本仓。

用户可见的功能和入口变化同步更新 README 与 CHANGELOG，示例操作必须与实际入口一致。README 保持长期、明确的功能介绍；公开格式说明作为接口文档维护，内部规格、调研、测试报告与交接资料另行保管，不纳入公开提交。完成后独立审查并简化重复逻辑。

## 仓库流程

维护者在现有 main 工作，提交前检查差异并保护已有未提交内容。外部贡献如采用 PR，应说明问题、最终行为和实际验证范围；CI 通过不能代替最终包验收。

提交保持单一主题，使用 Conventional Commits，例如 `fix(backup): preserve application data`。提交、PR 正文和代码注释不写工具署名或开发进度标签。公开源码维护授权不等于二进制上传、社区版公开或个人安装升级授权。

## 不纳入源码

运行数据、浏览器 Profile、Cookie、数据库、凭据、.env、编译缓存、发行文件和本地验收证据不进入提交。以 .gitignore 为准。

贡献采用 [MIT License](LICENSE)。
