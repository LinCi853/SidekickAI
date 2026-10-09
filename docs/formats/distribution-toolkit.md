# 二进制待组装包接口

本仓通过固定版本的二进制组件包生成完整安装包。组件包包含安装器、卸载器及独立恢复附件的待组装资源，并附带二进制组装入口；不要求使用者取得这些实现的私有源码、Rust 安装工程或官方签名密钥。用户也可自行开发安装维护实现，或只构建绿色版。

软件构建提供双架构绿色 ZIP 和 x64、ARM64 标准应用载荷。完整包入口增加两份概念版离线安装器，使用本机独立自建身份；官方预构建安装包的发行身份与自建身份分别维护。开发与构建操作由 `launch.bat` 菜单提供。

## 发布引用

组件包使用单个 ZIP，随固定版本的发布清单提供。引用 JSON 包含以下字段，不接受额外字段：

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| schemaVersion | 整数 | 1 |
| toolkitVersion | 字符串 | 组件包版本，须与消费端代码内固定版本一致，独立于应用版本 |
| interfaceVersion | 整数 | 1 |
| archive.url | 可选字符串 | 无凭据及片段的绝对 HTTPS URL；明确选择本地文件时可用 file URL，与 archive.path 二选一 |
| archive.path | 可选字符串 | 相对于本工作区根目录的安全路径，使用 `/`；不得使用绝对路径、`..` 或文件系统链接，与 archive.url 二选一 |
| archive.size | 正整数 | ZIP 原始字节数，须与消费端代码内固定值一致 |
| archive.sha256 | 字符串 | ZIP 原始字节 SHA-256，小写十六进制 64 字符，须与消费端代码内固定值一致 |

组件引用默认从 `maintenance/distribution-toolkit.json` 读取。本地组件通过 `archive.path` 固定项目内归档位置；归档 ZIP 使用精确文件名的 Git LFS 属性跟踪，检出构建前须取得真实 LFS 对象。`SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE` 只指定引用 JSON 的位置，使同一归档可从明确的其他位置取得；版本、大小与摘要以消费端代码内固定值为准，环境变量不改变信任锚。任一身份字段不一致，都会在读取归档、下载、使用缓存或运行组件之前失败。缺少引用、组件归档或发布资源尚不可下载时，完整包入口停止。引用不能使用浮动 latest 地址、占位摘要或隐式私有工作区路径。

当前消费端只接受 `scripts/distribution-toolkit-release.cjs` 固定的 1.3.1：120,258,510 字节，SHA-256 为 `9cf2d0b68b4ced11fb8e7b622123df9f819dca3a24d15d5ec69e7ce14a7037f1`。接受新的组件发行版须审查并更新源码固定值及引用；不提供跳过固定值校验的开关。

下载与缓存复用均核对 ZIP 大小、摘要、完整条目及逐文件内容。构建前后重新核对引用和组件字节。缓存位于 `build/component-cache/distribution-toolkit`，不包含自建私钥。

## 组件清单

ZIP 根目录的 `toolkit-manifest.json` 为 UTF-8 JSON，最多 1 MiB。顶层字段如下，未知字段应被拒绝：

| 字段 | 类型 | 要求 |
| --- | --- | --- |
| schemaVersion | 整数 | 1 |
| kind | 字符串 | sidekick-distribution-toolkit |
| toolkitVersion | 字符串 | 与发布引用一致 |
| interfaceVersion | 整数 | 1 |
| maintenanceComponentVersion | 字符串 | 维护组件版本 |
| installationConfigurationVersion | 可选整数 | 支持自定义安装默认值时为 1；旧工具包可省略 |
| recoveryComponentVersion | 字符串 | 独立恢复组件版本 |
| host | 对象 | platform 为 windows，architecture 为 x64 或 arm64 |
| assembler | 字符串 | 唯一组装器 EXE 的相对路径 |
| capabilities | 数组 | 明确支持的路线、包型、身份及架构 |
| placeholderTrust | 对象 | 模板内固定公开占位身份，不含私钥 |
| files | 数组 | 包内全部普通文件，最多 1,024 项；不包含清单自身 |

`capabilities` 的元素为 `{ edition, mode, authority, architectures }`。edition 为 concept 或 community，mode 为 offline 或 online，authority 为 official 或 self-built，architectures 包含不重复的 x64/arm64。概念公开入口要求 concept、offline、self-built 同时支持两种架构；声明能力不授予官方签名身份。

`placeholderTrust` 为 `{ id, publicKey: { kty: "OKP", crv: "Ed25519", x } }`。x 是 32 字节公钥的规范无填充 base64url，长度 43 字符。id 为 `self-built-` 加递归排序键名后的 publicKey JSON UTF-8 字节 SHA-256。此身份用于识别已核验模板的固定信任记录，最终成品使用构建者的独立公开身份。

`files` 元素含 path、role、architecture、size、sha256，可选 edition、authority。path 是安全相对路径，使用 `/`，遵循 [标准应用载荷路径约束](SKSETUP3.md)；size 为正整数，sha256 为小写 64 位十六进制。architecture 为 x64、arm64 或 null。所有条目总大小最多 4 GiB。

| role | 资源 |
| --- | --- |
| assembler | 二进制组装和核验入口，仅一个，与 assembler 路径及 host 架构一致 |
| wizard-template | 对应架构安装向导模板 |
| uninstaller-template | 对应架构卸载模板及部署描述 |
| recovery-template | 对应架构独立恢复模板 |
| backup-runtime | 对应架构恢复运行时及描述 |
| product-contract | 组件及产品契约 |
| license | 使用许可与版权说明 |

两种架构分别需要 wizard-template、uninstaller-template、recovery-template 和 backup-runtime，并且适用于概念版自建身份。ZIP 不得夹带链接、特殊文件、加密条目、重复及大小写冲突路径、目录逃逸或未登记内容。EXE、DLL 和 NODE 文件的 PE 架构须与清单一致。最终完整 Setup 不是可复用模板。

## 二进制调用

组件组装器提供三个入口，成功退出 0，失败非零并写 stderr，不触发安装或卸载：

```text
SidekickDistribution.exe inspect --toolkit <absolute-directory>
SidekickDistribution.exe assemble --request <absolute-request-json>
SidekickDistribution.exe verify --toolkit <absolute-directory> --result <absolute-result-json>
```

inspect 输出 JSON，包含 interfaceVersion、toolkitVersion、capabilities 和 verified: true，须与已核验组件清单完全一致。

支持安装配置时，inspect 还返回 `installationConfigurationVersion: 1`，须与组件清单一致。

assemble 的请求为以下对象，所有路径是绝对路径，outputDirectory 必须尚不存在：

| 字段 | 要求 |
| --- | --- |
| schemaVersion | 1 |
| toolkitDirectory、toolkitVersion | 已核验组件目录和固定版本 |
| edition、mode、authority | concept、offline、self-built |
| payloads.x64、payloads.arm64 | 两份标准应用载荷清单路径；同目录提供清单指向的 ZIP |
| identityStore | 本机独立身份存储路径，必须在输出目录之外 |
| outputDirectory | 成品目录 |
| installationConfiguration | 可选对象：`{ schemaVersion: 1, edition: "concept", options: { ... } }` |

产品版本从两份一致的标准载荷取得，并与实际软件归档交叉核对；工具包版本不覆盖应用版本。标准载荷清单最多 4 MiB。输出正文包含对应架构卸载器、独立恢复程序及其运行时，由组装器核验、注入并生成本地证明。原始标准载荷保持不变。

工程可提供 `maintenance/installation-configuration.json`，由调用包装传入二进制组件。格式见同目录的 `installation-configuration.example.json`。声明 `installationConfigurationVersion: 1` 的工具包支持覆盖 `autoLaunch`（布尔值）、`logLevel`（debug、info、warn、error）和 `usageTracking`（布尔值）的默认值；可只指定部分选项，最大 32 KiB。未知字段、选项和值均被拒绝。用户仍可在向导中调整最终值，修复时保留已有配置。

配置接口在 1.2.0 中可省略；当前消费端仍只接受上述固定发行版。传入配置要求固定工具包声明兼容能力，不支持时须在编译应用前停止。新增选项、信任、身份或执行逻辑需要升级组件。应用版本及默认值的兼容调整可复用同一工具包，无需安装器源码。

成功时 stdout 最后一行输出 `{ schemaVersion: 1, outputDirectory, resultFile }`；resultFile 固定为输出根的 `assembly-result.json`。该文件最多 4 MiB，含 schemaVersion、interfaceVersion、toolkitVersion、toolkitManifestSha256、edition、mode、productVersion、authority、issuerKeyId、issuerFingerprint、publicIdentity、inputs 和 artifacts。安装正文保留 `maintenance/LICENSE.txt` 和 `maintenance/THIRD-PARTY-NOTICES.txt`，与已核验工具包逐字节一致并纳入正文签名；单独分发最终 Setup 时仍保留维护组件许可。

publicIdentity 为 `{ id, publicKey: { kty, crv, x } }`，只含公开材料；issuerKeyId 与 id 相同。issuerFingerprint 为递归排序键名后的 publicIdentity JSON UTF-8 字节 SHA-256。inputs 为 `{ x64: { manifestSha256, archiveSha256 }, arm64: { manifestSha256, archiveSha256 } }`，对应原始标准载荷。artifacts 包含两项 `{ path, role: "offline-installer", architecture, size, sha256 }`，path 相对于输出根。

输出根保留 `inputs/<architecture>/application.manifest.json` 及该清单指向的原始 ZIP，供成品复验。归档必须保留这些文件、assembly-result.json 及 artifacts 指向的相对路径；不能只移动 EXE 后声称完整输出可复验。

自定义配置时，结果和 verify 输出还包含 `installationConfigurationSha256`。成品保留规范化 JSON 加换行的 `inputs/installation-configuration.json`，相同配置作为 `maintenance/installation-configuration.json` 纳入签名正文。复验重建双架构安装元数据并核对签名内配置，拒绝配置、摘要或默认值篡改。归档须保留配置输入；源配置在组装或复验期间出现、删除或变化均使构建失败。

verify 读取真实成品，核对容器布局、模板、正文与恢复证明、维护附件、原生架构及保留输入，不执行 Setup。成功 JSON 含 verified: true，以及 interfaceVersion、toolkitVersion、edition、mode、productVersion、authority、issuerKeyId、issuerFingerprint、inputs、artifacts；它们须与结果文件和磁盘成品完全一致。公开调用包装在复制成品后再次运行 verify。

结果和产物记录拒绝未声明字段；公开身份对象只接受声明的公钥字段，不得携带私钥或额外材料。

## 自建身份

首次组装由二进制入口生成本机独立 Ed25519 身份，默认保存在忽略的 `local/self-build-identity.json`，后续同身份构建复用它。该文件含私钥，不能提交、打包或公开；组件缓存与成品只保留公开身份和证明。删除或更换该文件会产生另一构建身份，不能直接覆盖原身份的安装。

自建身份不代表官方背书。安装向导、修复、卸载、worker、恢复及维护收据须一致识别该身份；不同身份和官方身份不能互相冒充或覆盖安装登记。安装与维护，以及对归档成品的 verify，均不需要构建机上的 identityStore。

Windows Authenticode、官方发行证明和自建 Ed25519 证明是不同的身份机制。自建证明只建立该构建者与成品的绑定，不宣称软件经过官方审查或 Windows 代码签名。
