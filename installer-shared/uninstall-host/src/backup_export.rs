//! Verification of the installed application's strict, source-bound export.
use crate::{execute, plan};
use serde::{Deserialize, Serialize};
use sidekickai_uninstall_core::archive::{inspect_archive, require_source_entries, VerifiedArchive};
use sidekickai_uninstall_core::path::{normalize_absolute_path, normalize_target_path, paths_equal, validate_tree};
use sidekickai_uninstall_core::protocol::*;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportReceipt {
    ok: bool,
    strict: bool,
    file_path: String,
    source_root: String,
    source_entries: BTreeMap<String, String>,
    skipped_files: Vec<String>,
    options: BTreeMap<String, bool>,
    /// Exact exporter-time digest of the complete data tree. There is no serde
    /// default: a receipt from an older application lacks the field and fails to
    /// parse, so an old exporter can never authorize a deletion under the new
    /// complete-tree contract.
    tree_sha256: String,
}

pub(crate) struct VerifiedExport {
    pub results: Vec<BackupResult>,
    pub proofs: Vec<execute::BackupProof>,
}

struct ExportDirectory(PathBuf);
impl Drop for ExportDirectory {
    fn drop(&mut self) { execute::cleanup_directory(&self.0); }
}

#[cfg(test)]
#[path = "backup_export_integration_tests.rs"]
pub(crate) mod integration_tests;

fn failure(code: UninstallErrorCode, message: impl Into<String>) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::BackingUp, false, "")
}

fn verify_receipt(
    receipt: &[u8], inspected: &VerifiedArchive, data_root: &Path, output: &Path,
    selection: &BackupSelection, edition: &str,
) -> Result<u64, UninstallError> {
    let incomplete = |message: String| failure(UninstallErrorCode::BackupIncomplete, message);
    let receipt: ExportReceipt = serde_json::from_slice(receipt)
        .map_err(|error| incomplete(format!("严格导出回执缺失或无效：{error}")))?;
    if !receipt.ok || !receipt.strict || !receipt.skipped_files.is_empty() {
        return Err(incomplete("导出未保护全部所选源文件。".into()));
    }
    if inspected.edition.as_deref() != Some(edition) || inspected.options.as_ref() != Some(&receipt.options) {
        return Err(incomplete("备份清单的产品路线或选项与已确认安装不一致。".into()));
    }
    let source = normalize_target_path(&receipt.source_root)?;
    let exported = normalize_absolute_path(&receipt.file_path)?;
    if !paths_equal(source.as_path(), data_root) || !paths_equal(exported.as_path(), output) {
        return Err(incomplete("导出属于不同的数据根或输出文件。".into()));
    }
    for category in ["basicData", "cookies", "indexedDB", "cache"] {
        let expected = category == "basicData" || selection.categories.iter().any(|value| value == category);
        if receipt.options.get(category) != Some(&expected) {
            return Err(incomplete(format!("导出所选内容与 {category} 不一致。")));
        }
    }
    validate_tree(data_root)?;
    if receipt.tree_sha256.len() != 64 || !receipt.tree_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(incomplete("导出回执缺少有效的完整数据树摘要。".into()));
    }
    // The receipt must describe the exact tree the exporter snapshotted. A file
    // added to a selected directory after the export (which `source_entries`
    // cannot see) changes this digest and refuses the deletion before any
    // preparation.
    let current_tree = execute::export_tree_digest(data_root)
        .map_err(|error| incomplete(format!("完整数据树无法重新检查：{}", error.message)))?;
    if current_tree != receipt.tree_sha256 {
        return Err(incomplete("导出快照后完整数据树已变更，未删除任何内容。".into()));
    }
    for (entry, hash) in &receipt.source_entries {
        if entry.is_empty() || entry.contains('\\') || entry.contains(':')
            || entry.split('/').any(|part| part.is_empty() || part == "." || part == "..")
            || hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(incomplete("源清单包含不安全条目。".into()));
        }
        let source_file = normalize_absolute_path(data_root.join(entry))?;
        if !source_file.is_descendant_of(&source) {
            return Err(incomplete("源清单超出数据根范围。".into()));
        }
        let actual = execute::sha256_file(source_file.as_path()).map_err(incomplete)?;
        if &actual != hash {
            return Err(incomplete(format!("导出过程中源已变更或被省略：{entry}")));
        }
    }
    require_source_entries(inspected, &receipt.source_entries)?;
    Ok(inspected.entry_hashes.len() as u64)
}

#[derive(Serialize, Deserialize)]
struct CachedExport { receipt: ExportReceipt, result: BackupResult, requested_path: String }

fn installed_identity(directory: &Path) -> Result<(String, String), UninstallError> {
    let identity = sidekickai_uninstall_core::distribution::verify_installed_identity(directory)
        .map_err(|message| failure(UninstallErrorCode::TargetNotInstall, message))?;
    Ok((identity.body.edition, identity.body.product_version))
}

fn verified_application(root: &Path, executable: &Path) -> Result<sidekickai_uninstall_core::distribution::VerifiedFiles, String> {
    use sidekickai_uninstall_core::distribution as contract;
    let identity = contract::verify_installed_identity(root)?;
    let relative = executable.strip_prefix(root).map_err(|_| "应用入口不在已核验安装内。")?.to_string_lossy().replace('\\', "/");
    let entry = identity.body.files.iter().find(|entry| entry.path == relative).ok_or("本体证明没有绑定应用入口。")?;
    if entry.executable_architecture.as_deref() != Some(identity.receipt.native_architecture.as_str())
        || !identity.body.files.iter().any(|entry| entry.path == "resources/app.asar") {
        return Err("应用入口或应用归档未绑定准确架构。".into());
    }
    let pins = contract::pin_declared_files(root, &identity.body.files)?;
    if contract::pe_architecture(executable)? != identity.receipt.native_architecture { return Err("应用入口原生架构不一致。".into()); }
    Ok(pins)
}

fn verified_receipt_file(result_path: &Path, output: &Path, source: &Path, selection: &BackupSelection, edition: &str) -> Result<(ExportReceipt, u64), UninstallError> {
    let bytes = fs::read(result_path).map_err(|error| failure(UninstallErrorCode::BackupIncomplete, format!("导出回执无法读取：{error}")))?;
    let archive = inspect_archive(output, if selection.encrypt { selection.password.as_deref() } else { None })?;
    let count = verify_receipt(&bytes, &archive, source, output, selection, edition)?;
    let receipt = serde_json::from_slice(&bytes).map_err(|error| failure(UninstallErrorCode::BackupIncomplete, error.to_string()))?;
    Ok((receipt, count))
}

fn export_job_id(identity: &str, adapter: &str) -> String {
    use sha2::{Digest, Sha256};
    let value = format!("{:x}", Sha256::digest(format!("{identity}|{adapter}").as_bytes()));
    format!("{}-{}-4{}-a{}-{}", &value[..8], &value[8..12], &value[13..16], &value[17..20], &value[20..32])
}

fn proof_directory(request_id: &str) -> Result<PathBuf, UninstallError> {
    use sha2::{Digest, Sha256};
    let account_root = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let directory = account_root.join("SidekickAI-BackupProofs").join(format!("{:x}", Sha256::digest(request_id.as_bytes())));
    fs::create_dir_all(&directory).map_err(|e| failure(UninstallErrorCode::BackupPathUnwritable, e.to_string()))?;
    sidekickai_uninstall_core::path::reject_reparse_points(&directory)?;
    execute::harden_operation_directory(&directory)?;
    Ok(directory)
}

pub(crate) fn export_and_verify(
    plan: &plan::Plan, selection: &BackupSelection, operation_id: &str, request_id: &str,
) -> Result<VerifiedExport, UninstallError> {
    use sha2::{Digest, Sha256};
    let backup = plan.backup.as_ref().ok_or_else(|| failure(UninstallErrorCode::BackupPathInvalid, "备份路径未经确认。"))?;
    if plan.data_roots.is_empty() { return Err(failure(UninstallErrorCode::BackupIncomplete, "没有已确认的数据根。")); }
    let cache = proof_directory(request_id)?;
    let mut results = Vec::new();
    let mut proofs = Vec::new();
    for root in &plan.data_roots {
        let root_hash = format!("{:x}", Sha256::digest(root.path.to_lowercase().as_bytes()));
        let requested = if plan.data_roots.len() == 1 { backup.path.as_path().to_owned() } else {
            let base = backup.path.as_path();
            base.with_file_name(format!("{}-{}.{}", base.file_stem().unwrap_or_default().to_string_lossy(), &root_hash[..12], base.extension().unwrap_or_default().to_string_lossy()))
        };
        let key = format!("{:x}", Sha256::digest(format!("{}|{:?}|{}", root.path.to_lowercase(), selection.categories, selection.encrypt).as_bytes()));
        let cache_path = cache.join(format!("{key}.json"));
        let (result, proof) = export_root(plan, root, selection, &requested, &cache_path, operation_id).map_err(|error| {
            if results.is_empty() { error } else { error.with_detail("verifiedBackups", DetailValue::String(serde_json::to_string(&results).unwrap_or_default())) }
        })?;
        results.push(result); proofs.push(proof);
    }
    Ok(VerifiedExport { results, proofs })
}

fn export_root(plan: &plan::Plan, root: &DataRoot, selection: &BackupSelection, requested: &Path, cache_path: &Path, operation_id: &str) -> Result<(BackupResult, execute::BackupProof), UninstallError> {
    let data_root = normalize_target_path(&root.path)?;
    validate_tree(data_root.as_path())?;
    let owners = plan.targets.iter().filter(|target| root.associated_target_ids.contains(&target.id)).collect::<Vec<_>>();
    let install = owners.first().ok_or_else(|| failure(UninstallErrorCode::NoTarget, "没有与所选数据对应的安装。"))?;
    let (edition, version) = installed_identity(install.identity.path.as_path())?;
    for owner in &owners {
        owner.identity.verify_unchanged()?;
        if installed_identity(owner.identity.path.as_path())?.0 != edition {
            return Err(failure(UninstallErrorCode::TargetScopeInvalid, "同一资料目录关联了不同产品路线，无法生成单一路线的删除备份。"));
        }
    }
    let cached = fs::read(cache_path).ok().and_then(|bytes| serde_json::from_slice::<CachedExport>(&bytes).ok());
    if let Some(cached) = cached.filter(|entry| paths_equal(Path::new(&entry.requested_path), requested)) {
        let archive_path = PathBuf::from(&cached.result.path);
        let receipt = serde_json::to_vec(&cached.receipt).map_err(|e| failure(UninstallErrorCode::BackupIncomplete, e.to_string()))?;
        if let Ok(inspected) = inspect_archive(&archive_path, if selection.encrypt { selection.password.as_deref() } else { None }) {
            if verify_receipt(&receipt, &inspected, data_root.as_path(), &archive_path, selection, &edition).is_ok() {
                let hash = execute::sha256_file(&archive_path).map_err(|e| failure(UninstallErrorCode::BackupIncomplete, e))?;
                return Ok((cached.result, execute::BackupProof { path: archive_path.to_string_lossy().into_owned(), root: data_root.as_string(), entry_hashes: cached.receipt.source_entries, archive_sha256: hash, tree_sha256: cached.receipt.tree_sha256 }));
            }
        }
    }
    let mut output = if requested.exists() {
        requested.with_file_name(format!("{}-{}.{}", requested.file_stem().unwrap_or_default().to_string_lossy(), sidekickai_uninstall_core::random_id("snapshot")?, requested.extension().unwrap_or_default().to_string_lossy()))
    } else { requested.to_owned() };
    let scopes = plan.targets.iter().map(|target| target.identity.path.clone()).chain(plan.data_roots.iter().map(|root| normalize_target_path(&root.path)).collect::<Result<Vec<_>, _>>()?).collect::<Vec<_>>();
    sidekickai_uninstall_core::backup::validate_backup_path(&output, &selection.format, selection.encrypt, &scopes)?;
    let executable = sidekickai_uninstall_core::product::application_executable(install.identity.path.as_path());

    let directory = ExportDirectory(execute::create_operation_dir(&format!("{operation_id}-export"))?);
    let request_path = directory.0.join("export-request.json");
    let result_path = directory.0.join("export-result.json");
    use std::os::windows::fs::MetadataExt;
    use sha2::{Digest, Sha256};
    let source_created = fs::metadata(data_root.as_path()).map_err(|e| failure(UninstallErrorCode::BackupIncomplete, e.to_string()))?.creation_time();
    let source_digest = execute::export_tree_digest(data_root.as_path())?;
    let identity = format!("{:x}", Sha256::digest(format!("{}|{source_created}|{source_digest}|{edition}|{version}", cache_path.to_string_lossy()).as_bytes()));
    let job_id = export_job_id(&identity, "application");
    let request = serde_json::json!({
        "outputPath": output.to_string_lossy(), "encrypt": selection.encrypt, "jobId": job_id, "tempRoot": selection.staging_path,
        "passwordFromStdin": selection.encrypt, "categories": selection.categories,
        "expectedDataRoot": data_root.as_string(), "strict": true, "resultPath": result_path.to_string_lossy(),
    });
    fs::write(&request_path, request.to_string()).map_err(|error| failure(UninstallErrorCode::BackupExportFailed, format!("无法写入导出请求：{error}")))?;
    use std::os::windows::process::CommandExt;
    let application_pins = verified_application(install.identity.path.as_path(), &executable).ok();
    let exported = application_pins.is_some() && (|| -> std::io::Result<bool> {
        let mut child = Command::new(&executable).arg("--export-user-data").arg(&request_path)
            .creation_flags(0x0800_0000).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
        if selection.encrypt {
            let secret = serde_json::to_vec(&serde_json::json!({ "password": selection.password }))?;
            if let Err(error) = child.stdin.take().ok_or_else(|| std::io::Error::other("Export channel unavailable"))?.write_all(&secret) {
                let _ = child.kill(); let _ = child.wait(); return Err(error);
            }
        } else { drop(child.stdin.take()); }
        Ok(child.wait()?.success())
    })().unwrap_or(false);
    drop(application_pins);
    let _ = fs::remove_file(&request_path);
    let application_result = if exported { verified_receipt_file(&result_path, &output, data_root.as_path(), selection, &edition) }
        else { Err(failure(UninstallErrorCode::BackupExportFailed, "应用导出进程未完成。")) };
    let (receipt, count) = if let Ok(verified) = application_result { verified } else {
        let runtime = crate::backup_runtime::prepare(install.identity.path.as_path(), &directory.0, &edition)?;
        if output.exists() { output = output.with_file_name(format!("{}-recovery.{}", sidekickai_uninstall_core::random_id("backup")?, output.extension().unwrap_or_default().to_string_lossy())); }
        if result_path.exists() { fs::remove_file(&result_path).map_err(|error| failure(UninstallErrorCode::BackupExportFailed, error.to_string()))?; }
        let offline = serde_json::json!({
            "sourceRoot": data_root.as_string(), "edition": edition, "version": version,
            "targetPath": output.to_string_lossy(), "resultPath": result_path.to_string_lossy(), "jobId": export_job_id(&identity, "offline"), "tempRoot": selection.staging_path,
            "strict": true, "password": if selection.encrypt { selection.password.clone() } else { None },
            "options": { "basicData": true, "cookies": selection.categories.iter().any(|v| v == "cookies"),
                "indexedDB": selection.categories.iter().any(|v| v == "indexedDB"), "cache": selection.categories.iter().any(|v| v == "cache") },
        });
        crate::backup_runtime::export(&runtime, &offline)?;
        verified_receipt_file(&result_path, &output, data_root.as_path(), selection, &edition)?
    };
    let result = BackupResult { path: output.to_string_lossy().into_owned(), format: selection.format.clone(), categories: selection.categories.clone(), verified: true, entry_count: Some(count) };
    let proof = execute::BackupProof { path: result.path.clone(), root: data_root.as_string(), entry_hashes: receipt.source_entries.clone(), archive_sha256: execute::sha256_file(&output).map_err(|e| failure(UninstallErrorCode::BackupIncomplete, e))?, tree_sha256: receipt.tree_sha256.clone() };
    let cached = CachedExport { receipt, result: result.clone(), requested_path: requested.to_string_lossy().into_owned() };
    execute::write_atomic(cache_path, &serde_json::to_vec(&cached).map_err(|e| failure(UninstallErrorCode::BackupIncomplete, e.to_string()))?)
        .map_err(|e| failure(UninstallErrorCode::BackupIncomplete, format!("备份已生成，但恢复凭据无法保存：{e}")))?;
    Ok((result, proof))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_receipt_binds_root_selection_and_all_source_bytes() {
        let directory = ExportDirectory(execute::create_operation_dir("strict-receipt-test").unwrap());
        let data = directory.0.join("data");
        fs::create_dir(&data).unwrap();
        let edition = sidekickai_uninstall_core::product::edition_id();
        let payload = b"synthetic settings database bytes";
        use sha2::{Digest, Sha256};
        let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("manifest.json", options).unwrap();
        archive.write_all(serde_json::json!({ "format": "sidekickai-backup", "formatVersion": 1, "edition": edition,
            "deviceId": "fixture-device", "appVersion": "0.9.42", "exportedAt": "2026-10-07T00:00:00Z",
            "options": { "basicData": true, "cookies": false, "indexedDB": false, "cache": false },
            "entries": { "settings.db": format!("{:x}", Sha256::digest(payload)) } }).to_string().as_bytes()).unwrap();
        archive.start_file("settings.db", options).unwrap(); archive.write_all(payload).unwrap();
        let zip = sidekickai_uninstall_core::archive::inspect_bytes(&archive.finish().unwrap().into_inner(), None).unwrap();
        let output = directory.0.join("backup.zip");
        let selection = BackupSelection { format: BackupFormat::Zip, output_path: output.to_string_lossy().into_owned(), encrypt: false, password: None, staging_path: None, categories: vec!["basicData".into()] };
        let base_receipt = |tree: &str| serde_json::json!({
            "ok": true, "strict": true, "sourceRoot": data.to_string_lossy(), "filePath": output.to_string_lossy(),
            "sourceEntries": {}, "skippedFiles": [], "treeSha256": tree,
            "options": {"basicData": true, "cookies": false, "indexedDB": false, "cache": false},
        });

        // A receipt from an older application carries no complete-tree digest and
        // must fail closed instead of authorizing a deletion.
        let mut legacy = base_receipt("");
        legacy.as_object_mut().unwrap().remove("treeSha256");
        assert!(verify_receipt(legacy.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err());

        // An empty source inventory is refused even with the correct digest.
        let mut receipt = base_receipt(&execute::export_tree_digest(&data).unwrap());
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err());

        fs::write(data.join("settings.db"), b"synthetic settings database bytes").unwrap();
        receipt["sourceEntries"] = serde_json::json!({"settings.db": execute::sha256_file(&data.join("settings.db")).unwrap()});
        receipt["treeSha256"] = serde_json::json!(execute::export_tree_digest(&data).unwrap());
        assert_eq!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).unwrap(), 2);
        let foreign = if edition == "community" { "concept" } else { "community" };
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, foreign).is_err());

        // A file added after the snapshot is invisible to `sourceEntries` but
        // changes the complete-tree digest: the host refuses before any deletion.
        fs::write(data.join("late-added.txt"), b"added after the export snapshot").unwrap();
        assert!(
            verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err(),
            "a file added after the export snapshot cannot authorize deletion"
        );
        fs::remove_file(data.join("late-added.txt")).unwrap();

        fs::write(data.join("settings.db"), b"changed source").unwrap();
        receipt["sourceEntries"] = serde_json::json!({"settings.db": execute::sha256_file(&data.join("settings.db")).unwrap()});
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err(), "a valid ZIP with different source bytes cannot authorize deletion");
        receipt["skippedFiles"] = serde_json::json!(["notes.db"]);
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err());
        receipt["sourceRoot"] = serde_json::json!(directory.0.to_string_lossy());
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection, edition).is_err());
    }
}
