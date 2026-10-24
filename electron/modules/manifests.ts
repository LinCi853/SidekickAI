// Binds built-in module metadata to lifecycle callbacks in dependency order.

import type { ModuleManifest } from '../shared/types.js'
import { BUILTIN_MODULE_INSTALL_DATA } from './builtin-module-data.js'
import {
  initWhiteboardModule,
  teardownWhiteboardModule,
  clearWhiteboardData,
} from './plugins/whiteboard/index.js'
import { initNotesModule, teardownNotesModule, clearNotesData } from './plugins/notes/index.js'
import {
  initPromptLibraryModule,
  teardownPromptLibraryModule,
  clearPromptLibraryData,
} from './plugins/prompt-library/index.js'
import {
  initCustomChatModule,
  teardownCustomChatModule,
  clearCustomChatData,
} from './plugins/custom-chat/index.js'
import { initVoiceModule, teardownVoiceModule, clearVoiceData } from './plugins/voice/index.js'
import { initTtsModule, teardownTtsModule, clearTtsData } from './plugins/tts/index.js'
import { initBrowserModule, teardownBrowserModule, clearBrowserData } from './plugins/browser/index.js'

/** Lifecycle callbacks keyed by module identity. */
const WIRING: Record<
  string,
  Pick<ModuleManifest, 'init' | 'teardown' | 'clearData'>
> = {
  whiteboard: {
    init: initWhiteboardModule,
    teardown: teardownWhiteboardModule,
    clearData: clearWhiteboardData,
  },
  notes: {
    init: initNotesModule,
    teardown: teardownNotesModule,
    clearData: clearNotesData,
  },
  'custom-chat': {
    init: initCustomChatModule,
    teardown: teardownCustomChatModule,
    clearData: clearCustomChatData,
  },
  'prompt-library': {
    init: initPromptLibraryModule,
    teardown: teardownPromptLibraryModule,
    clearData: clearPromptLibraryData,
  },
  voice: {
    init: initVoiceModule,
    teardown: teardownVoiceModule,
    clearData: clearVoiceData,
  },
  tts: {
    init: initTtsModule,
    teardown: teardownTtsModule,
    clearData: clearTtsData,
  },
  browser: {
    init: initBrowserModule,
    teardown: teardownBrowserModule,
    clearData: clearBrowserData,
  },
}

export const BUILTIN_MODULES: ModuleManifest[] = BUILTIN_MODULE_INSTALL_DATA.map((d) => {
  const w = WIRING[d.id] ?? {}
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    category: d.category,
    sizeLevel: d.sizeLevel,
    testBadge: d.testBadge,
    defaultEnabled: d.defaultEnabled,
    dependencies: d.dependencies,
    entries: d.entries,
    hotkeys: d.hotkeys,
    init: w.init,
    teardown: w.teardown,
    clearData: w.clearData,
  }
})
