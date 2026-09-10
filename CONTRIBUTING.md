# 贡献指南

感谢你有兴趣为 SidekickAI 做贡献。请先读完本文，能省掉双方很多来回。

## 开始之前

- 提交 Issue 前先搜索是否已有相同问题
- **安全漏洞不要提 Issue**，请按 [SECURITY.md](./SECURITY.md) 的私密通道报告
- 大改动（新增模块、改动 IPC 协议、重构目录结构）请先开 Issue 讨论，避免白做

## 开发环境

见 [README.md](./README.md) 的「开发构建」章节。要点：Windows、Node.js ≥ 20。

```bash
npm install
npm run dev        # 开发模式
npm run typecheck  # 类型检查（提交前必须通过）
npm test           # 单元测试
```

## 代码约定

现有的约定，照着写就行：

- **TypeScript strict**：不使用 `any` 兜底；类型定义优先放 `electron/shared/`
- **缩进与格式**：2 空格、单引号、加分号；Rust 用 4 空格（见 `.editorconfig`）
- **文件命名**：组件 `PascalCase.tsx`，工具/模块 `kebab-case.ts`
- **注释**：中文；解释「为什么」而不是「做了什么」。涉及非直觉决策（比如为什么必须 `Debugger.pause` 而非虚拟时间）必须在文件头写清动机
- **渲染层依赖必须放 `devDependencies`**：electron-builder 会自动排除 devDeps，主进程真正 require 的才放 `dependencies`。放错会让安装包体积翻倍
- **IPC**：新增通道要走现有的安全包装（`electron/ipc-utils`），不要在渲染层直接暴露 `ipcRenderer`

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <描述>
```

- `type`：`feat` / `fix` / `refactor` / `perf` / `docs` / `chore` / `build` / `test`
- `scope` 可选：如 `installer`、`webview`、`store`
- 描述可用中文

示例：

```
fix(installer): 修正提权后重复安装模式页的问题
feat: 新增设备 ID 加密备份导入导出
```

一个提交只做一件事。不要顺手格式化无关文件——那会让 diff 无法审阅。

## 提 PR

1. 从 `main` 拉分支，命名如 `feat/xxx`、`fix/xxx`
2. 确保 `npm run typecheck` 与 `npm test` 通过
3. PR 描述里写清：**为什么改**、**怎么改的**、**怎么验证的**（命令或操作步骤）
4. 涉及 UI 改动请附截图
5. 关联相关 Issue（`Closes #123`）

CI 必须通过才会合并。

## 不要提交的东西

仓库只保留**源码**。以下内容已在 `.gitignore` 中排除，请不要用 `-f` 强推：

- 构建产物：`out/`、`dist/`、`dist-portable/`、`release/`
- 运行时数据：`.app-data/`、`.app-data-installed/`
- 设计与需求文档：`docs/`
- IDE / AI 工具元数据：`.workbuddy/`、`.mimocode/`、`.tokeny/`、`.claude/`、`.zcode/`
- 任何密钥、令牌、`.env`

> 唯一例外：`build/tools/7zr.exe` 是安装器运行时必需组件，有意入库。

## 许可证

你的贡献将以 [MIT License](./LICENSE) 授权。
