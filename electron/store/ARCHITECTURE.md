# Store 层架构

## 默认配置路由

所有"默认值是什么？"的问题都经过 `default-config.ts` 路由：

```
用户设置了偏好 → 使用用户偏好
用户没设置     → 自动使用第一个代码项
```

### 使用方式

```typescript
import { getDefault, PREF_KEYS, BLOCK_RULES, PRESETS, PROMPTS } from './default-config.js'

// 通用路由器
const item = getDefault(items, userPreferredId)

// 各 Store 提供便捷路由函数
import { getDefaultDesktopPreset, getDefaultMobilePreset } from './preset-store.js'
import { getDefaultPrompt } from './prompt-store.js'
```

### 添加新配置

1. 在 `default-config.ts` 中定义配置数组（第一个元素即默认值）
2. 导出类型数组供各 Store import
3. 如需路由便捷函数，在对应 Store 中添加

### 文件结构

```
electron/store/
├── default-config.ts          ← 路由器 + 所有配置定义
├── app-settings-store.ts      ← 应用设置
├── profile-store.ts           ← Profile 管理
├── block-rules-store.ts       ← 屏蔽规则
├── preset-store.ts            ← 设备预设（含路由函数）
├── prompt-store.ts            ← 提示词模板（含路由函数）
└── voice-store.ts             ← 语音配置
```
