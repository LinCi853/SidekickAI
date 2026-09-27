// controller — installer admission, private operation directories and the
// elevated-child handshake.
//
// Background: the wizard used to write a fixed
// `%TEMP%\SidekickAI-install-request.json` and read fixed global result/log
// files, so two wizard windows could overwrite each other's request before the
// engine took the target lock. Every operation now owns an unpredictable,
// ACL-restricted directory, and the request, log and result live inside it,
// bound to the same operationId / nonce / caller identity.
//
// Honest boundaries: the private directory, SID binding and image hash raise the
// cost of a stale or forged elevated request, but they are not authentication.
// A process already running as the same user can still forge a request inside
// its own private directory, and same-account UAC keeps the same SID by design.
// The elevated child performs install / repair / config writes; those do remove
// files, including the explicit cleanup paths the user confirmed, but only after
// the engine validates every path. "No deletion" would be too strong: the
// engine deletes its own validated targets and the confirmed cleanup
// directories, and nothing else.

mod directory;
mod envelope;
mod run;
mod state;

pub use directory::{prepare_operation, OperationDirectory};
pub use run::{
    bound_log_path, interpret_child_result, run_elevated_operation, with_operation_context,
};
pub use state::{begin_engine, cancel_operation, generation, Admission, RUNNING};

/// Wire version for the controller/child handshake. Bump when the request or
/// result shape changes; both sides always run the same executable image.
pub const OPERATION_PROTOCOL_VERSION: u32 = 1;

pub const ACTION_INSTALL: &str = "install";
pub const ACTION_FLUSH_CONFIG: &str = "flush-config";

pub(crate) const OPERATION_ROOT_NAME: &str = "SidekickAI-Installer";
pub(crate) const REQUEST_FILE: &str = "request.json";
pub(crate) const RESULT_FILE: &str = "result.json";
pub(crate) const NONCE_HEX_LEN: usize = 32;
pub(crate) const SHA256_HEX_LEN: usize = 64;

#[cfg(test)]
mod tests;
