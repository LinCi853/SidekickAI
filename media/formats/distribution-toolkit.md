# 生命周期工具包接口

本仓通过固定版本的二进制工具包把标准应用载荷组装成概念版离线安装器。工具包自带 `concept`/`community` 两套版别、x64/arm64 两种架构的提取器与卸载器，按 `--edition` 自动取件，构建过程不向本仓补件。

概念版是单体应用，没有插件安装，也不作为插件宿主。**概念版无插件域，插件信任不适用**：应用载荷只携带 `resources/application-trust.json` 与 `resources/resource-trust.json`，两者仅登记官方发布者身份；不存在插件信任 JSON、`pluginKeys` 字段或插件验签路径，工具包契约也不要求该字段。

## 应用侧输入

`contracts/distribution-product.json` 提供产品标识、名称、发布者、图标与备份组件引用，`contracts/installation-contract.json` 提供功能、选项、默认值和指南文字，许可正文取自本仓 `LICENSE`。标准载荷导出为 `resources/installation-contract.json`，随载荷清单及正文签名保留。未提供协议的产品使用空协议列表，向导自动省去许可页。可选的 `contracts/installation-configuration.json` 提供安装默认值。

## 固定工具包

| 项 | 值 |
| --- | --- |
| 版本 | 0.1.7 |
| 归档字节 | 70,917,273 |
| SHA-256 | `6436ba549c25c0ab24d7ffd0773778714852d7dab3a8333709509b7c67a3a117` |

版本、大小与摘要同时固定在 `scripts/distribution-toolkit-release.cjs` 与 `contracts/distribution-toolkit.json`，不接受跳过固定值校验的开关。默认引用以 `archive.path` 指向工作区内的真实归档；`local/` 不纳入源码提交，公开检出需自行放置该固定归档。`SIDEKICK_DISTRIBUTION_TOOLKIT_REFERENCE` 只指定引用 JSON 的位置，不改变版本、大小、摘要或信任锚。

解压、缓存与每次运行前后都按固定清单核验：0.1.7 不再提供 `toolkit-manifest.json`，工具包以 19 个固定路径文件为准（`bin/AppLifecycleToolkit.exe`、`extractor/<edition>/<arch>/setup.exe` 与 `wizard-manifest.json`、`uninstallers/<edition>/<arch>/uninstall.exe` 与 `uninstall-manifest.json`、`sample/app.manifest.jsonc`、`README.md`），逐文件核对大小与 SHA-256，任一不符即停止。缓存位于 `build/component-cache/lifecycle-toolkit`，不含私钥。

## 二进制调用

工具包提供三个入口，成功退出 0，失败非零并写 stderr，均不触发安装或卸载：

```text
AppLifecycleToolkit.exe build --manifest <绝对路径> --payload-dir <绝对目录> --out <绝对目录> --edition concept --form offline [--key-file <绝对路径>]
AppLifecycleToolkit.exe verify-package-spec --package-dir <绝对目录> [--key-file <绝对路径>]
AppLifecycleToolkit.exe assemble --package-dir <绝对目录> --edition concept --arch <x64|arm64> --out <绝对路径.exe> [--key-file <绝对路径>]
```

- `build` 生成可复核的包规格：`lifecycle-package.json`、签名信封 `envelope.json`、规范化清单与合同、移除计划、载荷副本和 `evidence.json`。它按清单声明的 `archive.file` 取用载荷，并按 `--edition` 自动把对应架构卸载器附挂进载荷归档。
- `verify-package-spec` 核对 `evidence.json` 全部条目、合同摘要、移除计划结构与载荷身份；给出 `--key-file` 时另做信封认证，输出 `{packageDir, domain, checks}`。
- `assemble` 在复核通过后生成 SKSETUP3 容器：`[提取器][包 blob][元数据][68 字节 footer]`，输出 `{outFile, outputBytes, outputSha256, domain, productVersion, productId, edition, architectures, ...}`。`outputSha256` 可直接对外交付核对。
- 安装器自带无界面预检 `--check`：退出码 0 表示当前系统可安装，输出逐项 `[通过]` 记录并标明包域；在线或不可信域报 `PACKAGE_UNTRUSTED`。

`assemble` 只嵌入传入的包目录。每个架构必须使用只含该架构载荷的生命周期包：把两个架构都放进同一个包目录会让每份安装器都内嵌全部架构的载荷。本仓按架构分别构建包规格，x64 官方安装器因此保持约 203 MB，而不是把双架构载荷重复打包。

## 域与身份

有 `--key-file` 使用官方域 `official:<keyId>`，没有则为 `self-built`；默认行为是不带密钥即自建，构建入口不内置任何密钥路径。官方密钥文件为工具包格式 `{schemaVersion, keyId, publisher, privateKey}`；本仓从受控的官方发布密钥集读取对应 `adminKeys` 条目并写入临时文件，`finally` 删除，不记录路径或内容，构建证据只保留 keyId 与公钥。

自建身份保存在忽略的 `local/self-build-identity.json`，含私钥，不能提交、打包或公开。自建域没有签名信封、仅支持离线，且与官方身份不能互相冒充或覆盖安装登记。

## 本仓候选启动闸门

工具包的复核入口明确不执行 Setup，安装器能否显示首屏不在其契约内。本仓在候选收集前增加一次启动冒烟探针，作为准入条件：逐架构无参启动成品，等待非空标题窗口与已渲染内容子树（`rootLength` 非空），确认存在可用主按钮且没有错误对话框；超时或任一条件不满足即整批失败，不写出候选清单。探针按 PID 终止进程树，并按实际可执行路径核对无残留进程；不点击按钮、不进入安装、不触发提权。

成功时 `release-manifest.json` 的每个离线安装器产物带 `launch` 段（attempted、ok、title、rootLength、durationMs、reason），`assembly` 段附逐架构汇总；`SHA256SUMS.txt` 仍是纯字节清单。可在无图形环境用 `--skip-launch-probe` 跳过，此时记录 `attempted=false`、`ok=null` 与原因，表示未探测而非通过。跨架构成品在非本机宿主无法启动，探针按失败记录，该架构不进入候选。

## 发布批次

构建中间产物与候选留在 `build`。验收后的安装器、`assembly-result.json`、保留输入与 `SHA256SUMS.txt` 归档到 `release/<产品版本>/<批次>/`，归档前后校验哈希，同名不同字节的既有批次不被覆盖。本地归档不代表已部署到下载服务或已上传远端。
