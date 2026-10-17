# 内存优化源码清理与 x64 正式打包

2026-10-17。按用户要求清理停用试验，保留已经验证的有效优化，并由 `E:/ShenQu/AnvlQ` 组装官方 concept 0.1.6 x64 安装器。

## 源码状态

- 清理前完整脏源码及 binary diff 已归档到 `local/cleanup-release-20261017/source-before-cleanup.zip`。本轮删除 27 个停用实现/试验文件，不丢弃原有网站、语音、焦点等其他修改；未执行 Git stage、commit 或 push。
- 删除标签冷卸载、截图占位、预算驱逐、最小宿主和 Node addon 原型，以及对应的构建、IPC、类型和无用测试。移除无调用方的主动窗口释放 IPC。
- 使用 `DeferredTab` 延迟首次加载；已经加载的网页持续挂载。进程优先级独立为 `useTabProcessPriority` 与 `runtimeProcesses.syncPriority`，不再借用休眠接口。
- 历史休眠数据仅保留只读统计和已有缓存清理。快照占用统计实际图片磁盘字节，不再提供截图写入/恢复接口。
- 保留自身进程驻留回收、原生前台与进程身份校验、输入/加载/媒体保护、原有窗口退役资格与时长、快捷键说明遮罩停止绘制和独立 preload 构建。开发者低内存开关仍默认关闭。
- 主交接、三态设计和最小宿主文档已标注当前交付边界，历史证据继续保留。

## 验证

- 应用 `npm run verify`：190 项工具测试、191 个 Vitest 文件 / 1515 项测试通过；最终源码类型检查和正式构建通过。
- AnvlQ `npm run verify`：106 项契约测试、22 个界面测试文件 / 183 项测试通过；产品与共享源检查通过。
- 最终标准载荷构建：`build/distribution-runs/concept/release-20261017-x64/verification-Rhc61B`。打包后的主窗口、设置页、SQLite、键盘钩子及原生架构检查通过；UI 报告在其 `application/packaged-ui/report.json`。
- 最后移除一处废弃的截图超时常量后重新构建；最终标准 manifest 与 AnvlQ 已冻结输入逐字节相同，载荷 ZIP 的 SHA256 同为 `64605187dcf30204c6f6af43fe2a188d2c9d1d9f0367c890ccd029c92a559419`。143 个打包运行时文件与功能短测构建逐项匹配；最终源码指纹 `95afca5ecc00be8df9ca0341ac5f4b691ee495017f73244bcb90a3e1921fc628`，见 `local/cleanup-release-20261017/final-build-match.json`。
- 运行进程页实际 UI：`local/runtime-processes-ui-20261017/run-TwIEQM/report.json`。确认旧变更 IPC 不再暴露、工作集合计等于同次原始采样之和；4 条无图历史记录显示 0 B，加入测试图片/孤儿文件后正确刷新至 2 张 / 198 B；680 px 窗口无溢出、页面错误为零。
- 十浏览器 + 慢加载兄弟页 + 持续输入：`local/resident-ab-auiRrr/report.json`，`FUNCTIONAL_PASS`；19 次成功回收、10 次交互无错误、27 个进程身份退出无残留。短测数值用于功能回归，不能替代长期内存验收。
- 真实静音双视频：`local/resident-media-VzW7rq/report.json`，`PASS`。仅暂停其中一个仍保护工作集；全部暂停后恢复回收，网页未重载、草稿保留。

标准态包含启动峰值低于 300 MiB 的目标仍未达成，最小态未正式接入。此次交付不将短测通过解释为完整容量目标达成。

## 打包与交付

打包使用标准应用载荷及明确的产品 descriptor；AnvlQ 冻结自己的组装源码，核对载荷与逐文件哈希后使用既有官方证明流程。未安装到个人环境、未触发 UAC、未停止用户正在运行的应用、未对外发布。

AnvlQ 构建时下载已固定版本的 Node.js 许可证遇到连接重置；从相同的上游版本地址重新下载后，SHA256 与既有缓存一致，再通过原冻结工作区的标准组装入口继续。平台正式源码没有修改。

沿用 AnvlQ 已有批准配置，在线服务 origin 为 `http://localhost:4318`。官方分发证明使用现有受控材料；Windows Authenticode 状态另外记录，不能把分发证明等同于 Windows 代码签名。

最终安装载荷重新启动检查通过，报告在 `local/cleanup-release-20261017/official-packaged-ui/report.json`；安装器向导也由 AnvlQ 启动确认已渲染内嵌界面。没有执行真实安装。

交付目录：`E:/ShenQu/AnvlQ/release/0.1.6/x64-20261017-final/`，保留原同版本旧包，不覆盖。

- 安装器：`SidekickAI-Setup-0.1.6-x64.exe`，196159266 字节（约 187.1 MiB）。
- SHA256：`0f60991a58cb10dd9847d1baa0a761ec1c1807859553816e260f0edc9f1dbd41`。
- 官方分发证明与逐文件校验通过；AnvlQ 源码冻结前后保持一致，组装结果 `verified: true`、`complete: true`，仅包含 x64。
- Windows Authenticode 实测 `NotSigned`，当前没有 Windows 代码签名证书；不能将此包描述为已完成 Windows 代码签名。
- 交付目录附 `SHA256SUMS.txt`、`delivery.json` 和 `evidence/`，包含源码指纹、标准载荷 manifest、静态验证与最终 UI / 功能回归证据。

最终复制后及会话结束执行两仓 `npm run clean:budget`：SidekickAI 为 7.09 GiB，AnvlQ 为 13.00 GiB，均低于 15 GiB。结果记录在 `local/cleanup-release-20261017/budget-final.log` 与 AnvlQ 的 `local/sidekick-budget-final-20261017.log`。
