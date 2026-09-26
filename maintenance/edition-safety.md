# Edition activation and installation safety

## Product contract

The independently maintained open-source and online editions may both be installed. One interactive user session may run only one edition. The online edition has priority: it requests a normal save-and-exit from a running open-source edition and waits for completed shutdown before enabling its own windows or input hooks. An open-source launch never displaces the online edition. Profiles, installation roots, registrations, and uninstall data remain separate.

A rejected save, active restore, unknown peer, or timeout prevents takeover. Cancelling a native window or web-contents unload resets the pending handoff so it can be retried; requesting app.quit is not proof of exit. No process is terminated by image name or forced out to gain priority. Test instances use an explicitly isolated coordination namespace. Existing released programs are not silently replaced or terminated during verification.

Notes and whiteboards retain the latest dirty snapshot until its corresponding write succeeds. A rejected asynchronous write or an explicit unsuccessful result prevents record and tab navigation, offers a visible retry and keeps the current editor mounted. Blank edits to existing notes are persisted. New drafts use a stable identity across retries. Pending asynchronous writes block synchronous handoff rather than allowing an older write to overwrite a newer snapshot.

## Keyboard behavior

Modifier state reconciles key events with observed left and right modifier presses. A released modifier cannot remain latched merely because a release event was missed. System window switching and Alt+F4 window closure invalidate uncertain modifier state. Each main-key press invokes a registered activation at most once, even when native registration and the hook both deliver it or auto-repeat continues. Recording, suspension, unregistration, and shutdown reject delayed callbacks.

The hook uses the installed library's actual right-side key names. An additional modifier cannot accidentally match a different chord. Restarting or resuming input cannot reuse a stale modifier press. Regression includes missing releases, stale event masks, both modifier sides, extra modifiers, auto-repeat, queued native callbacks, recording, and rapid released taps.

The existing registration result reports operating-system registration only. A false result still permits the hook fallback, so renderer subscriptions remain active until replacement, explicit removal, or a rejected registration request.

## Open-source installer

Retain the existing installer interface and implement its open-source identity independently. Fresh install, same-edition replacement and repair use a verified full-runtime payload and a rollback journal. Destination ownership is checked before replacement or removal. Only the open-source executable, data root, shortcuts and uninstall registration belong to this installer. Portable data and another edition's files are never implicit cleanup candidates.

Uninstall preserves user data by default. Explicit deletion is restricted to the verified open-source root; export-then-delete requires a successful verified export of that same root. An unavailable application export aborts destructive data removal. Running applications receive a graceful shutdown request and must finish before files are replaced. Failure and cancellation leave a usable previous installation or an accurately identified recovery directory.

Installation and persistent data roots cannot overlap. Windows path containment and lock identity resolve the existing ancestor before comparing case-insensitive directory boundaries, including short names and extended paths. Ambiguous names (trailing dots/spaces, device names and alternate data streams), network/device paths and filesystem links are rejected. An uninstall backup cannot be placed within either removal root, even through an alias, and unknown data-identity schemas do not authorize removal.

All window close gestures use the same confirmation and final-settings persistence path. A failed settings write keeps the wizard open with an actionable error; duplicate close gestures cannot trigger concurrent finalization. Maintenance reads configuration from its selected installation, including a custom uninstall target. Recovery journals and system integration snapshots survive an interrupted transaction. Every maintenance mode checks both install and uninstall journals under the installation lock before proceeding. A restored runtime alone does not complete rollback: if registry or shortcut restoration fails, the journal and snapshot remain and the error identifies the recovery path.

## Acceptance

Reproduce the recorded input failures before editing. Run targeted and existing tests in both workspaces, type checks, builds, real-process priority tests with isolated data, and packaged input and persistence verification. Exercise installer transactions with disposable roots, foreign-edition sentinels, locked files, invalid payloads, rollback and preserved-data uninstall. Verify the native installer and generated archive. Keep source, tested binaries, installed copies, and untested physical hardware or service behavior distinct in the delivery record.
