# 贡献指南

## 工作范围

本仓库维护工百窗概念版，目标是把已有工具打磨得更方便。先读 [README](README.md) 了解功能与使用条件。安全问题按 [SECURITY.md](SECURITY.md) 私密报告；大范围行为或接口调整先通过 Issue 说明目标、范围和可验证的结果。

代码、标识符和注释使用英文，用户界面优先中文。注释解释概念和约束，不记录开发过程；不顺带格式化无关文件。渲染依赖放在 devDependencies，主进程运行依赖放在 dependencies；IPC 使用已有校验和受限 preload 接口。

## 本地开发与验证

使用 Windows、Node.js 和附带的 npm；准确兼容要求以 package.json 的 engines 为准。根及独立子项目各自维护锁文件。

开发建议使用项目根目录的 `launch.bat`，按菜单提示操作。不要手工改写锁文件来绕过依赖问题。

`launch.bat` 的验证子菜单区分快速、桌面和原生安装卸载回归。处理缺陷先建立可观察的失败场景，完成修复后验证关键路径；涉及数据库、安装或卸载时使用独立临时数据。文档改动检查链接、命令和现行事实，不因此重建安装包。

## 公共源码与文档

产品版本以当前工作区 package.json 为准；共用品牌与路线身份由 packages/product-contract 管理。涉及共享安装维护代码时，核对 maintenance/shared-source.json，并通过已有产品和共享检查；不要覆盖其他工作区的修改。

用户可见的功能和入口变化同步更新 README 与 CHANGELOG，示例操作必须与实际入口一致。README 保持长期、明确的功能介绍；内部规格、调研、测试报告与交接资料另行保管，不纳入公开提交。完成后独立审查并简化重复逻辑。

## 仓库流程

维护者在现有 main 工作，提交前检查差异并保护已有未提交内容。外部贡献如采用 PR，应说明问题、最终行为和实际验证范围；CI 通过不能代替最终包验收。

提交保持单一主题，使用 Conventional Commits，例如 `fix(installer): preserve installation data`。提交、PR 正文和代码注释不写工具署名或开发进度标签。公开源码维护授权不等于二进制上传、社区版公开或个人安装升级授权。

## 不纳入源码

运行数据、浏览器 Profile、Cookie、数据库、凭据、.env、编译缓存、发行文件和本地验收证据不进入提交。以 .gitignore 为准；运行必需的 `build/tools/7zr.exe` 是已登记例外，不泛化清理。

贡献采用 [MIT License](LICENSE)。
