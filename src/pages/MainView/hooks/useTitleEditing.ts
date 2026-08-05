import { useCallback, useRef, useState } from 'react';
import type { Profile } from '../../../lib/electron-api';

interface Tab {
  id: string;
  title: string;
  profileId: string;
}

/**
 * Manages title editing state for the main view tab title.
 */
export function useTitleEditing(
  tabs: Tab[],
  activeTabId: string | null,
  profiles: Profile[],
  renameTab: (id: string, title: string) => void,
  updateProfile: (id: string, patch: Partial<Profile>) => void,
) {
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const startEditTitle = useCallback(() => {
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active) return;
    const profile = profiles.find((p) => p.id === active.profileId);
    if (profile?.isBuiltIn) return;
    setTitleDraft(active.title);
    setIsEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [tabs, activeTabId, profiles]);

  const commitTitle = useCallback(() => {
    if (!isEditingTitle) return;
    const active = tabs.find((t) => t.id === activeTabId);
    if (active) {
      const profile = profiles.find((p) => p.id === active.profileId);
      if (profile?.isBuiltIn) {
        setIsEditingTitle(false);
        return;
      }
      const trimmed = titleDraft.trim();
      if (trimmed && trimmed !== active.title) {
        const duplicate = tabs.find((t) => t.id !== active.id && t.title === trimmed);
        if (duplicate) {
          console.warn(`[MainView] 标题「${trimmed}」与其它标签重复（tab ${duplicate.id}）`);
        }
        void renameTab(active.id, trimmed);
        const prof = profiles.find((p) => p.id === active.profileId);
        if (prof && prof.name !== trimmed) {
          void updateProfile(active.profileId, { name: trimmed });
        }
      }
    }
    setIsEditingTitle(false);
  }, [isEditingTitle, tabs, activeTabId, titleDraft, renameTab, profiles, updateProfile]);

  return {
    isEditingTitle,
    setIsEditingTitle,
    titleDraft,
    setTitleDraft,
    titleInputRef,
    startEditTitle,
    commitTitle,
  };
}
