// manifest.rs —— 安装期「功能 / 选项 / 协议」清单 + 类型（单一数据源，与 install-manifest.ts 对齐）
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallFeature {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub default_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct InstallOptionChoice {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Clone)]
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
    pub locations: Vec<InstallLocation>,
    /// 推荐安装目标（已有有效安装则为其路径，否则默认目录）
    pub recommended_dir: String,
    /// 残留提示（如“发现 2 处安装位置”）
    pub residual_hint: String,
    /// 本机固定盘盘符列表
    pub fixed_drives: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub install_dir: String,
    pub for_all_users: bool,
    pub create_desktop_shortcut: bool,
    pub launch_after_install: bool,
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
    /// 已同意的协议 id 列表
    #[serde(default)]
    pub accepted_licenses: Vec<String>,
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

fn feat(id: &str, name: &str, desc: &str, category: &str, default: bool, required: bool) -> InstallFeature {
    InstallFeature {
        id: id.to_string(),
        name: name.to_string(),
        description: desc.to_string(),
        category: category.to_string(),
        default_enabled: default,
        required: if required { Some(true) } else { None },
    }
}

pub fn features() -> Vec<InstallFeature> {
    vec![
        feat("whiteboard", "画板 / 白板", "Excalidraw 无限画布：多白板管理、SQLite 持久化、截图推送到白板", "stable", true, false),
        feat("notes", "笔记", "富文本灵感笔记：任务列表、代码块、图片、全文搜索", "stable", true, false),
        feat("custom-chat", "自定义对话 API", "OpenAI / Anthropic / Custom 三协议直连与流式对话", "stable", true, true),
        feat("prompt-library", "提示词库", "提示词模板管理、热键注入、注入历史去重", "stable", true, false),
        feat("browser", "多标签浏览器", "Chrome 风格多标签浏览器窗口：标签 / 导航 / 书签 / 下载 / 历史", "dev", false, false),
        feat("voice", "语音输入", "后台语音：按住说话、STT 识别、分层上屏（实验性）", "dev", false, false),
        feat("tts", "TTS 语音合成", "自定义供应商 TTS 合成（实验性，依赖自定义对话 API）", "dev", false, false),
        feat("freeze", "页面冻结（防撤回）", "冻结 AI 网页防止对方撤回 / 删除内容（实验性）", "dev", false, false),
    ]
}

pub fn options() -> Vec<InstallOption> {
    vec![
        InstallOption {
            id: "autoUpdate".into(),
            label: "自动更新".into(),
            description: "有可用更新时自动下载并在下次启动时应用".into(),
            opt_type: "boolean".into(),
            default_value: serde_json::json!(true),
            choices: None,
            page: Some("behavior".into()),
        },
        InstallOption {
            id: "autoLaunch".into(),
            label: "开机自启".into(),
            description: "登录 Windows 后自动在后台启动".into(),
            opt_type: "boolean".into(),
            default_value: serde_json::json!(false),
            choices: None,
                   page: Some("behavior".into()),
        },
        InstallOption {
            id: "logLevel".into(),
            label: "日志级别".into(),
            description: "决定记录多少运行日志（debug 最详细）".into(),
            opt_type: "choice".into(),
            default_value: serde_json::json!("debug"),
            choices: Some(vec![
                InstallOptionChoice { value: "error".into(), label: "仅错误".into() },
                InstallOptionChoice { value: "warn".into(), label: "警告及以上".into() },
                InstallOptionChoice { value: "info".into(), label: "常规信息".into() },
                InstallOptionChoice { value: "debug".into(), label: "调试（最详细）".into() },
            ]),
            page: Some("logging".into()),
        },
        InstallOption {
            id: "usageTracking".into(),
            label: "使用统计".into(),
            description: "匿名收集使用数据以改进产品".into(),
            opt_type: "boolean".into(),
            default_value: serde_json::json!(true),
            choices: None,
            page: Some("behavior".into()),
        },
    ]
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
        .map(|p| format!("{}\\SidekickAI", p.trim_end_matches('\\')))
        .unwrap_or_else(|_| "C:\\Program Files\\SidekickAI".into());
    let local = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("USERPROFILE").map(|p| format!("{}\\AppData\\Local", p.trim_end_matches('\\'))))
        .unwrap_or_default();
    let per_user_default_dir = format!("{}\\Programs\\SidekickAI", local.trim_end_matches('\\'));
    InstallerInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
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
