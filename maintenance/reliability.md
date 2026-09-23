# Standalone reliability contract

## Workspace and scope

The open-source workspace is maintained independently from the development edition. The public baseline is commit `71015fcd4430f2ef7fc2bdcb8dab81c01f3bf54d`. Changes belong to this repository; application data, private configuration and unpublished changes from other workspaces are not inputs.

The current verification covers Windows x64 desktop startup, local capabilities, persistence across restarts, backup and restore, instance isolation and portable packaging. Installer repair and ARM64 execution require their own evidence before claiming release readiness. Remote AI services require user configuration and are not prerequisites for local operations.

The maintained edition uses the `sidekickai-opensource` package and installed data name, `com.sidekickai.opensource` application identity and `SidekickAI-OpenSource` executable. Portable data remains beside its executable; development data remains in the workspace. An absolute `SIDEKICK_DATA_DIR` override selects an explicit isolated profile. Runtime initialization establishes these paths and acquires the profile lock before importing persistent stores. Unrelated processes are never classified as disposable remnants.

Backup export uses SQLite's online snapshot facility without invalidating live database consumers. Restore validates every included database before closing windows, replaces only included data roots, retains original bytes in a sibling recovery directory and rolls back completed replacements if a later file is locked. Omitted browser session data is preserved. Windows session locks may cause an import to be rejected; rejection must preserve the existing records.

## Observable behavior

- A fresh profile opens the application and settings without an uncaught main-process or renderer exception.
- The active data directory is determined before stores and the single-instance lock are initialized. Separate portable directories coexist; a second process using the same directory cannot open a competing database writer.
- Local notes, whiteboards, prompts and settings remain usable without external network access and survive a normal restart.
- Main-window navigation history remains available when the optional browser module is disabled, toggled or cleared.
- Backup captures committed local records and assets. Restoring into a separate disposable profile preserves their content. Invalid or incomplete inputs do not silently replace the destination with partial data.
- Closing a window during delayed state persistence does not access a destroyed native window or leave an unhandled timer exception.
- Packaging never terminates unrelated application processes and never embeds runtime user data. The archive contains the executable, matching Electron runtime, native modules, local assets and license notices.
- Validation failures identify the operation and retain enough evidence to reproduce the condition.

## Verification method

Use the existing locked dependencies and isolated test profiles. Establish a failing reproduction before changing a defective behavior. Prefer meaningful tests at the storage, process and packaged-application boundaries. Keep browser interactions visible and preserve logs, screenshots and machine-readable results in the local reliability evidence directory.

Run the existing type check and unit suite, targeted regression tests and the desktop compiler for changed source. Test the resulting x64 portable application itself. Review the final diff independently from implementation, simplify redundant logic and commit the reviewed changes locally. Do not publish or push automatically.

## Evidence boundaries

A compiled bundle or passing mocked test does not establish runtime readiness. Portable verification does not establish installer repair safety, and x64 execution does not establish ARM64 compatibility. External provider credentials, personal installations, microphone recordings and real user databases are outside the disposable fixture set.
