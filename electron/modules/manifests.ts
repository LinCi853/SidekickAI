// Binds built-in module metadata to lifecycle callbacks in dependency order.

import type { ModuleManifest } from '../shared/types.js'
import { BUILTIN_MODULE_INSTALL_DATA } from './builtin-module-data.js'
import {
  initWhiteboardModule,
  teardownWhiteboardModule,
  clearWhiteboardData,
} from './wiring/whiteboard.js'
import { initNotesModule, teardownNotesModule, clearNotesData } from './wiring/notes.js'
import {
  initPromptLibraryModule,
  teardownPromptLibraryModule,
  clearPromptLibraryData,
} from './wiring/prompt-library.js'
import {
  initCustomChatModule,
  teardownCustomChatModule,
  clearCustomChatData,
} from './wiring/custom-chat.js'
import { initVoiceModule, teardownVoiceModule, clearVoiceData } from './wiring/voice.js'
import { initTtsModule, teardownTtsModule, clearTtsData } from './wiring/tts.js'
import { initBrowserModule, teardownBrowserModule, clearBrowserData } from './wiring/browser.js'

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
