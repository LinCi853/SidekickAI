# 启动成本拆解与接管后的工作范围（2026-10-17）

“优化窗口三态与工作集清理”已完成交接并停止写入，后续由接管聊天继续。原始交接、成功与失败证据及文件归属见 [接管交接](memory-takeover-2026-10-17.md)。既有页面保活、单一默认关闭的低内存开关和窗口退役规则继续有效。

## 实测结果

新增 `scripts/measure-startup-cost.mjs` 与 `scripts/startup-cost-fixture.cjs`。使用同一套既有 `out/`，没有重建或修改产品产物；每组使用新的隔离资料目录和会话，无 CDP/Playwright，关闭工作集回收。每组就绪后约2.5至12.7秒内采5条整树样本，工作集含共享页重复计数和原生助手，私有提交单列。

| 层次 | 工作集中位数 MiB | 末次私有提交 MiB | 作用 |
|---|---:|---:|---|
| Electron ready，无窗口 | 211.1 | 107.9 | 当前运行时及相同 Windows 启动参数的基线 |
| 420×820 空窗口 | 343.5；复测344.8 | 169.3；169.8 | 无产品 UI、preload 或业务初始化 |
| 空窗口加产品 preload | 347.4 | 172.8 | preload 本身在此负载下增量很小 |
| 完整产品后台服务、主窗换成静态小页 | 426.9 | 220.3 | 保留实际初始化、原生助手和窗口配置，仅替换主窗文档 |
| 完整产品壳，不接入网页 | 590.6；复测597.6 | 337.0；336.1 | 实际产品主界面与服务，夹具阻止 guest 初次附加 |
| 完整产品与默认 DeepSeek 登录页 | 863.2 | 431.1 | 正常附加真实网页 |

证据：

- [五层测量](../../local/startup-cost-1Amrub/report.json)：25条有效样本，全部组正常退出，无采样身份残留。
- [服务层拆解及空窗/产品壳复测](../../local/startup-cost-oPnr3B/report.json)：15条有效样本，全部组正常退出，无采样身份残留。
- 两份报告均为 `MEASURED`、`buildUnchanged=true`；各自保存夹具与执行器源码以及所有 main/preload/renderer 的编译哈希。比较产品成本使用同一编译产物，不将夹具修改混作产品优化。
- 首次夹具退出控制通道未能工作，报告 [BISB6H](../../local/startup-cost-BISB6H/report.json) 保留为 ERROR。已改用隔离目录中的停止文件，后续各组正常退出；该次失败不是产品内存或恢复故障。

## 对优化方向的影响

1. 当前机器、Electron43.7.9、相同 Chromium 开关下，空窗口两次工作集样本全部超过300MiB。该结果表明，维持当前窗口/运行时配置时，仅削减产品业务代码不足以达到完整标准态300MiB。它是实测基线，不是所有 Electron 配置的理论下界，目标也未被放宽。
2. 产品服务层增加约80MiB驻留，助手约23MiB，主进程及网络等也有增量。此后应按服务的实际分配和初始化需求选择延迟加载，不能只依据包体积或 JS 堆推断整树收益。
3. 产品壳相对服务小页的末次私有提交约增加116MiB，其中GPU约93MiB、主界面 renderer 约21MiB。应优先归因界面的合成资源、隐藏面板及绘制生命周期，再选择单项改动验证；暂不继续试探无证据的GPU缓存参数。
4. preload 的短测增量约4MiB，没有证据支持继续将其当作数百MiB缺口的主要来源。
5. 已有后台工作集回收成果保留，停止扩大批次/冷却等调参分支；70MiB轻宿主和十窗目标单独管理，不以它们的原型/本地负载通过代替标准态验收。

## 测量边界与复用

这些是短时就绪后成本诊断，不是启动瞬时峰值、持续容量或交互验收。真实页组工作集有明显回落，不能把中位数当作某一模块稳定、不可回收的分配量。`product-services` 替换主窗文档，`product-shell` 阻止 guest 附加，均不是可交付运行方式，也未改产品页面挂载行为。

夹具代替 OS 全局快捷键注册，防止抢占用户键位；没有测试键盘、屏幕首帧、收起呼出或真实低内存机器。最小 Electron/空窗保留当前 main 的Windows Chromium开关，但不加载产品协议、日志、服务或实际UI；诊断差额包含这些初始化差异。进程树仍按PID和创建时间核对，退出阶段不采样，缺失活动Electron进程时失败。

运行 `node scripts/measure-startup-cost.mjs` 可顺序执行六层；也可指定 `window product-services product-shell` 等模式。默认每组5条样本，采样后立即退出；不改生产空闲、冷却、退役或快捷键防抖时间。每轮检查编译产物哈希未变，并核对全部已采样进程身份退出；报告保留原始字节和逐进程角色。

以上为接管时的诊断基线。后续产品改动和验证见下节；没有构建安装包或宣称三态达标。

## 首项产品优化：关闭的快捷键浮层停止合成

`ShortcutsModal` 原来始终挂载，以 `opacity:0` 关闭，但全屏 `backdrop-filter:blur(4px)` 仍使 GPU 保留额外资源。先在不改编译产物的条件下逐项注入诊断 CSS：

| 隔离实验 | 壳工作集中位数 MiB | 末次私有提交 MiB | 证据目录 |
|---|---:|---:|---|
| 同时停止绘制关闭的抽屉/遮罩/快捷键帮助 | 545.0 | 288.6 | `local/startup-cost-Ka5kOL` |
| 仅关闭的抽屉/抽屉遮罩 | 593.1 | 332.3 | `local/startup-cost-wDJxwQ` |
| 仅关闭的快捷键帮助 | 517.9 | 292.0 | `local/startup-cost-77jjr2` |
| 三者改为 visibility:hidden | 521.1 | 295.6 | `local/startup-cost-IplcV1` |
| 全局去掉模糊、滤镜和阴影（仅诊断） | 516.7 | 282.6 | `local/startup-cost-XmSbdC` |
| 整个 body 不绘制（仅诊断） | 423.8 | 208.1 | `local/startup-cost-0ULcJN` |

据此只修改 `src/components/ShortcutsModal.css`：关闭后延迟到淡出结束再设 `visibility:hidden`；打开时立即可见。保留原有200ms透明度/缩放动画、全部网页与窗口身份。没有采用全局去效果、抽屉隐藏或不绘制 body 的诊断方式。

功能验证还发现旧的按住/松开缺陷：注册表保留 keydown 时的 `onHoldEnd`，其闭包中 `open=false` 会使松开无法关闭。`useShortcutsToggle` 改为明确设置 true/false，并新增回归测试，覆盖“按下后重渲染，再调用原释放回调”。

### 编译后的真实 UI 复测

构建日志 `local/shortcut-overlay-build.log`。下表前两行不注入任何实验 CSS，仍关闭工作集回收。后四行都在同一编译产物下实际打开帮助、等待淡入、关闭并等待淡出，再开始采样；对照组只用 CSS 恢复旧的关闭态 `visibility:visible`。

| 条件 | 工作集中位数 MiB | 末次私有提交 MiB | GPU末次私有提交 MiB |
|---|---:|---:|---:|
| 优化后产品壳，首次就绪 | 516.8 | 280.9 | 128.3 |
| 优化后产品与真实默认页，首次就绪 | 747.5 | 393.7 | 156.1 |
| 优化后产品壳，帮助开关后 | 589.0 | 284.5 | 131.8 |
| 同构建壳恢复旧关闭态，帮助开关后 | 615.2 | 332.3 | 181.0 |
| 优化后真实默认页，帮助开关后 | 799.2 | 412.6 | 171.3 |
| 同构建真实默认页恢复旧关闭态，帮助开关后 | 811.9 | 439.1 | 204.1 |

证据：[首次就绪](../../local/startup-cost-T1q7pT/report.json)、[帮助开关后](../../local/startup-cost-EfA1gA/report.json)、[同构建恢复旧关闭态](../../local/startup-cost-Wb28ED/report.json)。每份10条有效样本、全部组正常退出、没有采样身份残留、`buildUnchanged=true`。后两份的编译文件完全相同；执行器与夹具源码均随报告存档。

同构建、帮助开关后的壳私有提交减少47.8MiB，其中 GPU减少49.2MiB；真实默认页整树提交减少26.5MiB、GPU减少32.9MiB。真实网页其他进程与缓存有波动，不将不同轮工作集差额解释为精确模块大小。初次就绪壳相比接管基线提交约少56MiB，但工作集中位数和启动峰值不是同一指标；此处没有观测全过程启动峰值，也没有证明长时间容量。**标准态300MiB仍未达成。**

诊断入口：`node scripts/measure-startup-cost.mjs product-shell product-page --help-cycle`；对照在末尾加 `--style-experiment legacy-shortcuts`。原来的其余 `--style-experiment` 仍只用于归因，不是生产开关。

因上述5条采样中的提交还在下降，追加 `product-shell --help-cycle --samples 12` 对照，覆盖就绪后约2.6–30.7秒：[优化组GhaIpQ](../../local/startup-cost-GhaIpQ/report.json)、[旧样式组im7tzh](../../local/startup-cost-im7tzh/report.json)。各12条有效样本、产物未变、无退出残留；两份和归档的144个产品文件全部匹配。末3条GPU私有提交分别约131.7MiB与176.0–176.1MiB，整树私有提交差约44.9–45.7MiB。优化组中途GPU仍有约37MiB回涨，整轮工作集中位数533.8/535.5MiB很接近；不能将末次或前5条中位数差额当作整段稳定收益。这是更长的成本诊断，仍不是持续容量验收。

### 功能与回归

[真实界面检查](../../local/shortcut-overlay-Sq7B8g/report.json)通过：初始隐藏、菜单打开且列表有内容、保留淡出、Esc、遮罩关闭、五轮按住/松开、主窗与网页身份不变；无页面错误。截图 `open.png`、`closed.png` 已视觉核对。前两次诊断失败也保留：`shortcut-overlay-zPoXmQ` 的点击被原生缩放手柄拦截，测试移到遮罩内部；`shortcut-overlay-kzQC7Q` 暴露上述释放回调缺陷，修改产品后复测通过。

`npm run verify` 通过：工具链190项、196个Vitest文件共1560项测试；日志 `local/shortcut-overlay-verify.log`。新增回归单测与原快捷键面板单测另行运行3项通过。

`npm run test:memory-browsers` 为 [Bo4Psa](../../local/resident-ab-Bo4Psa/report.json)：`FUNCTIONAL_PASS`，30条采样、10次点击/真实滚动/草稿/身份/双rAF检查无错误，26个进程身份退出无残留；20次回收全部针对后台Tab，固定前台持续输入保护正常。初次采样3509.7MiB、末次1724.6MiB、末次私有提交1438.1MiB；统一尺寸后工作集中位数1919.4MiB，双rAF P50/P95为33/34ms，滚动34/34ms。与旧候选同类短测QcAnrx的提交1850.9MiB相比约少412.8MiB，但这是跨构建短测比较，不能代替严格容量A/B或真实AI持续验收；单壳同构建对照提供了更直接的归因。

`npm run test:memory-reclaim` 为 [u0kfq7](../../local/resident-ab-u0kfq7/report.json)：`FUNCTIONAL_PASS`，15条采样、5次真实空闲回收、2次交互无错误，6个进程身份退出无残留；回收后相同壳及网页恢复并交付双rAF。已观测峰值773.1MiB，标准容量仍为FAIL。末次工作集83.7MiB只是回收附近的短时样本，私有提交仍391.3MiB；不得解释为最小态、标准态持续达标或真实分配只有83.7MiB。呼出回调P50/P95为16/22ms，双rAF为35/49ms。

[本候选编译归档](../../local/startup-cost-T1q7pT/build-artifacts.json)记录144个产品产物，与T1q7pT、EfA1gA、Wb28ED、Bo4Psa均匹配。归档SHA256为 `9504685e8b6c1803e396fdf4db99efac15970c380d5c37739777a941a7de9b83`；这是复测用编译证据，不是安装包。

最小态正式接入、十个非浏览器主窗入口及真实AI持续容量均没有被本次改动解决。下一项必须以实际分配或启动峰值收益选择；不继续扩大回收参数、GPU参数或未验证宿主分支。
