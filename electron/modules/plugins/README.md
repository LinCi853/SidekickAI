# 插件目录 (plugins/)

本目录存放第一方功能插件。每个插件为一个子目录，包含：

- `manifest.ts` — 模块声明（default export 为 `ModuleManifest`）
- `wiring.ts` — 生命周期（init / teardown / clearData）
- `ipc.ts` — IPC 处理（可选）
- `db.ts` — SQLite 持久化（可选）

插件在应用启动时由 `plugin-loader.ts` 自动发现和加载，无需修改 `manifests.ts`。

详见 `docs/功能插件系统与安装管控方案.md` 第 11 章。
