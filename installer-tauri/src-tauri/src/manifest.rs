// manifest.rs —— 安装期「功能 / 选项 / 协议」清单 + 类型
// 功能/选项清单统一由主应用生成（见 scripts/gen-install-manifest.cjs 与
// electron/shared/install-manifest-source.ts），本文件仅负责解析与透出。
use serde::{Deserialize, Serialize};

fn default_backup_encrypt() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallFeature {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub default_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    /// 需独立安装才能使用（安装前选定，安装中不可调整）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_required: Option<bool>,
    /// 体积级别：large = 需独立安装 / small = 恒随包
    #[serde(default = "default_size_level")]
    pub size_level: String,
}

fn default_size_level() -> String {
    "small".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct InstallOptionChoice {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallOption {
    pub id: String,
    pub label: String,
    pub description: String,
    #[serde(rename = "type")]
    pub opt_type: String,
    pub default_value: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<InstallOptionChoice>>,
    /// 选项分组页（组件 / 应用行为 / 日志）；空 = 不分页
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
}

/// 协议列表（用户许可 / 开源许可 / 隐私政策等），替代原 eulaText/licenseText 两字段
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LicenseDoc {
    pub id: String,
    pub title: String,
    /// 默认打开的协议（用户许可协议）
    pub default_open: bool,
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerInfo {
    pub edition_label: String,
    pub uninstall_entry: bool,
    pub version: String,
    pub default_dir: String,
    pub per_user_default_dir: String,
    pub app_name: String,
    pub arch: String,
    pub required_space: String,
    pub licenses: Vec<LicenseDoc>,
    pub features: Vec<InstallFeature>,
    pub options: Vec<InstallOption>,
}

/// 安装模式：正常安装 / 修复安装 / 卸载
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum InstallMode {
    #[default]
    Install,
    Repair,
    Uninstall,
}

/// 扫描发现的一个安装位置
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallLocation {
    pub for_all_users: bool,
    pub path: String,
    /// 来源：default / program-files / local-programs / fixed-disk
    pub source: String,
    /// 从卸载注册表或 exe 版本资源读取的版本号；读不到为空
    pub version: String,
    /// x64 / arm64 / 空未知
    pub arch: String,
    /// 是否已在 HKLM/HKCU 写入卸载项
    pub registered: bool,
    /// SidekickAI.exe 是否正在运行（PID>0 时为 PID）
    pub running_pid: u32,
    /// 本次扫描中建议清理（非推荐目标）
    pub recommended_for_cleanup: bool,
}

/// scan_installations 结果
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub other_editions: Vec<OtherEditionInstallation>,
    pub other_editions_warning: String,
    pub locations: Vec<InstallLocation>,
    /// 推荐安装目标（已有有效安装则为其路径，否则默认目录）
    pub recommended_dir: String,
    /// 残留提示（如“发现 2 处安装位置”）
    pub residual_hint: String,
    /// 本机固定盘盘符列表
    pub fixed_drives: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OtherEditionInstallation {
    pub edition: String,
    pub label: String,
    pub path: String,
    pub version: Option<String>,
    pub arch: sidekickai_uninstall_core::protocol::UninstallArch,
}

/// One verified cloud asset the engine will stage, re-check and land.
///
/// Resource packages carry canonical signed envelope bytes and a detached
/// compact proof. The engine verifies its embedded public trust before writing.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudAssetRequest {
    /// Stable identity, e.g. `theme/oxy-dark@1.0.0` or a distribution sha256.
    pub asset_id: String,
    pub version: String,
    /// Envelope / file digest as published (lowercase hex sha256).
    pub digest: String,
    /// Published size (envelope bytes or distribution file bytes).
    pub size_bytes: u64,
    /// `resource-package` | `distribution`
    pub kind: String,
    /// Relative destination under the install directory (`resources/cloud/...`).
    pub destination: String,
    /// Canonical UTF-8 envelope JSON; empty for distribution files.
    #[serde(default)]
    pub payload_json: String,
    /// Absolute path of an already-downloaded distribution file; empty for
    /// resource packages.
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub signed_token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    #[serde(default)]
    pub installation_id: String,
    #[serde(default)]
    pub resources: Vec<serde_json::Value>,
    /// 子任务标识："" = 正常安装/修复/卸载；"flush-config" = 仅写 install-config.json
    #[serde(default)]
    pub action: String,
    pub install_dir: String,
    pub for_all_users: bool,
    pub create_desktop_shortcut: bool,
    pub launch_after_install: bool,
    /// 安装完成后打开使用指南（首次启动引导窗）；默认不勾选
    #[serde(default)]
    pub show_guide_after_install: bool,
    pub features: serde_json::Map<String, serde_json::Value>,
    pub options: serde_json::Map<String, serde_json::Value>,
    /// 安装模式；缺省 = install（兼容旧请求）
    #[serde(default)]
    pub mode: InstallMode,
    /// 用户确认要清理的其他安装位置（绝对路径）
    #[serde(default)]
    pub cleanup_paths: Vec<String>,
    /// 卸载时是否删除用户数据（配置/Profile/缓存/日志）
    #[serde(default)]
    pub delete_user_data: bool,
    /// 卸载数据策略：keep（保留默认）/ export（导出加密备份后删除）/ delete（直接删除）
    /// 三选一可选字段；优先于 delete_user_data（兼容旧请求布尔值）
    #[serde(default)]
    pub data_strategy: String,
    /// data_strategy=export 时的备份保存路径（.sabackup）
    #[serde(default)]
    pub backup_path: String,
    /// data_strategy=export 时的备份密码（backup_encrypt=true 时必填）
    #[serde(default)]
    pub backup_password: String,
    /// data_strategy=export 时是否加密（false = 明文 zip）
    #[serde(default = "default_backup_encrypt")]
    pub backup_encrypt: bool,
    /// data_strategy=export 时的导出类别（basicData/cookies/indexedDB/cache/voiceAssets）；
    /// 空 = 全量（兼容旧行为）
    #[serde(default)]
    pub backup_categories: Vec<String>,
    /// 已同意的协议 id 列表
    #[serde(default)]
    pub accepted_licenses: Vec<String>,
    /// Legacy wire compatibility; normal installations always attempt defaults.
    #[serde(default)]
    pub cloud_enabled: bool,
    /// Verified cloud assets to land after the core install commits.
    #[serde(default)]
    pub cloud_assets: Vec<CloudAssetRequest>,
}

pub fn new_installation_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos()).unwrap_or_default();
    format!("install-{}-{nanos}-{}", std::process::id(), SERIAL.fetch_add(1, Ordering::SeqCst))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DonePayload {
    pub install_dir: String,
    /// 完成页提示：仍存在其他安装位置时非空
    pub residual_note: String,
}

const EULA_ZH: &str = include_str!("../EULA.zh-CN.txt");
const LICENSE: &str = include_str!("../License.txt");

pub fn features() -> Vec<InstallFeature> {
    crate::setup_metadata::current().expect("validated Setup metadata").features.clone()
}

pub fn options() -> Vec<InstallOption> {
    crate::setup_metadata::current().expect("validated Setup metadata").options.clone()
}

pub fn licenses() -> Vec<LicenseDoc> {
    vec![
        LicenseDoc {
            id: "eula".into(),
            title: "用户许可及服务协议".into(),
            default_open: true,
            body: EULA_ZH.to_string(),
        },
        LicenseDoc {
            id: "mit-license".into(),
            title: "MIT 开源许可".into(),
            default_open: false,
            body: LICENSE.to_string(),
        },
    ]
}

pub fn host_arch() -> &'static str {
    let proc = std::env::var("PROCESSOR_ARCHITECTURE").unwrap_or_default().to_ascii_lowercase();
    let w6432 = std::env::var("PROCESSOR_ARCHITEW6432").unwrap_or_default().to_ascii_lowercase();
    if proc == "arm64" || w6432 == "arm64" { "arm64" } else { "x64" }
}

pub fn build_info() -> InstallerInfo {
    let app_name = "SidekickAI".to_string();
    let default_dir = std::env::var("ProgramFiles")
        .map(|p| format!("{}\\{}", p.trim_end_matches('\\'), sidekickai_uninstall_core::product::edition().directory))
        .unwrap_or_else(|_| format!("C:\\Program Files\\{}", sidekickai_uninstall_core::product::edition().directory));
    let local = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|p| format!("{}\\AppData\\Local", p.trim_end_matches('\\'))))
        .unwrap_or_default();
    let per_user_default_dir = format!("{}\\Programs\\{}", local.trim_end_matches('\\'), sidekickai_uninstall_core::product::edition().directory);
    InstallerInfo {
        edition_label: sidekickai_uninstall_core::product::edition().label.clone(),
        uninstall_entry: std::env::args().skip(1).eq(["--uninstall".to_string()]),
        version: crate::setup_metadata::current().expect("validated Setup metadata").product_version.clone(),
        default_dir,
        per_user_default_dir,
        app_name,
        arch: host_arch().to_string(),
        required_space: "约 480 MB".to_string(),
        licenses: licenses(),
        features: features(),
        options: options(),
    }
}
