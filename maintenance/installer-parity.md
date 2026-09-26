# Shared installer and uninstaller experience

## Scope

The independently maintained editions use the same public-authored wizard presentation core and design revision. Product versions, executable names, profile roots, registrations, payloads, licenses and optional capabilities remain edition inputs. The online edition keeps its existing cloud resource and plugin contracts behind its own adapters.

The public core is authored in the open-source repository and mirrored byte-for-byte into the online workspace. It has no private imports, sibling-repository dependency, credentials, cloud configuration or plugin runtime implementation. A parity check reports divergent files instead of silently overwriting either workspace.

## User-visible contract

- Install, repair and uninstall share the brand shell, current-stage navigation, action placement, confirmation style and operation detail presentation.
- Every entry identifies the edition and product version. Repair and upgrade show the selected target, old and new versions, and the data-retention policy before execution.
- The default installation scope is the current user. Maintenance inherits the selected target's scope and saved configuration.
- Uninstall defaults to preserving data. Export-and-remove and direct removal are separate explicit choices. Edition-specific export options stay within the common policy layout.
- Close buttons and native close gestures follow the same renderer flow. Pending operations finish or reach an accepted cancellation point before closing. Failed settings persistence keeps the wizard open; repeated gestures cannot finalize twice.
- Errors remain visible and operation details are copyable. A refused cancellation never claims that work was rolled back.

## Verification

Verify both installation renderers and the online standalone uninstaller using their compiled interfaces with controlled native adapters. Exercise target selection, retained data, close confirmation, rejected persistence, cancellation refusal and repeated finalization. Check common source hashes, compile both adapters, and inspect screenshots at the supported window size. Native transaction evidence remains separate from renderer evidence; Windows x64 checks do not claim ARM64 or UAC desktop validation.
