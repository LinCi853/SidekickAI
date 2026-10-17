# 内存优化接管交接（2026-10-17）

## 1. 当前状态与接管范围

已按接管要求停止新增实验、构建和产品修改；不继续扩展最小宿主路线。保留现有工作树、全部原始成功及失败证据，不回滚、不提交、不推送。交接收尾仅做只读核对、写本文和会话结束磁盘预算清理；没有为交接重跑完整回归。

**三态目标尚未完成。** 原目标为启动及标准态 <300MiB、最小态 <70MiB、十非浏览器主窗 ≤1GiB、十浏览器窗口 ≤5GiB，游戏另测。短测的 FUNCTIONAL_PASS 或原型占用低于70MiB均不代表产品验收通过。原持续优化目标暂停，交给接管方继续判断。

接管主线：先使用同一构建、同一统计口径，拆解最小 Electron、产品壳、后台服务、真实网页各自的启动成本，暂时收敛回收参数试探和宿主架构分支。已有 GPU 参数实验未显示收益，不应直接采用。

继续遵守已确认约束：

- 页面保持挂载、无冷卸载、无截图占位、无“点击恢复”；用户看到页面时应已恢复。
- 开发者选项仅保留默认关闭的一个低内存模式开关。
- 不改变既有窗口退役资格、主窗行为及10分钟/30分钟等生产时长。
- 仅回收本软件进程；不清空系统 standby/cache，不操作其他应用。
- 用户允许缩短隔离功能测试中的长等待，以先验证流程；不能把短测当作持续容量验收。
- 整树工作集含共享页重复计数、原生助手及可能存在的 conhost；私有提交单列。不要用最低值替代启动值、持续值或实际分配需求。
- `build/` 上限15GiB；构建前、交付复制后和会话结束执行 `npm run clean:budget`，超限必须先处理。

## 2. 成果、修改边界与构建身份

### 已验证产品候选

最后一次成功产品构建及完整检查日志：

- [构建日志](../../local/resident-inclusive-build.log)
- [完整检查日志](../../local/resident-inclusive-verify.log)：195个文件、1559项测试通过，工具链190项通过。
- 原生助手8项测试此前通过；这不是本次 GPU/Node 新诊断的完整回归结论。

产品回收相关改动：

- `electron/diagnostics/resident-memory-monitor.ts`：每批上限从4个提高到8个进程，保留150ms批次预算；每次原生调用前重新检查输入、开关、任务保护及进程归属。
- `tools/startup-helper/ForegroundBridge.cs`：使用 `SetProcessWorkingSetSizeEx(-1,-1)` 清空自身工作集。仅全局空闲 T 请求成功后，才可能顺带回收助手自身；后台 renderer 独立请求不会回收共享助手。助手自身至少间隔60秒、工作集至少16MiB，且调用前再次核对原生输入。
- 原生桥 detached 启动，不再产生 conhost；无控制台时以 UTF-8 StreamReader/Writer 通信，EOF退出。
- JS/原生生产空闲20/30/15秒、冷却和退役时长未因快速测试而修改。更早轮次已有的退避、身份校验和工作集保护成果继续保留。

构建与证据对应关系：

- 正式助手 SHA256：`62d3a40135707044608ef812c268abe66799ad56b0a94eb5c2d873f21cb6cf2a`。
- shared manifest revision：`429be22ad62537ed72cf891e95b4654b123571ee8610a22888910d9b3ac03533`。
- [构建归档索引](../../local/resident-ab-QcAnrx/build-artifacts.json)和 [build-artifacts.zip](../../local/resident-ab-QcAnrx/build-artifacts.zip)，归档 SHA256：`badfff3e38a08c3d038f00919c0606c190eb42fc7df596a59f03907b8b04b035`。这是构建证据归档，不是安装包。
- 收尾只读核对：索引中145个文件全部与当前文件匹配，drift为空；归档哈希也匹配。前轮已核对这些文件同时对应 J7pXfY、QcAnrx 两份报告。
- 本轮 GPU/Node 宿主诊断没有重建产品 `out/`。不能把源代码后续诊断变化解释成产品候选已经重新完整验收。

### 本轮 GPU 诊断新增内容（未纳入完整回归）

- `scripts/resident-memory-fixture.cjs`：可选 `SIDEKICK_MEMORY_GPU_DIAGNOSTICS=1`，采集 GPU feature status、`app.getGPUInfo('complete')`、shell/guest JS heap、canvas/video/运行动画与 bounds。
- `scripts/verify-resident-memory-ab.mjs`：新增 `--gpu-diagnostics`、诊断用 `--gpu-cache-kib 128..16384` 和 `--gpu-angle d3d11|gl|d3d11on12`，报告以 `gpuExperiment` 明确记录实验。
- 没有修改生产 main 的 GPU 启动参数；没有修改 DrawerPanel、ShortcutsModal 等产品组件或 CSS。

### 纯 Node 宿主实验（停止扩展，仅保留成果）

新增文件：

- `tools/minimum-host/HotkeyAddon.cc`
- `scripts/build-minimum-addon.cjs`
- `scripts/verify-minimum-node.cjs`
- `scripts/minimum-addon.test.cjs`

路线是在同一 Electron exe 下设置 `ELECTRON_RUN_AS_NODE=1`，不初始化 Chromium；Node-API v8 addon 的独立消息线程仅注册指定 `RegisterHotKey(MOD_NOREPEAT)` 快捷键，复用真实 `packages/desktop-common/edition-session.ts` 的隔离 bundle。没有产品入口、正式资源复制或 npm script 接入，没有修改产品 edition/admission/installer 协议。

构建使用 VS18 MSVC、Electron43.7.9本地 headers、node-gyp，目前仅 x64。构建器先清预算，产物仅在 `build/native-minimum-addon/`。

**验证边界：**只在开发 Electron exe、`SIDEKICK_TEST_SESSION` 隔离环境验证；没有已打包 SidekickAI.exe、安装器/跨版本/权限切换、正式进入最小态及完整保存取消、ARM64 验收。不要据此宣称最小态已接入产品。旧 .NET 原型也保留，参见 [minimum-host-integration.md](minimum-host-integration.md)，其中不同 exe 的身份接入要求属于旧 .NET 路线，不能直接套成 Node 路线已经解决所有产品问题。

## 3. 可依赖证据与原始失败

### 产品回收联调

| 证据 | 已验证结果 | 限制 |
|---|---|---|
| [J7pXfY](../../local/resident-ab-J7pXfY/report.json) | FUNCTIONAL_PASS；16样本、5次回收、2次交互、0错误；最低152.410MiB，呼出后末次236.629MiB，末次私有提交531.434MiB；暖回调P50/P95为13/18ms，双rAF为32/51ms | 启动峰值893.352MiB，启动预算仍FAIL；末次236.629不是启动值，短测不证明长期保持 |
| [QcAnrx](../../local/resident-ab-QcAnrx/report.json) | FUNCTIONAL_PASS；十生产 detach 浏览器加保留主窗，使用本地页面；30样本、10次点击/真实滚动/草稿/身份/双rAF通过；20次回收全部针对后台Tab；峰值4227.398MiB、末次2144.875MiB、提交1850.871MiB | 45秒功能场景，不代表真实AI长期负载5GiB验收 |
| [LgrvnA](../../local/resident-ab-LgrvnA/report.json) | 每组300秒、后台持续输入；后半工作集中位数3465.2→1821.8MiB，P95 3657.5→2018.3；35次后台Tab回收，两组各60次交互无错误 | 私有提交1879.3→1927.0MiB，未同步下降；旧候选长测不能直接替代新候选持续验收 |
| [静音双视频](../../local/resident-media-W2Dhcs/report.json) | PASS | 仅所记录媒体场景 |
| [桌面/加密备份恢复](../../local/desktop-verification-s4CoRp/report.json) | ok=true | 仅所记录恢复场景 |

J7pXfY：助手末次1.859MiB、网络进程9.484MiB；无 conhost，6个采样身份退出后无残留。QcAnrx：[foreground-audit.json](../../local/resident-ab-QcAnrx/foreground-audit.json)记录42次前台脉冲、44次确认；前台壳/guest及主/GPU/网络均未被回收，助手23.35–24.41MiB，未触发自身回收；双rAF P50/P95为33/35ms，滚轮34/36ms，最大36ms；无 conhost，26个采样身份退出后无残留。

必须保留的其他记录：

- `local/resident-ab-VCTfkT`：旧4进程批次短测末次319.97MiB，网络64.7MiB、助手24.3MiB未被清理。
- [uKGGop失败](../../local/resident-ab-uKGGop/report.json)：测试把 hide/show 间隔缩为100ms后触发现有快捷键防连触发；已恢复测试间隔1秒。不能继续缩短到破坏真实防抖语义。

### GPU 参数诊断

| 证据 | 诊断条件 | 峰值/末次MiB | 结论 |
|---|---|---:|---|
| [e9kVas](../../local/resident-ab-e9kVas/report.json) | 最早 basic GPUInfo | 840.27 / 约839 | 基础信息含占位，不能据此认定实际后端；3次交互通过 |
| [TdLRHr](../../local/resident-ab-TdLRHr/report.json) | complete GPUInfo，程序缓存128KiB | 974.39 / 917.75 | 提交603.28MiB；3次交互通过，未显示改善 |
| [FQD3tf](../../local/resident-ab-FQD3tf/report.json) | complete GPUInfo，默认参数控制组 | 958.75 / 937.86 | 提交628.57MiB；3次交互通过 |
| [cZeYqV](../../local/resident-ab-cZeYqV/report.json) | complete GPUInfo，ANGLE gl | 1059.50 / 1021.90 | 提交713.39MiB；3次交互通过，未显示改善 |

complete GPUInfo 记录 AMD Radeon780M、驱动31.0.22060.3004、ANGLE_D3D11/GaneshGL、硬件加速开启。shell heap约10MB、guest约18MB，两页没有运行动画、canvas、video，GPU进程却占数百MiB。该现象不能简单归因于JS堆。

**complete GPUInfo 诊断本身可能增加负担**；上述数值不能直接视为无诊断生产占用，也不能与其他构建混比。缩小缓存、改GL均未采用。关闭的面板仍可能以 opacity/translate 隐藏且保持挂载，仅做过源码读取，没有产品修改。

### Node 宿主成功与失败

- [裸模式探测](../../local/minimum-node-probe.json)：裸Node约32.43MiB，加载uiohook约35.75MiB，各8秒正常退出。正式候选 addon 没有使用uiohook。
- [4jcRZ0端到端原型](../../local/minimum-node-4jcRZ0/report.json)：FUNCTIONAL_PASS，5条短整树样本，峰值37.5859375MiB；唤醒到真实主界面双rAF1082ms。验证真实 edition lease、热键占用拒绝、启动失败后恢复 lease+热键、SendInput→WM_HOTKEY、真实 out main、笔记/设置/生产热键恢复；宿主退出前后都确认应用PID持有 edition endpoint。
- GUI子进程在当前原型中需 detached+unref；宿主释放 lease 和热键后，交接阶段还需额外 keepalive，否则会早退。未 detached 时观察到宿主退出后GUI消失，尚未定位到OS/libuv底层原因，不应写成确定的底层机制。
- [minimum-addon-test.log](../../local/minimum-addon-test.log)：最后 `node --test scripts/minimum-addon.test.cjs` exit0，3项通过，5521ms：注册/释放100轮；unregister取消排队通知且下一轮真实WM_HOTKEY有效；仍注册时环境退出正常并可重取OS热键。
- [minimum-addon-build.log](../../local/minimum-addon-build.log)：最近独立构建成功日志。最后 addon 测试也执行了重编译。

**二进制对应关系：**4jcRZ0报告内 addon SHA256 为 `62bdc2ef4068e9005cf699e7bda65ce6cf6f622b3d5cfd0b2d143c1646e5b924`；当前 `build/native-minimum-addon/minimum-addon.json` 为 `cba7750a3edb63a266199b159dc6ac2f2763c9d9e538814e313364aa200f5438`。源码哈希相同，但PE哈希不同，不能声称当前二进制完整复现了该次端到端报告。新增3项addon测试之后没有重跑端到端或完整项目回归；按停止要求不再补跑。

原型失败证据全部保留：

- [6rSS9h](../../local/minimum-node-6rSS9h/report.json)：宿主退出后 Incomplete edition response，GUI已消失；PID25796/15544/25824，创建时间以报告为准。
- [RJ8GWq](../../local/minimum-node-RJ8GWq/report.json)：stage=`verify-lease-after-host-exit`，同类失败；PID19960/24244/26396。
- [ROICc2](../../local/minimum-node-ROICc2/report.json)：detached+unref后仍缺 keepalive，宿主在释放 lease+热键后早退，failed-wake未恢复；PID17924/21508/失败child20816。

旧.NET宿主也未删除：[glvpqj长测](../../local/minimum-host-glvpqj/report.json)338.892秒/61样本，峰值33.406MiB，原型PASS；正式单例、安装器及产品入口未接入。两种宿主均不能替代产品最小态70MiB验收；SendInput/双rAF不能代替物理键盘/屏幕首帧。

## 4. 命令、进程及工作树归属

已知最后在跑命令均结束：`node scripts/verify-minimum-node.cjs`（session79840）exit0；最后addon测试exit0，无悬挂session。收尾 CIM 未找到本轮存活的 Electron、SidekickMinimum 或最小宿主测试进程；查询自身 PowerShell 命中不算测试残留。

最后成功Node原型的三个身份均已退出，原始 FILETIME 可用于核对PID复用：

| 角色 | PID | 创建时间FILETIME |
|---|---:|---|
| seed真实应用 | 8136 | 134366844909311870 |
| Node宿主 | 19320 | 134366844923711265 |
| 唤醒真实应用 | 20188 | 134366845002067373 |

三者映像均为 `E:\SidekickAI\node_modules\electron\dist\electron.exe`，session1，elevated；完整SID、命令行及身份见4jcRZ0报告。addon单测没有记录worker的PID/FILETIME，不能事后补造，当前未查到对应活进程。

明确保留的非本轮进程：

- esbuild PID484，父PID19428，创建于2026-10-17 11:57:17 +08。父进程是 `node_modules/vite/bin/vite.js website --host 127.0.0.1 --port 4173 --strictPort`，属于website服务，不是最小宿主残留，未停止。
- 更早常驻的 launch.bat PID13016、workspace-menu PID11432，以及 Codex CUA Node PID24216/20760 未处理。

工作树从任务开始就有大量未提交改动，**不能把全量 git status 归为本聊天成果**：

- `website/index.html`、`website/main.js`、`website/styles.css` 修改，以及未跟踪的 `website/README.md`、`website/assets/` 已确认不是本聊天所做，保留。
- `CHANGELOG.md`、`package-lock.json`、`scripts/incremental-build.test.cjs`、部分既有handoff归属混合或未完全确认，均保留。
- 跨前轮的内存设置移除、sandbox/preload、工作集保护等成果也保留；未执行全树清理、reset、checkout、commit或push。
- `local/`原始报告、日志和失败目录保留。预算清理遵循既有脚本，不自行删除这些证据。

会话结束执行 `npm run clean:budget`；本次结果记录在 [结束预算清理日志](../../local/memory-takeover-clean-budget-2026-10-17.log)。上次清理为6.09GiB，本次以该日志为准。交接后不要把旧日志数字当作未来构建占用。

## 5. 接管后可用入口与未完成项

以下仅供接管方后续使用，本次停止收尾没有运行：

- `npm run test:minimum-host`：旧.NET原型，默认5秒待机。
- `npm run test:memory-flow`：30秒标准交互功能流程。
- `npm run test:memory-reclaim`：最多45秒，真实空闲→回收→呼出，满足条件提前退出。
- `npm run test:memory-browsers`：45秒十浏览器持续输入功能场景。

Node宿主未接入npm script。继续采用短功能流程和独立持续验收，避免为每次修改重复等待；不要改变生产退役、输入保护、防抖和空闲条件来制造通过。

未完成的主要问题：启动成本拆解、启动/标准态300MiB、产品最小态70MiB、十非浏览器主窗生产验收、真实AI长负载十浏览器、低内存机器、普通权限与跨权限交接、物理键盘/屏幕首帧；另有偶发窗口visible但document.hidden/停帧和旧GPU提交异常尚未解决。

可结合 [内存报告](memory-optimization-memory-report.md)、[回收调研](memory-resident-research.md)、[三态约束](window-memory-states.md) 阅读；较早文档中的旧策略和旧测量要结合本文及对应原始报告判断，不能把不同轮次结果拼成同一候选的验收结论。

**已停止写入，可以接管。**
