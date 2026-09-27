use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const UNINSTALL_PROTOCOL_VERSION: u32 = 1;
pub const UNINSTALL_CONFIRMATION: &str = "delete-v1";
pub const UNINSTALL_EVENT: &str = "uninstall:event";
pub const BACKUP_CATEGORIES: [&str; 4] =
    ["basicData", "cookies", "indexedDB", "cache"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UninstallEntry {
    Installed,
    Installer,
    Registry,
    CompatFlag,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UninstallArch {
    X64,
    Arm64,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InstallScope {
    PerUser,
    AllUsers,
    Portable,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataStrategy {
    Keep,
    Export,
    Delete,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackupFormat {
    Sabackup,
    Zip,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UninstallPhase {
    Accepted,
    Scanning,
    Validating,
    Stopping,
    BackingUp,
    Commit,
    RemovingShortcuts,
    RemovingData,
    RemovingInstall,
    RemovingRegistry,
    Verifying,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UninstallTerminal {
    Completed,
    Cancelled,
    Failed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Hash, Ord, PartialOrd)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UninstallErrorCode {
    InvalidRequest,
    NoTarget,
    TargetChanged,
    TargetNotConfirmed,
    TargetScopeInvalid,
    TargetIdentityMismatch,
    UnsafePath,
    PathReparsePoint,
    TargetIsRoot,
    TargetIsParent,
    TargetNotDirectory,
    TargetNotInstall,
    ArchMismatch,
    ProcessRunning,
    ProcessStopFailed,
    BackupPathInvalid,
    BackupPathInScope,
    BackupPathUnwritable,
    BackupPasswordRequired,
    BackupFormatInvalid,
    BackupIncomplete,
    BackupExportFailed,
    DeleteFailed,
    RegistryFailed,
    ElevationCancelled,
    ElevationFailed,
    AlreadyRunning,
    DuplicateRequest,
    CancelTooLate,
    Internal,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentityConfidence {
    Strong,
    Degraded,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UninstallEntryMode {
    Standalone,
    Installer,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UninstallTargetId {
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallLocation {
    pub edition: String,
    pub id: UninstallTargetId,
    pub path: String,
    pub display_path: String,
    pub source: Vec<UninstallEntry>,
    pub scope: InstallScope,
    pub arch: UninstallArch,
    pub version: Option<String>,
    pub registered: bool,
    pub registered_roots: Vec<String>,
    pub executable_present: bool,
    pub resources_present: bool,
    pub identity_confidence: IdentityConfidence,
    pub running_pids: Vec<u32>,
    pub removable: bool,
    pub non_removable_reason: Option<UninstallErrorCode>,
    pub recommended: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallInfo {
    pub protocol_version: u32,
    pub uninstaller_version: String,
    pub host_arch: UninstallArch,
    pub entry: UninstallEntryMode,
    pub supports_elevation: bool,
    pub supports_backup: bool,
    pub supports_silent: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct UninstallScanRequest {}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataRoot {
    pub path: String,
    pub source: String,
    pub removable: bool,
    pub associated_target_ids: Vec<UninstallTargetId>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallScanResponse {
    pub scan_id: String,
    pub generated_at: String,
    pub locations: Vec<UninstallLocation>,
    pub recommended_target_id: Option<UninstallTargetId>,
    pub data_roots: Vec<DataRoot>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupSelection {
    pub format: BackupFormat,
    pub output_path: String,
    pub encrypt: bool,
    /// A password is accepted only in the in-memory command object.  It is
    /// deliberately omitted by serde serialization before a worker request is
    /// persisted or logged.
    #[serde(skip_serializing, default)]
    pub password: Option<String>,
    pub categories: Vec<String>,
}

impl fmt::Debug for BackupSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BackupSelection")
            .field("format", &self.format)
            .field("output_path", &self.output_path)
            .field("encrypt", &self.encrypt)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("categories", &self.categories)
            .finish()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UninstallRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub scan_id: String,
    pub target_id: UninstallTargetId,
    pub strategy: DataStrategy,
    pub backup: Option<BackupSelection>,
    pub additional_target_ids: Vec<UninstallTargetId>,
    pub confirmation: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallAccepted {
    pub request_id: String,
    pub operation_id: String,
    pub state: String,
}

impl UninstallAccepted {
    pub fn new(request_id: impl Into<String>, operation_id: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            operation_id: operation_id.into(),
            state: "accepted".to_string(),
        }
    }

    pub fn is_valid(&self) -> bool {
        self.state == "accepted"
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub format: BackupFormat,
    pub categories: Vec<String>,
    pub verified: bool,
    pub entry_count: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum DetailValue {
    String(String),
    Number(i64),
    Bool(bool),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallError {
    pub code: UninstallErrorCode,
    pub message: String,
    pub phase: UninstallPhase,
    pub retryable: bool,
    pub operation_id: String,
    pub details: Option<BTreeMap<String, DetailValue>>,
}

impl UninstallError {
    pub fn new(
        code: UninstallErrorCode,
        message: impl Into<String>,
        phase: UninstallPhase,
        retryable: bool,
        operation_id: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            phase,
            retryable,
            operation_id: operation_id.into(),
            details: None,
        }
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: DetailValue) -> Self {
        self.details
            .get_or_insert_with(BTreeMap::new)
            .insert(key.into(), value);
        self
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(
            UninstallErrorCode::InvalidRequest,
            message,
            UninstallPhase::Validating,
            false,
            "",
        )
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub request_id: String,
    pub operation_id: String,
    pub state: UninstallTerminal,
    pub phase: UninstallPhase,
    pub target_ids: Vec<UninstallTargetId>,
    pub removed_install_paths: Vec<String>,
    pub removed_data_roots: Vec<String>,
    pub backup: Option<BackupResult>,
    pub warnings: Vec<String>,
    pub error: Option<UninstallError>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallEvent {
    pub protocol_version: u32,
    pub operation_id: String,
    pub request_id: String,
    pub sequence: u64,
    pub phase: UninstallPhase,
    pub progress: u8,
    pub message: String,
    pub terminal: bool,
    pub result: Option<UninstallResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UninstallCallerIdentity {
    pub caller_user_sid: String,
    pub caller_user_profile: String,
    pub launcher_path: String,
    pub source_path: Option<String>,
    pub effective_user_sid: String,
    pub effective_is_elevated: bool,
    pub controller_sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CancelState {
    CancelRequested,
    TooLate,
    NotFound,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelResponse {
    pub operation_id: String,
    pub accepted: bool,
    pub state: CancelState,
}

pub fn known_backup_category(category: &str) -> bool {
    BACKUP_CATEGORIES.contains(&category)
}

/// Validate the part of a request that is independent of the scanned target.
/// Paths and scan-token membership are checked by `plan` after this succeeds.
pub fn validate_request(request: &UninstallRequest) -> Result<(), UninstallError> {
    if request.protocol_version != UNINSTALL_PROTOCOL_VERSION {
        return Err(UninstallError::invalid_request(
            "不支持的卸载协议版本",
        ));
    }
    validate_identifier(&request.request_id, "requestId")?;
    validate_identifier(&request.scan_id, "scanId")?;
    validate_token(&request.target_id)?;
    for target_id in &request.additional_target_ids {
        validate_token(target_id)?;
    }
    if request.confirmation != UNINSTALL_CONFIRMATION {
        return Err(UninstallError::new(
            UninstallErrorCode::TargetNotConfirmed,
            "卸载确认无效",
            UninstallPhase::Validating,
            false,
            "",
        ));
    }

    match request.strategy {
        DataStrategy::Export => {
            let backup = request.backup.as_ref().ok_or_else(|| {
                UninstallError::new(
                    UninstallErrorCode::BackupPasswordRequired,
                    "导出策略需要备份设置",
                    UninstallPhase::Validating,
                    false,
                    "",
                )
            })?;
            validate_backup_shape(backup)?;
        }
        DataStrategy::Keep | DataStrategy::Delete => {
            if request.backup.is_some() {
                return Err(UninstallError::invalid_request(
                    "备份设置仅对导出策略有效",
                ));
            }
        }
    }
    Ok(())
}

pub fn validate_backup_shape(selection: &BackupSelection) -> Result<Vec<String>, UninstallError> {
    if selection.output_path.trim().is_empty() {
        return Err(UninstallError::new(
            UninstallErrorCode::BackupPathInvalid,
            "备份输出路径为空",
            UninstallPhase::Validating,
            false,
            "",
        ));
    }
    if selection.encrypt && selection.password.as_deref().unwrap_or("").is_empty() {
        return Err(UninstallError::new(
            UninstallErrorCode::BackupPasswordRequired,
            "加密备份需要密码",
            UninstallPhase::Validating,
            false,
            "",
        ));
    }
    if !selection.encrypt && selection.password.is_some() {
        return Err(UninstallError::invalid_request(
            "密码仅对加密备份有效",
        ));
    }

    let mut seen = BTreeSet::new();
    let mut categories = Vec::with_capacity(selection.categories.len());
    for category in &selection.categories {
        if !known_backup_category(category) {
            return Err(UninstallError::new(
                UninstallErrorCode::BackupFormatInvalid,
                format!("未知备份分类：{category}"),
                UninstallPhase::Validating,
                false,
                "",
            ));
        }
        if seen.insert(category.clone()) {
            categories.push(category.clone());
        }
    }
    if !seen.contains("basicData") {
        return Err(UninstallError::new(
            UninstallErrorCode::BackupIncomplete,
            "备份分类必须包含 basicData",
            UninstallPhase::Validating,
            false,
            "",
        ));
    }
    Ok(categories)
}

pub fn validate_token(target_id: &UninstallTargetId) -> Result<(), UninstallError> {
    if target_id.token.is_empty()
        || target_id.token.len() > 256
        || target_id
            .token
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':' | '\0'))
    {
        return Err(UninstallError::new(
            UninstallErrorCode::InvalidRequest,
            "目标令牌无效",
            UninstallPhase::Validating,
            false,
            "",
        ));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str) -> Result<(), UninstallError> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(|character| character.is_control())
    {
        return Err(UninstallError::new(
            UninstallErrorCode::InvalidRequest,
            format!("{field} 无效"),
            UninstallPhase::Validating,
            false,
            "",
        ));
    }
    Ok(())
}

pub fn validate_location(location: &UninstallLocation) -> Result<(), UninstallError> {
    for root in &location.registered_roots {
        if root != "HKCU" && root != "HKLM" {
            return Err(UninstallError::new(
                UninstallErrorCode::InvalidRequest,
                "registeredRoots 包含未知注册表根",
                UninstallPhase::Scanning,
                false,
                "",
            ));
        }
    }
    if location.removable && location.non_removable_reason.is_some() {
        return Err(UninstallError::new(
            UninstallErrorCode::InvalidRequest,
            "可移除目标不能带有不可移除原因",
            UninstallPhase::Scanning,
            false,
            "",
        ));
    }
    validate_token(&location.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(strategy: DataStrategy, backup: Option<BackupSelection>) -> UninstallRequest {
        UninstallRequest {
            protocol_version: UNINSTALL_PROTOCOL_VERSION,
            request_id: "request-1".into(),
            scan_id: "scan-1".into(),
            target_id: UninstallTargetId { token: "a".repeat(64) },
            strategy,
            backup,
            additional_target_ids: Vec::new(),
            confirmation: UNINSTALL_CONFIRMATION.into(),
        }
    }

    fn selection(encrypt: bool, password: Option<&str>, categories: &[&str]) -> BackupSelection {
        BackupSelection {
            format: if encrypt { BackupFormat::Sabackup } else { BackupFormat::Zip },
            output_path: r"C:\Backups\SidekickAI.sabackup".into(),
            encrypt,
            password: password.map(str::to_string),
            categories: categories.iter().map(|c| c.to_string()).collect(),
        }
    }

    #[test]
    fn request_shape_is_validated_before_anything_else() {
        let mut wrong_protocol = request(DataStrategy::Keep, None);
        wrong_protocol.protocol_version = 2;
        assert_eq!(validate_request(&wrong_protocol).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut empty_request_id = request(DataStrategy::Keep, None);
        empty_request_id.request_id = String::new();
        assert_eq!(validate_request(&empty_request_id).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut unconfirmed = request(DataStrategy::Keep, None);
        unconfirmed.confirmation = "delete-v2".into();
        assert_eq!(validate_request(&unconfirmed).unwrap_err().code, UninstallErrorCode::TargetNotConfirmed);

        // A bare path can never be smuggled in as a target identity.
        let mut path_token = request(DataStrategy::Keep, None);
        path_token.target_id = UninstallTargetId { token: r"C:\Program Files\SidekickAI".into() };
        assert_eq!(validate_request(&path_token).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        assert!(validate_request(&request(DataStrategy::Keep, None)).is_ok());
    }

    #[test]
    fn strategy_and_backup_selection_must_agree() {
        // export requires a backup selection
        assert_eq!(
            validate_request(&request(DataStrategy::Export, None)).unwrap_err().code,
            UninstallErrorCode::BackupPasswordRequired
        );
        // keep/delete must not carry one
        assert_eq!(
            validate_request(&request(DataStrategy::Delete, Some(selection(false, None, &["basicData"])))).unwrap_err().code,
            UninstallErrorCode::InvalidRequest
        );
        // encrypted backup requires a password; a plain one must not carry it
        assert_eq!(
            validate_request(&request(DataStrategy::Export, Some(selection(true, None, &["basicData"])))).unwrap_err().code,
            UninstallErrorCode::BackupPasswordRequired
        );
        assert_eq!(
            validate_request(&request(DataStrategy::Export, Some(selection(false, Some("secret"), &["basicData"])))).unwrap_err().code,
            UninstallErrorCode::InvalidRequest
        );
        assert!(validate_request(&request(DataStrategy::Export, Some(selection(true, Some("secret"), &["basicData"])))).is_ok());
    }

    #[test]
    fn backup_categories_are_deduplicated_and_basic_data_is_required() {
        let categories = validate_backup_shape(&selection(true, Some("secret"), &["basicData", "cookies", "cookies"])).unwrap();
        assert_eq!(categories, vec!["basicData".to_string(), "cookies".to_string()]);

        assert_eq!(
            validate_backup_shape(&selection(true, Some("secret"), &["cookies"])).unwrap_err().code,
            UninstallErrorCode::BackupIncomplete
        );
        assert_eq!(
            validate_backup_shape(&selection(true, Some("secret"), &["basicData", "everything"])).unwrap_err().code,
            UninstallErrorCode::BackupFormatInvalid
        );
        assert_eq!(
            validate_backup_shape(&selection(true, Some("secret"), &[])).unwrap_err().code,
            UninstallErrorCode::BackupIncomplete
        );
        // Categories the product cannot actually back up must be rejected, not silently accepted.
        assert_eq!(
            validate_backup_shape(&selection(true, Some("secret"), &["basicData", "voiceAssets"])).unwrap_err().code,
            UninstallErrorCode::BackupFormatInvalid
        );
        assert!(!known_backup_category("voiceAssets"));
        assert!(!known_backup_category("passwords"));
    }

    #[test]
    fn empty_backup_output_path_is_rejected() {
        let mut empty = selection(false, None, &["basicData"]);
        empty.output_path = "   ".into();
        assert_eq!(validate_backup_shape(&empty).unwrap_err().code, UninstallErrorCode::BackupPathInvalid);
    }

    #[test]
    fn locations_must_declare_known_registry_roots_and_consistent_removability() {
        let base = |token: &str| UninstallLocation {
            edition: crate::product::edition_id().into(),
            id: UninstallTargetId { token: token.into() },
            path: r"C:\Apps\SidekickAI".into(),
            display_path: r"C:\Apps\SidekickAI".into(),
            source: vec![UninstallEntry::Installed],
            scope: InstallScope::PerUser,
            arch: UninstallArch::X64,
            version: None,
            registered: false,
            registered_roots: Vec::new(),
            executable_present: true,
            resources_present: true,
            identity_confidence: IdentityConfidence::Strong,
            running_pids: Vec::new(),
            removable: true,
            non_removable_reason: None,
            recommended: false,
        };
        assert!(validate_location(&base("token-1")).is_ok());

        let mut unknown_root = base("token-2");
        unknown_root.registered_roots = vec!["HKCR".into()];
        assert_eq!(validate_location(&unknown_root).unwrap_err().code, UninstallErrorCode::InvalidRequest);

        let mut contradictory = base("token-3");
        contradictory.non_removable_reason = Some(UninstallErrorCode::TargetNotInstall);
        assert_eq!(validate_location(&contradictory).unwrap_err().code, UninstallErrorCode::InvalidRequest);
    }
}
