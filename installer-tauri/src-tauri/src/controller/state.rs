// state —— admission、取消与引擎启动生命周期
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

/// True while an install/repair/config write owns the wizard.
///
/// Admission is a compare-and-swap instead of a blind store: a second request
/// (another window in the same process) is refused rather than allowed to
/// overwrite the first operation's private request directory.
pub static RUNNING: AtomicBool = AtomicBool::new(false);

/// Bumped on every admission. A background tail thread captures the generation
/// it belongs to and stops when a newer operation starts, so a late thread can
/// never tail the next operation's log.
pub(super) static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Generation of the currently admitted operation.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Per-operation lifecycle (cancel versus engine start)
// ---------------------------------------------------------------------------

/// Lifecycle of the admitted operation. Cancellation and the engine entry are
/// arbitrated with a single compare-and-swap over this one value, so exactly one
/// of them can win. Two independent `CANCELLED` / `ENGINE_STARTED` flags allowed
/// a cancel to observe "not started" while the engine was already past its own
/// check, which could report an accepted cancellation for a running engine.
pub const OPERATION_IDLE: u8 = 0;
/// Admitted, request prepared, engine not entered yet: cancellable.
pub const OPERATION_ADMITTED: u8 = 1;
/// The engine has been entered: cancellation is no longer accepted.
pub const OPERATION_ENGINE_STARTED: u8 = 2;
/// Cancellation won before the engine started: the engine must not run.
pub const OPERATION_CANCELLED: u8 = 3;

pub(super) static OPERATION_STATE: AtomicU8 = AtomicU8::new(OPERATION_IDLE);

/// Try to cancel the admitted operation before the engine starts. Returns
/// `true` only for the caller that actually won the race; once the engine has
/// started every later call returns `false` and no fake cancellation is
/// reported.
pub fn cancel_operation() -> bool {
    OPERATION_STATE
        .compare_exchange(
            OPERATION_ADMITTED,
            OPERATION_CANCELLED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

/// Mark the engine as entered for the admitted operation. Returns `false` when
/// a cancellation already won, in which case the caller must not run the
/// engine.
pub fn begin_engine() -> bool {
    OPERATION_STATE
        .compare_exchange(
            OPERATION_ADMITTED,
            OPERATION_ENGINE_STARTED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
}

/// Whether a cancellation won before the engine started.
#[allow(dead_code)]
pub fn operation_cancelled() -> bool {
    OPERATION_STATE.load(Ordering::SeqCst) == OPERATION_CANCELLED
}

/// Reset the lifecycle for a newly admitted operation. Never called while
/// another operation is admitted (admission is exclusive).
pub(super) fn reset_operation_state() {
    OPERATION_STATE.store(OPERATION_ADMITTED, Ordering::SeqCst);
}

/// RAII admission guard. Dropping it releases admission on every path: `?`
/// early returns before the engine starts, `run` errors, and a panicking
/// operation thread all reset the flag, so the wizard cannot stay stuck busy.
pub struct Admission {
    generation: u64,
    released: Cell<bool>,
}

impl Admission {
    /// Admit one operation, or `None` when another one is already running.
    pub fn acquire() -> Option<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        reset_operation_state();
        Some(Admission {
            generation,
            released: Cell::new(false),
        })
    }

    /// Generation this guard belongs to.
    #[allow(dead_code)]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Release admission exactly once. Called before the terminal event is
    /// emitted so the UI can leave the busy state without waiting for this
    /// guard to drop.
    ///
    /// The release is idempotent and generation-bound: a second call (the
    /// `Drop` after an explicit `finish`) is ignored, and a stale guard whose
    /// operation already released can never clear the `RUNNING` flag of a newer
    /// operation admitted in between. The lifecycle returns to idle, so a
    /// `cancel()` after a failed start cannot claim an operation that is gone.
    pub fn finish(&self) {
        if self.released.replace(true) {
            return;
        }
        if generation() == self.generation {
            // Idle first, then clear RUNNING: while RUNNING is still set no new
            // operation can be admitted and overwrite this reset.
            OPERATION_STATE.store(OPERATION_IDLE, Ordering::SeqCst);
            RUNNING.store(false, Ordering::SeqCst);
        }
    }
}

impl Drop for Admission {
    fn drop(&mut self) {
        self.finish();
    }
}
