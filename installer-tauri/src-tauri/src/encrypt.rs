// encrypt.rs —— 卸载时导出加密备份（与主程序 backup-restore 的 SABK 格式完全一致）
//
// 流程：把用户数据目录（%APPDATA%\sidekick-ai 等候选目录）打包为 zip → AES-256-GCM 加密 → .sabackup
// 格式：[0..4) "SABK" + [4] version(1) + [5..9) saltLen(u32 LE) + salt + iv(12) + authTag(16) + ciphertext
// 密钥派生：PBKDF2-SHA256(password, salt, 100000 迭代, 32 字节)
// 与 electron/utils/file-crypto.ts 保持字节级兼容，备份可由主程序「导入」功能解密恢复。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

/// 与主程序一致的格式常量
const MAGIC: &[u8; 4] = b"SABK";
const VERSION: u8 = 1;
const IV_LENGTH: usize = 12;
const AUTH_TAG_LENGTH: usize = 16;
const KEY_LENGTH: usize = 32;
const PBKDF2_ITERATIONS: u32 = 100000;

/// 打包并加密用户数据目录为 .sabackup 文件
///
/// - src_dir: 用户数据目录（如 %APPDATA%\sidekick-ai）
/// - target_path: 输出的 .sabackup 完整路径
/// - password: 用户设置的备份密码（用于派生加密密钥）
pub fn export_encrypted_backup(
    src_dir: &Path,
    target_path: &Path,
    password: &str,
) -> Result<(), String> {
    if !src_dir.exists() {
        return Err("用户数据目录不存在，无需导出".into());
    }
    status(&format!("正在打包用户数据 {}", src_dir.display()));
    // 1. 打包为 zip（临时文件）
    let tmp_zip = std::env::temp_dir().join(format!("SidekickAI-export-{}.zip", std::process::id()));
    pack_dir_to_zip(src_dir, &tmp_zip)?;

    // 2. 读入内存并加密（zip 通常不大；若超大再触达后优化为流式）
    let plaintext = fs::read(&tmp_zip).map_err(|e| format!("读取临时 zip 失败：{}", e))?;
    let _ = fs::remove_file(&tmp_zip);

    // 3. 派生密钥 + AES-256-GCM 加密
    // salt = 设备标识。主程序 decryptFile 从文件头原样读取 salt 并返回（仅作来源展示，
    // 不校验与设备一致），因此卸载场景用固定标识即可；与主程序加密侧结构完全兼容。
    let salt = b"sidekickai-device-iD";
    let mut key = [0u8; KEY_LENGTH];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);

    let mut iv_bytes = [0u8; IV_LENGTH];
    getrandom::getrandom(&mut iv_bytes).map_err(|e| format!("生成随机 IV 失败：{}", e))?;

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("初始化加密器失败：{}", e))?;
    let nonce = Nonce::from_slice(&iv_bytes);
    // aes-gcm 的加密结果 = ciphertext || authTag(16)，与主程序分离存储的结构一致
    let encrypted = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("加密失败：{}", e))?;
    let split = encrypted.len() - AUTH_TAG_LENGTH;
    let auth_tag = &encrypted[split..];
    let ciphertext = &encrypted[..split];

    // 4. 组装 SABK 文件
    let mut out = Vec::with_capacity(MAGIC.len() + 1 + 4 + salt.len() + IV_LENGTH + AUTH_TAG_LENGTH + encrypted.len());
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.extend_from_slice(&(salt.len() as u32).to_le_bytes());
    out.extend_from_slice(salt);
    out.extend_from_slice(&iv_bytes);
    out.extend_from_slice(auth_tag);
    out.extend_from_slice(ciphertext);

    fs::write(target_path, &out).map_err(|e| format!("写入备份文件 {} 失败：{}", target_path.display(), e))?;
    Ok(())
}

/// 递归打包目录为 zip（用 zip crate 内部 Deflate 压缩）
fn pack_dir_to_zip(src_dir: &Path, zip_path: &Path) -> Result<(), String> {
    let file = fs::File::create(zip_path).map_err(|e| format!("创建 zip 失败：{}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut pending = vec![src_dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let mut entries = Vec::new();
        let rd = fs::read_dir(&dir).map_err(|e| format!("读取目录 {} 失败：{}", dir.display(), e))?;
        for entry in rd {
            entries.push(entry.map_err(|e| e.to_string())?);
        }
        // 稳定顺序输出，避免 zip 内容随机
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let rel = path.strip_prefix(src_dir).map_err(|_| "路径前缀错误")?;
            let name = rel.to_string_lossy().replace('\\', "/");
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            if ty.is_dir() {
                pending.push(path);
                let dir_name = format!("{}/", name);
                let _ = zip.add_directory(dir_name, options);
                continue;
            }
            // 文件：读入内存后写入 zip
            let mut data = Vec::new();
            let mut f = fs::File::open(&path).map_err(|e| format!("打开 {} 失败：{}", path.display(), e))?;
            f.read_to_end(&mut data).map_err(|e| format!("读取 {} 失败：{}", path.display(), e))?;
            zip.start_file(name.clone(), options).map_err(|e| format!("写入 zip 条目失败：{}", e))?;
            zip.write_all(&data).map_err(|e| format!("写入 zip 数据失败：{}", e))?;
        }
    }
    zip.finish().map_err(|e| format!("完成 zip 失败：{}", e))?;
    Ok(())
}

/// 与 engine.rs 的 status/progress 日志对齐（写 S|P| 格式日志）
fn status(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("SidekickAI-install.log"))
    {
        let _ = writeln!(f, "S|{}", msg);
    }
}