// Whiteboard-local persistence: one writer, and only acknowledged revisions are clean.
export function createWhiteboardDraft<Scene>(options: {
  serialize: (scene: Scene) => string;
  save: (snapshot: string) => Promise<{ ok: boolean }>;
  saveSync: (snapshot: string) => { ok: boolean };
}) {
  let scene: Scene | undefined;
  let revision = 0;
  let savedRevision = 0;
  let inFlight: Promise<void> | null = null;

  const drain = async () => {
    while (scene !== undefined && savedRevision < revision) {
      const savingRevision = revision;
      const snapshot = options.serialize(scene);
      if (!(await options.save(snapshot)).ok) throw new Error('Whiteboard save failed');
      savedRevision = savingRevision;
    }
  };

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    // Start on the next microtask so even synchronous serialization errors use this promise.
    const pending = Promise.resolve().then(drain).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
    return pending;
  };

  return {
    update(nextScene: Scene) {
      scene = nextScene;
      revision += 1;
    },
    flush,
    flushSync() {
      // A late asynchronous write could overwrite a newer synchronous snapshot.
      // Keep the mounted canvas and its unload guard until that writer settles.
      if (inFlight) throw new Error('Whiteboard save is still in progress');
      if (scene === undefined || savedRevision === revision) return;
      const savingRevision = revision;
      if (!options.saveSync(options.serialize(scene)).ok) throw new Error('Whiteboard save failed');
      savedRevision = savingRevision;
    },
  };
}

// Shared by list actions and the direct tab consumer; duplicate intents are ignored.
export type WhiteboardBeforeLeave = (commit: () => void) => Promise<void>;
