import { describe, expect, it } from 'vitest';
import { buildOtherHotkeysForPrompt, detectPromptHotkeyConflicts } from './prompt-hotkey';
import type { PromptTemplate } from './electron-api';

const general: PromptTemplate = { id: 'general', title: 'General', content: 'General text', hotkey: 'Ctrl+Shift+P', createdAt: 1, updatedAt: 1 };
const exampleOnly: PromptTemplate = { ...general, id: 'example', title: 'Example', content: ' ', example: { content: 'Example text' } };

describe('prompt hotkey availability', () => {
  it('does not let example-only templates occupy a general template accelerator', () => {
    expect(detectPromptHotkeyConflicts([exampleOnly, general], [])).toEqual(new Map());
    expect(buildOtherHotkeysForPrompt([], null, [exampleOnly, general]).filter(item => item.accelerator === general.hotkey)).toEqual([{ label: '提示词「General」', accelerator: general.hotkey }]);
  });
});
