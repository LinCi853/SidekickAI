# Independent backup format and recovery

## Scope

The backup is either a standard ZIP/ZIP64 archive or the compatible SABK v1 encrypted envelope described below. The file extension does not determine the format. A backup captures one explicitly selected application data root. Community and concept ownership remain separate; a backup is not permission to merge their profiles or delete either source.

An independent recovery extracts original files into a new directory. It does not install the application, modify a running profile, migrate databases, register plugins, or activate browser cookies. In particular, `cookieTransfer: "raw-profile"` preserves Chromium files whose operating-system encryption can still require their original account and profile. Portable cookie snapshots contain sensitive plaintext inside the ZIP and are protected only when the outer SABK envelope is encrypted.

## ZIP payload

New archives use ZIP64 with ordinary relative file paths and one UTF-8 JSON `manifest.json`. Standard ZIP tools can list and extract an unencrypted archive. Each file is stored with its original bytes; empty directories are not required. The reader checks ZIP CRC32, expanded length, SHA-256, safe relative names, case-insensitive collisions, links, and file/directory conflicts. Compression methods must be supported by the ZIP reader; ZIP-native encryption is not used.

The manifest requires:

| Field | Meaning |
| --- | --- |
| `format` | `sidekickai-backup` |
| `formatVersion` | Integer `1`; other values are rejected |
| `deviceId` | Nonempty original encryption/snapshot identity |
| `appVersion`, `exportedAt` | Application version and export timestamp |
| `options` | Boolean `basicData`, `cookies`, `indexedDB`, `cache`; basic data is required |
| `entries` | Relative path to lowercase hexadecimal SHA-256; includes `settings.db`, excludes `manifest.json` |

Current writers additionally provide `edition` (`community` or `concept`), `dataSchemaVersion`, `jobId`, `snapshotId`, `snapshotAt`, `cookieTransfer`, and an `inventory` array. Each inventory item contains `path`, byte `size`, `sha256`, and `state: "verified"`. Inventory names and hashes must match `entries`; byte sizes must match the actual ZIP payload. Unknown additive fields do not redefine the existing fields. A breaking format requires a new version and a reader with explicit support.

Supported limits are 100,000 ZIP entries including the manifest, a 64 MiB expanded manifest, 65,535 UTF-8 bytes per ZIP name, and exact safe-integer byte sizes and totals (at most 9,007,199,254,740,991). These are format/parser limits, not a promise that disk space, memory for metadata, or an operating-system filesystem supports every maximum. Contents stream through bounded buffers; the entry index and manifest remain proportional to the number of files. The 64 MiB maximum manifest can require substantially more memory after JSON parsing. Capacity checks retain an additional 32 MiB disk reserve per involved volume.

Plain ZIP checksums detect corruption; they are not signatures or proof of authorship. Legacy ZIPs without the current manifest may be read when they contain `settings.db` or `profiles.json`. Legacy inventory hashes are computed while reading and are not preexisting trusted checksums. The application still needs to validate database compatibility before adopting extracted data.

## Application import and protected drafts

The application determines full restore eligibility from the edition and supported data schema, not the software version alone. A missing edition/schema permits only automatic common-data migration; an unknown future schema is rejected. Common migration merges supported profiles, presets and API providers. Common migration automatically skips invalid individual records in those categories, with one completion summary; archive integrity, path validation and core database validation are never optional. Unselected browser-data categories are preserved from the current profile. A full database replacement does not merge arbitrary rows from the previous database.

Electron exports can add `sensitiveDrafts: { version: 1, entries: [...] }`. Each entry binds an `app_settings` key beginning with `windowDraft:` and the SHA-256 of its original base64 ciphertext string. A portable entry has `state: "portable"` and a JSON `value`; an unreadable entry has `state: "unavailable"` and `reason: "source-key-unavailable"`. Original database bytes remain unchanged. Draft values are sensitive plaintext inside the archive and private staging, protected by the optional outer SABK envelope during distribution.

After the destination Electron encryption context is ready, the application verifies each bound original record and transactionally encrypts portable values for that destination. Repeating an interrupted restore accepts an already re-encrypted record only when its decoded value matches the transport. Unreadable or invalid draft records and obsolete draft-recovery records are discarded from the destination database, with one completion summary. Temporary encryption-service unavailability aborts the restore without discarding drafts. The application removes consumed draft transport from its local restore manifest after a successful database commit; it does not rewrite the source archive.

Independent Node export preserves raw encrypted database records and does not perform Electron draft decryption. Its default full selection includes the original protected `Local State`, but that file alone does not guarantee recovery on another account or device. Excluding cookies also excludes this raw key context. Independent extraction does not activate or re-encrypt drafts; use a compatible application for that operation. A missing matching key cannot be reconstructed from ciphertext.

Application import presents file selection, a password when needed and one replacement confirmation. It keeps no permanent import history or selectable restore-copy registry. The active restore transaction retains the original directory only until acceptance or automatic rollback, then removes its verified temporary directories and request. Cleanup failure cannot undo an accepted restore. Unknown or altered directories are preserved rather than guessed.

## SABK v1 envelope

All offsets and lengths below count bytes. Integer fields are unsigned little-endian. No padding or trailer is present.

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 4 | ASCII `SABK` (`53 41 42 4b`) |
| 4 | 1 | Version `01` |
| 5 | 4 | UTF-8 salt/device identity length `S` |
| 9 | S | UTF-8 `deviceId`; 1 through 65,536 bytes |
| 9 + S | 12 | Random AES-GCM nonce |
| 21 + S | 16 | AES-GCM authentication tag |
| 37 + S | Remaining | Ciphertext of the complete ZIP archive |

Derive a 32-byte key using PBKDF2-HMAC-SHA256 with the UTF-8 password, UTF-8 device identity as salt, and 100,000 iterations. No Unicode normalization is performed. Encrypt with AES-256-GCM, a fresh cryptographically random 12-byte nonce, and a 16-byte authentication tag. No additional authenticated data is supplied. The tag authenticates the entire ciphertext; v1 does not separately authenticate the raw header bytes. The header's identity and nonce are required for successful decryption. There is no password recovery key or server dependency.

The GCM plaintext length is limited to 68,719,476,704 bytes (`2^36 - 32`). The writer checks a conservative archive estimate before capturing and the actual ZIP size before encryption. Larger selections require unencrypted ZIP64 or a smaller explicit selection; no new encrypted format or silent downgrade is performed. The nonce is never reused for continuation: interrupted encryption restarts from the verified ZIP with a new nonce. Finished encrypted artifacts can subsequently be copied in resumable blocks without the password.

Decryption writes into a private temporary file and publishes it only after GCM authentication succeeds. A wrong password or altered ciphertext cannot publish unauthenticated plaintext. Plaintext temporary files still exist while processing and may remain after process termination; an encrypted destination does not imply encrypted staging.

The deterministic interoperability vector in [sabk-v1-vector.json](sabk-v1-vector.json) supplies public fixture credentials, key, nonce, tag and complete bytes. Its plaintext is a short test string, not a ZIP, so it tests the envelope only; `verify` correctly rejects it as an application archive. The fixed nonce is exclusively for this fixture and must never be used by a production writer.

## Independent command-line tool

Build the bundled tool with `node scripts/build-backup-cli.cjs`. The default output is `build/backup-tools/sidekick-backup.cjs`. Run it with Node.js 24 or newer; offline database validation uses `node:sqlite`. The generated bundle includes its JavaScript dependencies and does not need an installed or running application, Electron process, or original executable. Redistributed Node.js and bundled dependencies retain their applicable license notices.

Examples, using disposable or deliberately chosen paths:

```text
node sidekick-backup.cjs verify --file D:/Backups/profile.zip
node sidekick-backup.cjs restore --file D:/Backups/profile.zip --target D:/Recovered/new-profile
node sidekick-backup.cjs decrypt --file D:/Backups/profile.sabackup --target D:/Recovered/decrypted.zip --password-stdin
node sidekick-backup.cjs export --source D:/Profiles/community --edition community --target D:/Backups/new.zip --temp-root D:/BackupJobs
node sidekick-backup.cjs jobs --temp-root D:/BackupJobs
node sidekick-backup.cjs status --job UUID --temp-root D:/BackupJobs
node sidekick-backup.cjs resume --job UUID --temp-root D:/BackupJobs --target E:/Backups/new.zip
node sidekick-backup.cjs cancel --job UUID --temp-root D:/BackupJobs
node sidekick-backup.cjs cancel --job UUID --temp-root D:/BackupJobs --discard
```

`--password-stdin` reads UTF-8 password bytes from standard input until EOF and removes one final LF or CRLF. Supply them through a secure caller; there is no password command-line argument. Do not place real passwords in shell history. The input limit is 64 KiB. The tool never stores the password in the job record. `export` includes all categories by default; `--exclude-cookies`, `--exclude-indexeddb`, and `--exclude-cache` are explicit exclusions. Source applications and their writers must already be stopped before independent offline export; this tool does not terminate processes or perform the application's save coordination.

`verify` checks the envelope and archive without applying data. `restore` checks and extracts into a private sibling staging directory, then publishes the requested new directory after all entries pass. Existing destinations are rejected. Validation failure removes this invocation's extraction staging so the same destination can be retried. A killed process can leave a `.sidekick-restore-*` sibling; it is not reported as a completed restore. `decrypt` also validates the decrypted ZIP before creating a new output file. Success is JSON with `success: true`; rejected operations exit nonzero with an error, or a job result explaining its waiting/cancelled/failed state.

Delivery of this tool comprises the generated bundle, this format document, the test vector, applicable licenses, and hashes of the delivered files. Either a separately available compatible Node.js runtime or an explicitly packaged standalone runtime is required. A successful source test is not evidence that a final distribution already includes these files.

## Durable tasks and interruption

The default job root is persistent user storage: `%LOCALAPPDATA%/SidekickAI/BackupJobs` on Windows (falling back to `~/AppData/Local`), `~/Library/Application Support/SidekickAI/BackupJobs` on macOS, and `$XDG_STATE_HOME/SidekickAI/BackupJobs` or `~/.local/state/SidekickAI/BackupJobs` elsewhere. `--temp-root` explicitly selects another staging volume; despite that option's historical name, choose a persistent location for restart recovery. Existing jobs in the older operating-system temporary `sidekick-backup-jobs` location are not moved; pass their original root to access them.

For isolated automation or a controlled launcher, `SIDEKICK_BACKUP_JOB_ROOT` can override the default with an absolute path; relative values are rejected. An explicit `--temp-root` or API `tempRoot` takes precedence. This does not relocate already existing tasks.

A job's private directory holds its JSON record, snapshot, manifest, entry log, ZIP/encrypted artifact, and transfer block log. On Windows it grants access to the current account and SYSTEM; the DACL is checked after creation and before loading an existing job. Inherited grants are removed from the private job directory; unexpected explicit grants cause rejection instead of recursively resetting the user's selected root. On other platforms the directory is mode 0700. These files can contain plaintext private data, including when the final backup is encrypted. Independent command-line and maintenance tasks remain until explicitly discarded. Ordinary application exports remove their own staging and transient task record after completion or failure; the final backup is preserved. Disk loss or external deletion of the staging directory removes the ability to resume from that snapshot.

After all snapshot bytes are copied and checked, the snapshot becomes the only compression and encryption input. Later source edits do not enter the same snapshot. Strict maintenance export additionally checks the original source tree before publication. An incomplete snapshot requires application save coordination or a fresh explicitly offline export; `resume` never promotes it to a complete backup.

Target transfer uses 4 MiB blocks, SHA-256 per block, an artifact hash, a task identity, and filesystem device/directory/file identities. The exclusively created partial file's identity is recorded before its first payload write. Resume checks the pathname and opened handle identities before truncation, even when no blocks have yet been acknowledged; matching bytes in a replacement file do not substitute for ownership. Data is flushed and read back before the block checkpoint is flushed and the task record atomically replaced. Resume rereads acknowledged blocks from both retained artifact and target, rejects mismatches, and discards only the unacknowledged tail. A changed target directory/device requires explicit rerouting, even if the drive letter is the same. Older records without partial-file identity cannot claim an existing partial file and require explicit rerouting. This is local filesystem identity validation; it does not authenticate a remote server or repair filesystem corruption.

Strict publication never replaces an unrelated existing final file. Filesystems with hard links can atomically publish the verified temporary file. Where hard links are unsupported, the writer exclusively creates the final file and records its filesystem identity before copying. Every 4 MiB publication block is flushed, read back, compared with the retained artifact, and checkpointed. A restarted task verifies the owned file identity and acknowledged prefix before continuing the same file. Replacing that file or changing an acknowledged block leaves the task waiting and preserves the existing bytes. An incomplete final filename can therefore exist while the task remains running, waiting, or cancelled; it is never a completed backup or deletion permission.

Exclusive creation and recording a new partial or final file identity are separate filesystem operations. A process or power loss exactly between them can leave an unowned empty filename; recovery conservatively preserves it and requires a new destination rather than guessing ownership. A completely published file is recognized by its full artifact digest, and strict source identity/content are checked again before completion. No ordinary filesystem API can promise recovery after physical media failure or falsely acknowledged flushes.

`cancel` requests cooperative cancellation and retains progress. `cancel --discard` requires the job to be stopped and verifies both target directory and partial-file identities before removing its partial transfer file and selected job's staging. An unowned or replaced partial is preserved with the job record. It preserves source data and all final filenames, including incomplete exclusive-publication outputs, for explicit review. Explicitly rerouted old partial files also remain at their old destinations. Corrupted job metadata is rejected rather than guessed or silently discarded. Tasks do not contain persistent authorization to operate on the source after its identity or selection changes.
