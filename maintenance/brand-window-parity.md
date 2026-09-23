# Brand and window presentation parity

The user requested the established application's icons and window names for easier switching between editions. Reference only the approved, tracked application icon exports and visible title conventions in the sibling workspace. Concept artwork, private data and unrelated implementation changes remain outside this task.

## Requirements

- Use the approved application PNG, multi-resolution Windows ICO, Windows tray images at native and double density, and macOS template image. Keep their reference hashes in the local delivery record.
- Give native application windows the shared icon by default while preserving an explicit profile icon.
- Preserve distinguishable Chinese titles after renderer load and reload: settings, advanced panel, chat, history search, prompt library, application editor, data migration, onboarding, browser, and history/download management.
- Reflect the active tab's title in main and detached windows. Use the visible header for named auxiliary windows, without repeating the product name.
- Replace the loading screen's obsolete letter placeholder with the approved application icon.
- Preserve the independent executable name, application ID, profile path and instance lock. No functional modules or user configuration are copied from the sibling edition.
- Retain the previous portable candidate. Deliver a new candidate with the updated executable resource and verify its real window titles and embedded icons.

## Validation

Record the existing title override in an isolated Electron instance before changing it. Verify native titles after page readiness and reload, dynamic tab renaming, source/reference icon hashes, packaged resources and the new executable icon. Run typecheck, existing unit tests and the required build. Review and simplify the diff before a local commit; do not push.
