// run —— 提权子进程入口与操作日志上下文
use std::cell::RefCell;
use std::path::{Path, PathBuf};

use super::envelope::{load_request, verify_request, OperationRequest, OperationResult};
use super::{ACTION_FLUSH_CONFIG, ACTION_INSTALL, ACTION_INSTALL_SESSION, ACTION_OPEN_APPLICATION, OPERATION_PROTOCOL_VERSION, RESULT_FILE};

// ---------------------------------------------------------------------------
// Per-operation log context
// ---------------------------------------------------------------------------

thread_local! {
    /// Log destination of the operation bound to the current thread. Thread-local
    /// (never an environment variable) so two operations in one process cannot
    /// observe each other's log path.
    static OPERATION_LOG: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

/// Run `work` with `log_path` bound as this operation's log destination.
///
/// Required engine integration: `engine::log_path()` should return
/// `controller::bound_log_path().unwrap_or_else(<legacy fixed path>)` so
/// `engine::write_log` writes into this directory instead of a process-wide file.
pub fn with_operation_context<T>(log_path: PathBuf, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            OPERATION_LOG.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let previous = OPERATION_LOG.with(|slot| slot.replace(Some(log_path)));
    let _restore = Restore(previous);
    work()
}

/// Log destination bound to the current thread, if an operation is in progress.
/// This is the integration point `engine::log_path` consults so engine logs are
/// written into the operation directory instead of a process-wide file.
pub fn bound_log_path() -> Option<PathBuf> {
    OPERATION_LOG.with(|slot| slot.borrow().clone())
}

// ---------------------------------------------------------------------------
// Elevated child
// ---------------------------------------------------------------------------

/// Elevated child entry (`--elevated <request.json>`): validate the request that
/// lives in the controller's private directory, run the engine, and write the
/// structured result next to the request. Exit code 0 only when the result was
/// persisted and the engine succeeded.
pub fn run_elevated_operation(request_path: &str) -> i32 {
    let path = Path::new(request_path);
    let worker = match std::env::current_exe() {
        Ok(worker) => worker,
        Err(error) => {
            eprintln!("无法定位安装程序：{error}");
            return 1;
        }
    };
    // An untrusted *location* produces no result at all: the operation identity
    // in it cannot be trusted either.
    let envelope = match load_request(path) {
        Ok(envelope) => envelope,
        Err(error) => {
            eprintln!("安装请求被拒绝：{error}");
            return 1;
        }
    };
    // The location is this operation's private directory, so an identity/image
    // refusal can be reported truthfully without running the engine.
    if let Err(error) = verify_request(&envelope, &worker) {
        return finish_operation(path, &envelope, Err(error));
    }
    let completion = if envelope.action == ACTION_INSTALL_SESSION {
        match super::completion::Worker::bind(&envelope, path) {
            Ok(worker) => Some(worker),
            Err(error) => return finish_operation(path, &envelope, Err(error)),
        }
    } else { None };
    let outcome = with_operation_context(log_path_for(path), || match envelope.action.as_str() {
        ACTION_INSTALL | ACTION_INSTALL_SESSION => crate::engine::run(&envelope.request),
        ACTION_FLUSH_CONFIG => crate::engine::flush_install_config(&envelope.request),
        ACTION_OPEN_APPLICATION => crate::application_user::launch_as_caller(&envelope, path),
        other => Err(format!("未知的安装操作类型：{other}")),
    });
    let code = finish_operation(path, &envelope, outcome);
    if let Some(completion) = completion.filter(|_| code == 0) {
        return with_operation_context(log_path_for(path), || match completion.serve(&envelope, path) {
            Ok(()) => 0,
            Err(error) => { crate::engine::write_log(&format!("E|安装授权会话结束：{error}")); 1 },
        });
    }
    code
}

/// Persist one structured result into the operation directory and map it to the
/// child exit code. A result that cannot be written is itself a failure.
pub(super) fn finish_operation(
    request_path: &Path,
    envelope: &OperationRequest,
    outcome: Result<(), String>,
) -> i32 {
    let ok = outcome.is_ok();
    let result = OperationResult {
        protocol_version: OPERATION_PROTOCOL_VERSION,
        operation_id: envelope.operation_id.clone(),
        nonce: envelope.nonce.clone(),
        ok,
        error: outcome.err(),
    };
    let bytes = match serde_json::to_vec_pretty(&result) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("无法序列化安装结果：{error}");
            return 1;
        }
    };
    let directory = request_path.parent().unwrap_or_else(|| Path::new("."));
    if let Err(error) =
        sidekickai_uninstall_core::write_private_file(&directory.join(RESULT_FILE), &bytes)
    {
        eprintln!("无法写入安装结果：{}", error.message);
        return 1;
    }
    if ok {
        0
    } else {
        1
    }
}

/// Log destination derived from a request path, so the child binds the same
/// operation log as the controller that prepared the request.
pub(super) fn log_path_for(request_path: &Path) -> PathBuf {
    request_path
        .parent()
        .map(|directory| directory.join("install.log"))
        .unwrap_or_else(|| std::env::temp_dir().join("SidekickAI-install.log"))
}

/// Convert the child's exit code plus optional result file into the parent's
/// outcome. Kept pure so the nonzero / missing / malformed cases are testable
/// without any real UAC or install.
pub fn interpret_child_result(
    raw: Option<&str>,
    exit_code: i32,
    operation_id: &str,
    nonce: &str,
) -> Result<(), String> {
    if let Some(text) = raw {
        let result: OperationResult =
            serde_json::from_str(text).map_err(|error| format!("读取安装结果失败：{error}"))?;
        if result.protocol_version != OPERATION_PROTOCOL_VERSION
            || result.operation_id != operation_id
            || result.nonce != nonce
        {
            return Err("安装结果不属于本次操作。".into());
        }
        if result.ok && exit_code == 0 {
            return Ok(());
        }
        if let Some(error) = result.error.filter(|error| !error.is_empty()) {
            return Err(error);
        }
        return Err(format!("安装进程未成功完成（退出码 {exit_code}）。"));
    }

    if exit_code == 1223 {
        return Err("已取消：未授予管理员权限".into());
    }
    if exit_code == 0 {
        return Err("安装进程已结束，但没有返回安装结果".into());
    }
    Err(format!("安装进程异常退出，代码 {exit_code}（未返回详细错误）"))
}
