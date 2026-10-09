# SKSETUP3 与标准应用载荷格式

本文定义 Windows 安装容器 SKSETUP3 的字节布局、元数据与发行证明，并定义公开构建交付的标准应用载荷。格式说明用于独立读取、验证和互操作；官方组装、维护向导、卸载与恢复执行器的实现由私有分发工作区维护。

公开构建提供应用运行文件和外置校验清单。第三方可以使用这些输入制作自己的分发工具，但格式兼容不会使其自动获得官方维护向导的信任。官方发行证明仍须由向导预置信任的 Ed25519 公钥验证，不能用输入清单、任意新公钥或只有 SHA-256 的记录代替。

## 标准应用载荷

每份标准载荷只包含一个路线、一个产品版本和一个 Windows 原生架构的应用运行文件。ZIP 根目录直接对应该架构的应用目录，例如根目录中的 SidekickAI.exe 和 resources；不增加 application.zip 内层封装。ZIP 文件条目使用 Store（方法 0）或 Deflate（方法 8），不加密。它不包含安装登记、卸载器、recover.exe、backup-runtime.zip、官方发行证明或用户数据。

ZIP 旁边的 `.manifest.json` 是无 BOM 的 UTF-8 JSON，使用以下字段；对象不得包含重复或未知字段。该清单是未签名的构建输入清单，和后文的官方本体证明是两种契约。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| schemaVersion | 整数 | 固定为 1 |
| kind | 字符串 | 固定为 application-payload |
| edition | 字符串 | concept 或 community |
| productVersion | 字符串 | 该应用的产品版本，最多 64 字符；三段数字没有多余前导零，可带非空的预发行与构建标识 |
| architecture | 字符串 | x64 或 arm64 |
| archive | 对象 | 同目录 ZIP 的身份 |
| files | 数组 | ZIP 中全部普通文件的身份，1 至 5,000 项 |

| archive 字段 | 类型 | 含义 |
| --- | --- | --- |
| file | 字符串 | 以 `.zip` 结尾的文件名，不包含目录 |
| size | 正整数 | ZIP 总字节数，最多 2,147,483,648 字节（2 GiB） |
| sha256 | 字符串 | ZIP 原始字节的 SHA-256，小写十六进制 64 字符 |

| files 元素字段 | 类型 | 含义 |
| --- | --- | --- |
| path | 字符串 | 相对 ZIP 根目录的文件路径，以 `/` 分隔，最多 240 个 UTF-8 字节 |
| size | 非负整数 | 解压后的文件字节数；单文件及全部文件总和均不超过 8,589,934,592 字节（8 GiB） |
| sha256 | 字符串 | 文件原始字节的 SHA-256，小写十六进制 64 字符 |

长度和文件数量均使用可精确表示的整数。路径拒绝反斜杠、冒号、控制字符、`< > " | ? *`、空路径段、`.`、`..`、以点或空格结尾的路径段及 Windows 保留设备名；文件路径不能同时充当另一文件的目录。不得以 SidekickAI、win-unpacked 或 win-arm64-unpacked 增加外层目录，也不得混入 portable.txt、portable-layout.json 或 portable-manifest.json。

读取者先检查清单的格式、产品身份、版本和架构，再检查 ZIP 大小与摘要。随后在隔离目录内按相对路径核对全部条目；必须拒绝绝对路径、目录逃逸、重名或大小写冲突、符号链接与其他特殊文件、未声明文件、缺失文件以及大小或摘要不符的文件。目录条目只能表示清单中文件所需的祖先目录，不能夹带其他空目录。清单本身放在 ZIP 外部，不作为 ZIP 内应用文件的一部分；私有组装输入的清单文件不得超过 4,194,304 字节。

清单无法证明发布者身份。把载荷转换为官方安装本体时，私有分发流程验证这些输入，加入对应架构的维护附件，再为最终文件集合和最终归档生成新的官方本体证明。标准载荷的 size 字段不能直接当成官方证明中的 sizeBytes，注入附件后的文件清单和归档摘要也必须重新计算。

## SKSETUP3 字节布局

容器按下列顺序连接，没有分隔符。大小均以字节计，整数字段为无符号、小端序。

```mermaid
flowchart LR
  W["原生向导 W"] --> P["应用载荷 P；在线为 0"]
  P --> E["提取器保留 E = 0"]
  E --> M["UTF-8 元数据 M"]
  M --> F["SKSETUP3 footer：68 字节"]
  F --> A["可选零填充：0 至 7 字节"]
  A --> C["可选 Authenticode 证书表"]
```

箭头只表示文件内连续区域的排列。生产者在无证书表时必须让 footer 直接到达文件末尾，不添加对齐填充。当前原生读取器兼容接受未签名 footer 后最多 7 个零字节，JavaScript 读取器不接受；该容忍不属于生产者格式，第三方生产者不得依赖它。

| 区域 | 长度 | 内容 |
| --- | ---: | --- |
| 原生向导 | W，且 W > 0 | Windows PE32+ 可执行映像 |
| 应用载荷 | P | 离线包中的官方应用 ZIP；在线入口长度为 0 |
| 提取器保留区域 | E，固定为 0 | 当前协议不携带外部提取器 |
| 元数据 | M | UTF-8 JSON，1 至 8,388,608 字节 |
| 尾部记录 | 68 | 下表定义的 footer |
| 可选证书对齐 | 0 至 7 | 零字节，仅用于尾随 Authenticode 证书表对齐 |
| 可选 Authenticode 证书表 | PE 安全目录声明的长度 | 必须一直延伸到文件末尾 |

设 footer 末尾的绝对文件偏移为 C，则 W = C − 68 − M − E − P。载荷起点为 W，元数据起点为 W + P + E，footer 起点为 C − 68。所有加减运算都必须检查溢出、下溢与文件边界。P 不得超过 2,147,483,648 字节。

footer 的偏移相对于自身起点：

| 偏移 | 长度 | 编码 | 字段 |
| ---: | ---: | --- | --- |
| 0 | 8 | 固定字节 | ASCII `SKSETUP3`，十六进制 `53 4b 53 45 54 55 50 33` |
| 8 | 8 | uint64 little-endian | P，载荷长度 |
| 16 | 8 | uint64 little-endian | E，必须为 0 |
| 24 | 8 | uint64 little-endian | M，元数据长度 |
| 32 | 32 | 原始摘要字节 | 元数据原始 UTF-8 字节的 SHA-256 |
| 64 | 4 | uint32 little-endian | 固定为 68 |

Magic 恰好为 8 字节，没有 NUL 终止符。footer 中的摘要不是十六进制文本。摘要绑定元数据实际字节，包括其空白与换行；元数据不要求采用签名正文的规范化 JSON 排版。

## 元数据对象

生产者写出下列所有顶层字段；空值明确写为 JSON null。消费者拒绝未知顶层字段、不兼容协议和与当前向导不一致的路线或组件身份。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| schemaVersion | 整数 | 3 |
| edition | 字符串 | 与向导路线相同 |
| productVersion | 字符串 | 本次应用产品版本，与本体证明一致 |
| componentVersion | 字符串 | 与向导自身维护组件版本严格相同；独立于产品版本 |
| uninstallProtocolVersion | 整数 | 2 |
| distributionProtocolVersion | 整数 | 1 |
| distributionMode | 字符串 | offline 或 online |
| targetArchitecture | 字符串或 null | 见包型约束 |
| executableArchitecture | 字符串 | x64 或 arm64，声明入口可执行架构 |
| supportedNativeArchitectures | 字符串数组 | 1 或 2 个不重复的 x64/arm64 |
| distributionProof | 签名信封或 null | 离线包的官方本体证明 |
| features | 数组 | 0 至 128 个安装功能描述，id 不重复 |
| options | 数组 | 0 至 128 个安装选项描述，id 不重复 |
| payload | Blob 描述或 null | 嵌入载荷的身份 |
| extractor | null | 当前协议固定为 null |

Blob 描述只含 size 和 sha256；size 是载荷字节数，sha256 是小写十六进制 64 字符摘要。离线载荷 size 必须大于 0，并与 footer 的 P 一致。

| 包型 | 路线 | targetArchitecture | executableArchitecture | supportedNativeArchitectures | payload / distributionProof |
| --- | --- | --- | --- | --- | --- |
| 单架构离线安装器 | concept | x64 或 arm64 | 与目标相同 | 仅目标架构 | 均非 null，嵌入 P > 0 |
| 在线入口 | community | null | x64 | x64 与 arm64，恰好各一次 | 均为 null，P = 0 |

目标 Windows 的原生架构必须在 supportedNativeArchitectures 中；非 null 的 targetArchitecture 还必须与其相等。ARM64 系统上能够运行 x64 入口，不等于允许安装 x64 本体。

产品版本使用三段非负数字的版本形式，可带受支持的预发行与构建标识。官方发行正文的版本约束更严格：三段数字无多余前导零，预发行首标识为 alpha、beta 或 rc，完整版本最长 64 字符；概念版的发行策略只提供正式版。版本比较规则不能由字符串长度或文件名推断。

### 功能与选项

功能描述具有 id、name、description、category、defaultEnabled、sizeLevel；required 和 installRequired 是可选布尔值。category 为 stable 或 dev，sizeLevel 为 small 或 large。当前受支持 id 为 whiteboard、notes、custom-chat、prompt-library、voice、tts、browser；是否列入某个包的可选安装功能由对应产品契约决定，支持某 id 不表示该包必须显示它。

选项描述具有 id、label、description、type、defaultValue；page 可省略或为 behavior、logging。type 为 boolean 时 defaultValue 必须是布尔值，并且不携带 choices。type 为 choice 时 choices 为 1 至 128 个具有 value、label 的对象，value 不重复，defaultValue 必须是其中一个字符串 value。

当前选项契约为 autoUpdate、autoLaunch、usageTracking 三种布尔选项，以及 logLevel 选择项；logLevel 的允许值为 error、warn、info、debug。显示文本是 UTF-8 字符串，不参与 id 匹配。

## 发行签名信封

信封只有 payload 和 signature 两个字段。payload 是下述某一种正文对象，signature 是包含正文的三段 Compact JWS 字符串。

| 签名用途 typ | 正文 |
| --- | --- |
| sidekickai-application-body-v1 | 安装或绿色本体 |
| sidekickai-backup-runtime-v1 | 独立备份恢复组件 |
| sidekickai-application-release-v1 | 一次发行及其资产 |
| sidekickai-application-channel-v1 | 有时限且防倒退的频道选择 |

JWS 头部只含 alg、kid、typ。alg 固定为 EdDSA，kid 为预置信任集合内的密钥 id，typ 必须与当前验证目的完全相同。公钥使用 JWK 的 OKP / Ed25519 形式；x 是 32 字节公钥的无填充 Base64url 编码。正文或容器携带的公钥不会自动成为信任来源。

### 规范化与签名字节

正文规范化 JSON 使用 UTF-8、无 BOM、无额外空白或末尾换行。对象键递归按字典序排序；已定义协议的键名均为 ASCII。数组保留原有元素顺序；字符串使用 JSON 引号与转义，不进行 Unicode 归一化。本文定义的数值字段必须使用可精确表示的整数，不能输出 NaN、Infinity 或以浮点近似表示长度。

记 H 为头部 JSON 字节的无填充 Base64url 编码，B 为规范化 payload 字节的无填充 Base64url 编码。签名消息是 ASCII 字节 H、一个 ASCII 句点、B 的连接。Ed25519 对这些消息字节直接签名；不能先自行进行额外哈希，也不能只签 payload 的 SHA-256。

记 S 为 64 字节 Ed25519 签名的无填充 Base64url 编码，则 signature 的文本形式为 H.B.S。三段都不得为空，字符只来自 A–Z、a–z、0–9、下划线与连字符，不带 `=` 填充。生产者也按规范化规则序列化头部。验证者使用实际收到的 H.B 验证签名，并要求 B 解码后的字节与信封 payload 的规范化结果完全相等。

信封外层 JSON 可以换行或缩进；这种外层排版不进入 JWS 消息。独立证明文件的大小上限为 4,194,304 字节；嵌入元数据仍受元数据总体上限约束。

## 官方本体正文

SKSETUP3 离线包中的 distributionProof 使用本体用途。该 payload 只有以下字段：

| 字段 | 值或含义 |
| --- | --- |
| protocolVersion | 1 |
| productId | sidekickai |
| edition | concept 或 community |
| productVersion | 应用产品版本 |
| variant | installed 或 portable |
| platform | windows |
| nativeArchitectures | 不重复的原生架构列表 |
| maintenanceProtocolVersion | 1 |
| recoveryProtocolVersion | 1 |
| archive | installed 的 ZIP 描述；portable 为 null |
| files | 最终普通文件清单 |
| components | 对应各原生架构的备份恢复组件绑定 |

installed 恰好声明一个架构；它的 archive 只有 sha256、sizeBytes、expandedBytes、fileCount。sizeBytes 必须在 1 至 2,147,483,648 之间。expandedBytes 等于 files 中所有 sizeBytes 之和，fileCount 等于 files 的元素数。离线 metadata.productVersion、payload.size 和 payload.sha256 必须分别与正文 productVersion、archive.sizeBytes 和 archive.sha256 相同。

官方 portable 本体只适用于 concept，恰好声明 x64 和 arm64；archive 固定为 null，以文件清单绑定不可变内容。此签名包型不等同于公开构建的未签名绿色 ZIP。

files 为 1 至 5,000 项，每项只有 path、sizeBytes、sha256、executableArchitecture。路径与文件摘要定义同上；executableArchitecture 必须明确为 x64、arm64、anycpu 或 null。`.exe` 文件不能声明 null，所有原生二进制架构须属于正文的 nativeArchitectures，anycpu 表示已识别的托管程序集。文件总展开大小不得超过 8,589,934,592 字节。

受证明路径使用 `/`，最多 240 字节，并拒绝反斜杠、冒号、控制字符、Windows 保留字符、空路径段、`.`、`..`、以点或空格结尾的路径段以及 Windows 保留设备名。路径不得按 Windows 大小写规则冲突。文件清单不能含根目录的 distribution-proof.json、body-proof.json 或 data 资料树；证明自身不递归包含在它证明的文件集合中。

components 的数量等于 nativeArchitectures 的数量，每个架构恰好一项。每项只有 componentId、componentVersion、nativeArchitecture、archivePath、proofPath、sha256、sizeBytes。componentId 固定为 backup-runtime；archivePath 与 proofPath 必须不同且均存在于本体 files 中；archivePath 对应文件的大小和摘要须与该组件绑定完全相同。当前安装本体使用 maintenance/backup-runtime.zip 与 maintenance/runtime-proof.json。

## 备份恢复组件正文

恢复组件使用独立签名用途，避免把其他用途的合法签名误认成恢复资源许可。

| 字段 | 值或含义 |
| --- | --- |
| protocolVersion / productId / edition | 1 / sidekickai / 本体路线 |
| componentId | backup-runtime |
| componentVersion | 独立恢复组件版本 |
| nativeArchitecture | 与组件绑定相同的 x64 或 arm64 |
| archive | 只有 sha256、sizeBytes 的 ZIP 描述 |
| files | 与本体 files 使用相同元素格式 |
| exportProtocolVersion / recoveryProtocolVersion | 均为 1 |
| entrypoints | 只有 export、restore 的对象 |

entrypoints.export 固定为 export.mjs，entrypoints.restore 固定为 sidekick-backup.cjs；这两个文件和 node.exe 必须存在于组件 files。node.exe 的 executableArchitecture 必须与 nativeArchitecture 一致。其余非 anycpu 原生文件也必须与组件架构一致。运行恢复入口前仍须验证组件归档及解压后的每份文件。

## 在线发行记录

在线入口的 SKSETUP3 元数据不携带应用载荷。它获取受签名的频道选择、发行记录及对应原生架构资产；每一层都需要验证用途、身份、摘要绑定和时效。

频道 payload 的字段为 protocolVersion、productId、edition、channel、releaseId、releaseManifestSha256、sequence、issuedAt、expiresAt。协议与产品身份分别为 1 和 sidekickai；channel 为 stable、alpha、beta 或 rc。releaseId 与 releaseManifestSha256 必须同时为 null，或同时给出 UUID v4 发行 id 和小写 SHA-256。sequence 是 1 至 9,007,199,254,740,991 的整数，不能低于本机已接受值；issuedAt、expiresAt 为 Unix 秒数。签发时间最多领先当前时间 60 秒，有效期必须尚未结束、大于零且不超过 24 小时。

发行 payload 的字段为 protocolVersion、productId、edition、productVersion、releaseId、channel、platform、maintenanceProtocolVersion、recoveryProtocolVersion、assets、publicAssetIds、architectureEvidence、notes、createdAt。其共同身份约束与本体相同；channel 从产品版本的预发行标识确定，createdAt 使用 UTC 的毫秒时间形式 `YYYY-MM-DDTHH:mm:ss.sssZ`，notes 最多 8,000 个字符。

资产元素只有 assetId、role、filename、sizeBytes、sha256、contentType、executableArchitecture、supportedNativeArchitectures、bodyProofSha256。assetId 与 sha256 相等，filename 是无目录的安全文件名，sizeBytes 在 1 至 2,147,483,648 之间；bodyProofSha256 和 executableArchitecture 可以明确为 null。role 为 online-bootstrap、offline-installer、portable 或 application-payload。

社区发行包含一个公开 x64 在线入口和两份分别面向 x64、arm64 的内部 application-payload 资产。概念发行包含两份单架构 offline-installer 和一份双架构 portable，三份均公开。publicAssetIds 是 assets 的无重复子集。architectureEvidence 每项具有 nativeArchitecture、evidenceId、testedAt、nativePackageVerified；它必须逐一覆盖资产支持的原生架构，evidenceId 为小写 SHA-256，testedAt 使用上述 UTC 时间格式，nativePackageVerified 为 true。交叉构建本身不构成原生运行证据。

releaseManifestSha256 绑定发行信封 payload 的规范化 JSON 字节摘要，bodyProofSha256 绑定本体信封 payload 的规范化 JSON 字节摘要；它们不是带排版的证明文件摘要，也不包含外层 signature 字段。资产 sha256 则始终绑定实际下载文件字节。在线入口资产的 bodyProofSha256 为 null，其他资产必须绑定对应本体。

这里的官方 application-payload 传输 ZIP 必须恰好只有两个普通文件：application.zip 与 body-proof.json。前者是已注入维护附件的本体 ZIP，后者是本体签名信封；两者通过 archive 字段绑定。它与本文开头定义的“应用文件直接位于 ZIP 根目录、清单外置”的标准构建载荷不可互换。

## Authenticode 后缀

有 Authenticode 签名时，PE 的安全目录使用文件偏移定位证书表。证书起点必须按 8 字节对齐，证书范围结束于文件末尾；footer 位于证书表之前，允许 0 至 7 个零字节填充。解析者应从证书起点向前检查这 8 种位置，确认 footer magic、固定长度及填充内容，再计算 W、P、E、M。

原生消费者还检查证书表的结构：总长度在 8 至 16,777,216 字节之间，每条 WIN_CERTIFICATE 的长度至少 8，revision 为 0x0200，certificateType 为 0x0002，各条目向上按 8 字节对齐后恰好覆盖证书区域。任意未解释的尾随数据、不合规范围或非零填充不能当作合法签名后缀。

当前 x64 与 ARM64 生产容器均使用 PE32+。现有 JavaScript 布局辅助读取器按 PE32+ 的安全目录位置读取；原生读取器也能解析 PE32 的安全目录，但这不扩展当前发行支持的可执行架构。未签名容器的生产布局要求 footer 直接位于文件末尾；原生读取器对零字节后缀的兼容容忍见布局图后的说明。

识别证书表和结构有效不等于验证了 Authenticode 的发布者、证书链或 Windows 信任状态。Ed25519 本体证明与 Authenticode 是不同的校验：前者绑定受信任发行内容，后者由 Windows 可执行文件签名机制验证。

## 完整读取与验证顺序

1. 固定要读取的文件身份和长度，检查 PE、证书后缀及 footer 定位，拒绝越界或不受支持长度。
2. 按 footer 的 M 读取元数据原始字节，核对 32 字节 SHA-256，再解析 UTF-8 JSON。
3. 验证元数据字段、路线、组件版本、协议、包型及本机原生架构；E 必须为 0，extractor 必须为 null。
4. 对离线包验证 distributionProof 的 JWS 用途、信任密钥、Ed25519 签名和规范化正文，核对正文与元数据的版本、架构、大小和摘要绑定。在线入口则验证频道、发行记录和所选资产的绑定。
5. 对实际载荷字节计算完整 SHA-256 并核对长度。只通过元数据校验并不表示载荷已经验证；原生读取流程在取得载荷后完成这项检查。
6. 依据受签名清单安全解压，核对完整文件集合、逐文件大小与摘要、展开总量及二进制架构，再验证维护组件及其独立证明。

未知协议、未知用途、未受信任密钥、签名或摘要不一致、缺少维护组件以及不安全归档都应被拒绝。不得把这些失败降级为仅凭文件名、普通清单或未签名载荷继续执行官方安装、修复、卸载或恢复。
