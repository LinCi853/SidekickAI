//! Verification of the installed application's strict, source-bound export.
use crate::{execute, plan};
use serde::Deserialize;
use sidekickai_uninstall_core::archive::{inspect_bytes, require_source_entries};
use sidekickai_uninstall_core::path::{normalize_absolute_path, normalize_target_path, paths_equal, validate_tree};
use sidekickai_uninstall_core::protocol::*;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
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
    pub result: BackupResult,
    pub proof: execute::BackupProof,
}

struct ExportDirectory(PathBuf);
impl Drop for ExportDirectory {
    fn drop(&mut self) { execute::cleanup_directory(&self.0); }
}

fn failure(code: UninstallErrorCode, message: impl Into<String>) -> UninstallError {
    UninstallError::new(code, message, UninstallPhase::BackingUp, false, "")
}

fn verify_receipt(
    receipt: &[u8], archive: &[u8], data_root: &Path, output: &Path,
    selection: &BackupSelection,
) -> Result<u64, UninstallError> {
    let incomplete = |message: String| failure(UninstallErrorCode::BackupIncomplete, message);
    let receipt: ExportReceipt = serde_json::from_slice(receipt)
        .map_err(|error| incomplete(format!("严格导出回执缺失或无效：{error}")))?;
    if !receipt.ok || !receipt.strict || !receipt.skipped_files.is_empty() {
        return Err(incomplete("导出未保护全部所选源文件。".into()));
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
    let inspected = inspect_bytes(archive, if selection.encrypt { selection.password.as_deref() } else { None })?;
    require_source_entries(&inspected, &receipt.source_entries)?;
    Ok(inspected.entry_hashes.len() as u64)
}

pub(crate) fn export_and_verify(
    plan: &plan::Plan, selection: &BackupSelection, operation_id: &str,
) -> Result<VerifiedExport, UninstallError> {
    let backup = plan.backup.as_ref().ok_or_else(|| failure(UninstallErrorCode::BackupPathInvalid, "备份路径未经确认。"))?;
    if plan.data_roots.len() != 1 {
        return Err(failure(UninstallErrorCode::BackupIncomplete, "兼容备份需要恰好一个已确认的数据根。"));
    }
    let data_root = normalize_target_path(&plan.data_roots[0].path)?;
    validate_tree(data_root.as_path())?;
    let install = plan.targets.iter().find(|target| plan.data_roots[0].associated_target_ids.contains(&target.id))
        .ok_or_else(|| failure(UninstallErrorCode::NoTarget, "没有与所选数据对应的安装。"))?;
    install.identity.verify_unchanged()?;
    let executable = sidekickai_uninstall_core::product::application_executable(install.identity.path.as_path());
    if !executable.is_file() {
        return Err(failure(UninstallErrorCode::BackupExportFailed, "主程序不可用；未删除数据。"));
    }
    let directory = ExportDirectory(execute::create_operation_dir(&format!("{operation_id}-export"))?);
    let request_path = directory.0.join("export-request.json");
    let result_path = directory.0.join("export-result.json");
    let request = serde_json::json!({
        "outputPath": backup.path.as_string(),
        "encrypt": selection.encrypt,
        "password": selection.password.clone().unwrap_or_default(),
        "categories": backup.categories,
        "expectedDataRoot": data_root.as_string(),
        "strict": true,
        "resultPath": result_path.to_string_lossy(),
    });
    fs::write(&request_path, request.to_string()).map_err(|error| failure(UninstallErrorCode::BackupExportFailed, format!("无法写入导出请求：{error}")))?;
    use std::os::windows::process::CommandExt;
    let status = std::process::Command::new(&executable)
        .arg("--export-user-data").arg(&request_path).creation_flags(0x0800_0000).status()
        .map_err(|error| failure(UninstallErrorCode::BackupExportFailed, format!("无法启动导出：{error}")))?;
    // The guard removes the password-bearing request on every return path.
    let _ = fs::remove_file(&request_path);
    if !status.success() {
        return Err(failure(UninstallErrorCode::BackupExportFailed, "应用导出失败；未删除数据。"));
    }
    let receipt = fs::read(&result_path).map_err(|error| failure(UninstallErrorCode::BackupIncomplete, format!("导出回执无法读取：{error}")))?;
    let archive = fs::read(backup.path.as_path()).map_err(|error| failure(UninstallErrorCode::BackupIncomplete, format!("导出文件无法读取：{error}")))?;
    let count = verify_receipt(&receipt, &archive, data_root.as_path(), backup.path.as_path(), selection)?;
    let receipt: ExportReceipt = serde_json::from_slice(&receipt)
        .map_err(|error| failure(UninstallErrorCode::BackupIncomplete, error.to_string()))?;
    use sha2::{Digest, Sha256};
    Ok(VerifiedExport {
        result: BackupResult { path: backup.path.as_string(), format: backup.format.clone(), categories: backup.categories.clone(), verified: true, entry_count: Some(count) },
        proof: execute::BackupProof {
            path: backup.path.as_string(), root: data_root.as_string(),
            entry_hashes: receipt.source_entries,
            archive_sha256: format!("{:x}", Sha256::digest(&archive)),
            tree_sha256: receipt.tree_sha256,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_receipt_binds_root_selection_and_all_source_bytes() {
        let directory = ExportDirectory(execute::create_operation_dir("strict-receipt-test").unwrap());
        let data = directory.0.join("data");
        fs::create_dir(&data).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../uninstall-core/tests/fixtures/node-backup.json")).unwrap();
        let zip = fixture["zipHex"].as_str().unwrap().as_bytes().chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()).collect::<Vec<_>>();
        let output = directory.0.join("backup.zip");
        let selection = BackupSelection { format: BackupFormat::Zip, output_path: output.to_string_lossy().into_owned(), encrypt: false, password: None, categories: vec!["basicData".into()] };
        let base_receipt = |tree: &str| serde_json::json!({
            "ok": true, "strict": true, "sourceRoot": data.to_string_lossy(), "filePath": output.to_string_lossy(),
            "sourceEntries": {}, "skippedFiles": [], "treeSha256": tree,
            "options": {"basicData": true, "cookies": false, "indexedDB": false, "cache": false},
        });

        // A receipt from an older application carries no complete-tree digest and
        // must fail closed instead of authorizing a deletion.
        let mut legacy = base_receipt("");
        legacy.as_object_mut().unwrap().remove("treeSha256");
        assert!(verify_receipt(legacy.to_string().as_bytes(), &zip, &data, &output, &selection).is_err());

        // An empty source inventory is refused even with the correct digest.
        let mut receipt = base_receipt(&execute::export_tree_digest(&data).unwrap());
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).is_err());

        fs::write(data.join("settings.db"), b"synthetic settings database bytes").unwrap();
        receipt["sourceEntries"] = serde_json::json!({"settings.db": execute::sha256_file(&data.join("settings.db")).unwrap()});
        receipt["treeSha256"] = serde_json::json!(execute::export_tree_digest(&data).unwrap());
        assert_eq!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).unwrap(), 3);

        // A file added after the snapshot is invisible to `sourceEntries` but
        // changes the complete-tree digest: the host refuses before any deletion.
        fs::write(data.join("late-added.txt"), b"added after the export snapshot").unwrap();
        assert!(
            verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).is_err(),
            "a file added after the export snapshot cannot authorize deletion"
        );
        fs::remove_file(data.join("late-added.txt")).unwrap();

        fs::write(data.join("settings.db"), b"changed source").unwrap();
        receipt["sourceEntries"] = serde_json::json!({"settings.db": execute::sha256_file(&data.join("settings.db")).unwrap()});
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).is_err(), "a valid ZIP with different source bytes cannot authorize deletion");
        receipt["skippedFiles"] = serde_json::json!(["notes.db"]);
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).is_err());
        receipt["sourceRoot"] = serde_json::json!(directory.0.to_string_lossy());
        assert!(verify_receipt(receipt.to_string().as_bytes(), &zip, &data, &output, &selection).is_err());
    }
}
