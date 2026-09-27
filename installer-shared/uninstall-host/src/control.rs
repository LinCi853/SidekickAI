//! The cancellation and commit decision shared by IPC and the operation thread.
use std::sync::atomic::{AtomicU8, Ordering};

const READY: u8 = 0;
const CANCELLED: u8 = 1;
const COMMITTED: u8 = 2;

#[derive(Default)]
pub(crate) struct OperationControl(AtomicU8);

impl OperationControl {
    pub fn request_cancel(&self) -> bool {
        match self.0.compare_exchange(READY, CANCELLED, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) | Err(CANCELLED) => true,
            Err(_) => false,
        }
    }

    pub fn begin_commit(&self) -> bool {
        self.0.compare_exchange(READY, COMMITTED, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::SeqCst) == CANCELLED }
    #[cfg(test)]
    pub fn is_committed(&self) -> bool { self.0.load(Ordering::SeqCst) == COMMITTED }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn accepted_cancellation_never_commits_and_stays_idempotent() {
        let control = OperationControl::default();
        assert!(control.request_cancel());
        assert!(!control.begin_commit());
        assert!(!control.is_committed());
        assert!(control.request_cancel());
    }

    #[test]
    fn committed_operation_rejects_cancellation() {
        let control = OperationControl::default();
        assert!(control.begin_commit());
        assert!(!control.request_cancel());
        assert!(!control.is_cancelled());
    }

    #[test]
    fn concurrent_cancel_and_commit_have_exactly_one_winner() {
        for _ in 0..128 {
            let control = Arc::new(OperationControl::default());
            let barrier = Arc::new(Barrier::new(2));
            let child_control = control.clone();
            let child_barrier = barrier.clone();
            let child = std::thread::spawn(move || {
                child_barrier.wait();
                child_control.request_cancel()
            });
            barrier.wait();
            let committed = control.begin_commit();
            let cancelled = child.join().unwrap();
            assert_ne!(committed, cancelled);
            assert_ne!(control.is_committed(), control.is_cancelled());
        }
    }
}
