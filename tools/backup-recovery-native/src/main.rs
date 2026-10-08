use sidekickai_uninstall_core::{architecture, distribution};
use distribution::{BodyDescriptor, BODY_PROOF_TYPE};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct PrivateDirectory {
    path: PathBuf,
    lock: Option<std::fs::File>,
}

impl Drop for PrivateDirectory {
    fn drop(&mut self) {
        self.lock.take();
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn root_for(executable: &Path) -> Result<PathBuf, String> {
    let parent = executable.parent().ok_or("恢复入口缺少目录。")?;
    if parent.join("distribution-proof.json").is_file() { return Ok(parent.to_path_buf()); }
    let portable = parent.parent().ok_or("没有已核验的产品证明。")?;
    if portable.join("portable-layout.json").is_file() && portable.join("distribution-proof.json").is_file() {
        return Ok(portable.to_path_buf());
    }
    Err("没有匹配的安装或绿色产品证明；未运行恢复资源。".into())
}

fn run(mut arguments: Vec<String>) -> Result<i32, String> {
    if arguments.is_empty() || arguments == ["--help"] {
        println!("Commands: export, verify, decrypt, restore, jobs, status, resume, cancel.");
        println!("The signed recovery resources beside this entry are required. Passwords use --password-stdin.");
        return Ok(0);
    }
    if arguments.iter().any(|argument| argument == "--password" || argument.starts_with("--password=")) {
        return Err("密码仅允许通过 --password-stdin 私有输入。".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let root = root_for(&executable)?;
    let proof = distribution::read_envelope(&root.join("distribution-proof.json"))?;
    let body: BodyDescriptor = distribution::verify_envelope(&proof, BODY_PROOF_TYPE)?;
    let architecture = architecture::native_architecture()?;
    distribution::validate_body(&body, sidekickai_uninstall_core::product::edition_id(), architecture, &body.variant)?;
    let relative = executable.strip_prefix(&root).map_err(|_| "恢复入口不在已核验产品目录。")?.to_string_lossy().replace('\\', "/");
    let entry = body.files.iter().find(|file| file.path == relative).ok_or("产品证明未绑定此恢复入口。")?;
    distribution::verify_file(&executable, entry.size_bytes, &entry.sha256)?;
    if entry.executable_architecture.as_deref() != Some(architecture) || distribution::pe_architecture(&executable)? != architecture {
        return Err("恢复入口架构与产品证明不一致。".into());
    }
    if arguments.first().map(String::as_str) == Some("export") {
        for (key, expected) in [("--edition", body.edition.as_str()), ("--version", body.product_version.as_str())] {
            if arguments.iter().filter(|argument| argument.as_str() == key).count() > 1 {
                return Err("导出身份参数不得重复。".into());
            }
            if let Some(at) = arguments.iter().position(|value| value == key) {
                if arguments.get(at + 1).map(String::as_str) != Some(expected) { return Err("导出请求与已核验产品身份不一致。".into()); }
            } else {
                arguments.extend([key.into(), expected.into()]);
            }
        }
    }
    let (path, lock) = sidekickai_uninstall_core::create_operation_dir("recovery").map_err(|error| error.message)?;
    let directory = PrivateDirectory { path, lock: Some(lock) };
    distribution::harden_private_directory(&directory.path)?;
    let runtime = distribution::prepare_bound_runtime(&root, &directory.path, &body, architecture)?;
    let status = Command::new(runtime.directory.join("node.exe"))
        .arg("--disable-warning=ExperimentalWarning").arg(runtime.directory.join(&runtime.descriptor.entrypoints.restore))
        .args(arguments).current_dir(&runtime.directory)
        .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit())
        .status().map_err(|error| format!("无法运行已核验恢复资源：{error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn main() {
    let result = run(std::env::args().skip(1).collect());
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{}", serde_json::json!({"success":false,"error":error}));
            std::process::exit(1);
        }
    }
}
