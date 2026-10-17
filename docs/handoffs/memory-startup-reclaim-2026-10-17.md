# 重启高占用与回收保护范围修正（2026-10-17）

用户重启后截图为 Electron 13 进程、1410.1 MB，CPU 5.3%、磁盘 7.7 MB/s。截图没有 PID 或完整列名，不能把某一行直接认定为 GPU，也不能直接与含共享页的整树工作集比较。

## 实际运行与问题范围

只读核对运行入口为 `E:/SidekickAI/node_modules/electron/dist/electron.exe .`，主进程 PID 3440、创建时间 2026-10-17 13:05:12；使用 `.app-data`，低内存模式已打开。13:08:28–13:08:34 的三次原生 EX2 采样中，完整 14 进程树（包括助手）的总工作集为 147.2、150.7、184.6 MiB，私有工作集 78.3、81.8、109.9 MiB，私有提交约 1460–1461 MiB。采样没有清理、注入、调试连接或切换窗口。证据：`local/restarted-live-composition.json`。

这些是旧候选运行中的后续样本，不能归功于本轮改动；也不能据此证明启动或长期达标。它们说明重启后的高占用会回落，需要缩短不必要的等待，而不是把截图的 1.4 GB 当成不可回收的常驻下限。

现有监控把任意 webContents 的 loading、audible、capture、media-playing 都作为全应用保护。一个慢资源可持续保护所有其他空闲进程。隔离的生产浏览器夹具用本机 HTTP 图片响应保持真实加载，旧候选的 12 次保护快照均显示同一主窗网页 loading=true，actions=0。`local/resident-ab-d1Algy` 保留 29 条整树样本，但该次夹具在收尾读取 isLoading 时发生竞态，报告为 ERROR；只作为阻塞机制证据，不作功能或容量验收。

## 产品修改

- `resident-memory-policy.ts` 增加逐进程保护；下载、导入、导出、备份、流式资产、预览、全屏等应用级保护继续覆盖整批。
- `resident-memory-monitor.ts` 记录内容 PID、guest 类型和窗口归属。已证明完全属于一个未聚焦窗口的渲染进程，可与其他窗口的加载或媒体分开判断。
- 同窗中完全独立的 guest 进程仅受自身加载/媒体保护；受保护 guest 的进程、所属界面进程和共享 GPU/服务仍受保护。混合承载、未知归属和聚焦窗口不获得该例外。
- 每次原生调用前重新读取内容保护、窗口归属及活动时间。同窗任意输入仍保护同窗全部进程。CPU 限制、15/20/30 秒空闲、回涨退避、原生输入检查、批次上限与窗口退役时间维持原值。
- 已加载页面持续挂载，仍使用自身进程的 Windows 工作集清空，不清理系统缓存列表。

## 验证与边界

第一阶段仅按窗口区分保护，`local/resident-ab-ayPU41/report.json` 为 FUNCTIONAL_PASS：同一网页持续 loading 的 12/12 次快照期间，18 个其他窗口的 Tab 进程被回收；加载网页、其界面及共享进程没有回收。十窗点击、滚动、草稿与双 rAF 通过，加载页释放响应后在同一 webContents 完成。该阶段不是最终构建。

最终构建的 `local/resident-ab-ogLfUC/report.json` 为 FUNCTIONAL_PASS：十个生产 detach 浏览器窗口、保留主窗中的加载页和独立兄弟标签，另一个浏览器窗口连续接收原生注入输入。加载保护 12/12 次；19 次成功回收全部为允许的后台 Tab；没有回收加载页、其界面、共享服务或持续输入的两个进程。兄弟标签确实被回收，随后身份、草稿与可见双 rAF 均保留。

该最终场景采样总工作集由 3591.7 降至 1934.9 MiB，最低 1539.9 MiB、后半段中位数 2053.6 MiB、末次提交 1507.6 MiB。它是 45 秒本机受控页面的功能诊断；不代表真实 AI 页面、长期容量或 300 MiB 标准态。十窗滚轮到实际滚动 P95 35 ms，交互总耗时 P95 234 ms。27 个采样身份均正常退出，无残留。

夹具新增 `--loading-peer`（配合 `--browsers`），可复跑：`node scripts/verify-resident-memory-ab.mjs 45 --enabled-only --functional --browsers --loading-peer --active-input`。收尾等待 did-stop-loading，随后验证加载页及同窗兄弟标签；失败也清理测试实例。没有 CDP、录屏或物理键盘延迟声明。

最终源码 `npm run verify` 通过：190 项工具测试、196 文件 1569 项 Vitest，包含未知/混合归属、同窗独立与共享 guest、静音媒体、调用间状态变化等回归。构建日志 `local/reclaim-scoped-build.log`、校验日志 `local/reclaim-scoped-verify.log`。最终编译产物及逐文件哈希保存在 `local/resident-ab-ogLfUC/build-artifacts.zip` 和 `build-artifacts.json`，与该报告的产品哈希一致；源码快照同目录保留。

最终构建还通过真实静音双视频验证 `local/resident-media-GBHpDr/report.json`：两个播放器运行 30 秒、暂停其中一个后再运行 20 秒，期间没有成功回收；全部暂停后恢复回收，页面身份和草稿保留。未连接调试器或捕获屏幕。

严格的标准态（包含启动）<300 MiB 目标尚未达成。第一阶段单窗功能测试 `local/resident-ab-JlhlzZ` 采样最高 776.3 MiB，回收后末次 208.9 MiB，功能通过、容量 FAIL；回收后的末次值不能代替启动和持续验收。

首次最终构建 120 秒单窗测试 `local/resident-ab-PMAF7h` 保留为 INVALID：第二轮开始时窗口可见但失焦，产品快捷键第一按正确执行聚焦，夹具却立即把它当作应隐藏的一按，导致 `hidden=false`。其内存样本不能作为通过验收。夹具已在可见失焦时先走原快捷键聚焦并等待完成，再测试隐藏；没有修改产品快捷键、删除校验或直接调用 hide 来掩盖问题，额外准备耗时单列 `focusPreparationMs`。

修正夹具后的最终 120 秒单窗报告 `local/resident-ab-87aWkF/report.json` 为 MEASURED：默认真实 DeepSeek 页、11 条整树样本、9 次成功内置回收、两轮实际快捷键回调隐藏/呼出及同一 shell/guest 双 rAF 通过，0 错误、6 个采样身份退出且无残留。采样最高 755.3 MiB，末次 175.7 MiB；后半段中位数 223.0 MiB、P95 235.3 MiB，末次私有提交 354.4 MiB。呼出往返 P95 17 ms、双 rAF P95 44 ms。它证明该两分钟负载中回收后可以维持较低驻留，不证明长期或其他页面负载。采样最高值已超过 300 MiB，因此标准态容量仍 FAIL；缺失的启动瞬时样本也不能被当成低于该值。与十窗报告及归档逐一核对产品文件哈希相同。

产物归档 SHA256：`41437b1e30686893abb8a6a6bd31aed40ca7fadf6a1b09a921097d65d76f66f3`，153 个文件。没有复制安装候选或构建发布包；用户当前运行实例未关闭，最新 `out/` 在下次以该入口启动时生效。
