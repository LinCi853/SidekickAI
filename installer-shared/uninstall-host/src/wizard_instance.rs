//! Atomic admission and cooperative switching for one maintenance window.

mod native;

use std::sync::{Arc, Mutex, Weak};

pub type WizardCallback = Arc<dyn Fn() + Send + Sync>;

pub enum WizardAcquisition {
    Owned(WizardInstance),
    Activated,
}

struct Callbacks {
    activate: WizardCallback,
    release: WizardCallback,
}

struct State {
    entry: String,
    operations: usize,
    releasing: bool,
    pending_activation: bool,
    callbacks: Option<Callbacks>,
}

impl State {
    fn request(&mut self, entry: &str) -> Decision {
        if self.releasing {
            return Decision::Switch;
        }
        if self.callbacks.is_none() {
            if precise_entry(entry) && self.entry!=entry {return Decision::Reject;}
            self.pending_activation = true;
            return Decision::Activate;
        }
        if self.operations != 0 || self.entry == entry {
            if self.operations!=0 && self.entry!=entry && precise_entry(entry) {return Decision::Reject;}
            return Decision::Activate;
        }
        self.releasing = true;
        Decision::Switch
    }

    fn begin(&mut self) -> bool {
        if self.releasing {
            return false;
        }
        self.operations += 1;
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Decision {
    Activate,
    Switch,
    Reject,
}

fn precise_entry(entry:&str)->bool {entry.starts_with("installer:install:")&&entry.contains(":release:")}

struct Shared {
    state: Mutex<State>,
}

impl Shared {
    fn request(&self, entry: &str) -> (Decision, Option<WizardCallback>) {
        let Ok(mut state) = self.state.lock() else {
            return (Decision::Activate, None);
        };
        let was_releasing = state.releasing;
        let decision = state.request(entry);
        let callback = state.callbacks.as_ref().and_then(|callbacks| match decision {
            Decision::Activate => Some(callbacks.activate.clone()),
            Decision::Reject => Some(callbacks.activate.clone()),
            Decision::Switch if !was_releasing => Some(callbacks.release.clone()),
            Decision::Switch => None,
        });
        (decision, callback)
    }

    fn entry(&self)->Result<String,String>{self.state.lock().map(|state|state.entry.clone()).map_err(|_|"维护向导状态不可用。".into())}
}

static CURRENT: Mutex<Option<Weak<Shared>>> = Mutex::new(None);

pub struct WizardInstance {
    shared: Arc<Shared>,
    native: native::Owner,
}

#[derive(Clone)]
pub struct WizardBinding(Arc<Shared>);

impl WizardBinding {
    pub fn release_failure_callback(&self) -> WizardCallback {
        let owner = Arc::downgrade(&self.0);
        Arc::new(move || {
            if let Some(owner) = owner.upgrade() {
                if let Ok(mut state) = owner.state.lock() {
                    if state.operations == 0 { state.releasing = false; }
                }
            }
        })
    }

    pub fn bind(&self, activate: WizardCallback, release: WizardCallback) {
        let pending = if let Ok(mut state) = self.0.state.lock() {
            let pending = state.pending_activation.then(|| activate.clone());
            state.pending_activation = false;
            state.callbacks = Some(Callbacks { activate, release });
            pending
        } else {
            None
        };
        if let Some(activate) = pending {
            activate();
        }
    }
}

impl WizardInstance {
    pub fn acquire_entry(entry: &str) -> Result<WizardAcquisition, String> {
        if entry.is_empty() || entry.len() > 32768 {
            return Err("维护入口无效。".into());
        }
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                entry: entry.into(),
                operations: 0,
                releasing: false,
                pending_activation: false,
                callbacks: None,
            }),
        });
        let Some(native) = native::acquire(entry, shared.clone())? else {
            return Ok(WizardAcquisition::Activated);
        };
        *CURRENT.lock().map_err(|_| "维护向导状态不可用。")? = Some(Arc::downgrade(&shared));
        Ok(WizardAcquisition::Owned(Self { shared, native }))
    }

    /// Bind only after the native window exists. An unbound owner is occupied.
    pub fn binding(&self) -> WizardBinding {
        WizardBinding(self.shared.clone())
    }

    /// Nested guards keep preparation and execution continuously occupied.
    pub fn begin_operation() -> Result<WizardOperation, String> {
        Self::try_begin_operation()?.ok_or_else(|| "正在切换维护向导。".into())
    }

    pub fn try_begin_operation() -> Result<Option<WizardOperation>, String> {
        let shared = CURRENT.lock().map_err(|_| "维护向导状态不可用。")?.as_ref().and_then(Weak::upgrade);
        WizardOperation::try_acquire(shared)
    }

    pub fn is_releasing() -> bool {
        let shared = CURRENT.lock().ok().and_then(|current| current.as_ref().and_then(Weak::upgrade));
        shared.is_some_and(|shared| shared.state.lock().map(|state| state.releasing).unwrap_or(true))
    }

    pub fn is_occupied() -> bool {
        let shared = CURRENT.lock().ok().and_then(|current| current.as_ref().and_then(Weak::upgrade));
        shared.is_some_and(|shared| {
            shared.state.lock().map(|state| state.releasing || state.operations != 0).unwrap_or(true)
        })
    }
}

impl Drop for WizardInstance {
    fn drop(&mut self) {
        self.native.stop();
        if let Ok(mut current) = CURRENT.lock() {
            if current.as_ref().and_then(Weak::upgrade).is_some_and(|owner| Arc::ptr_eq(&owner, &self.shared)) {
                *current = None;
            }
        }
    }
}

/// Admission is shared with switching, including early returns and panics.
pub struct WizardOperation {
    shared: Mutex<Option<Arc<Shared>>>,
}

impl WizardOperation {
    fn try_acquire(shared: Option<Arc<Shared>>) -> Result<Option<Self>, String> {
        if let Some(shared) = &shared {
            if !shared.state.lock().map_err(|_| "维护向导状态不可用。")?.begin() {
                return Ok(None);
            }
        }
        Ok(Some(Self { shared: Mutex::new(shared) }))
    }

    pub fn finish(&self) {
        let shared = self.shared.lock().ok().and_then(|mut shared| shared.take());
        if let Some(shared) = shared {
            if let Ok(mut state) = shared.state.lock() {
                state.operations = state.operations.saturating_sub(1);
            }
        }
    }
}

impl Drop for WizardOperation {
    fn drop(&mut self) {
        self.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State {
            entry: "installer-a".into(),
            operations: 0,
            releasing: false,
            pending_activation: false,
            callbacks: Some(Callbacks { activate: Arc::new(|| {}), release: Arc::new(|| {}) }),
        }
    }

    #[test]
    fn same_entry_activates_and_another_idle_entry_switches() {
        let mut owner = state();
        assert_eq!(owner.request("installer-a"), Decision::Activate);
        assert_eq!(owner.request("uninstaller-b"), Decision::Switch);
        assert!(!owner.begin());
    }

    #[test]
    fn occupied_or_unbound_wizards_activate_instead_of_switching() {
        let mut owner = state();
        assert!(owner.begin());
        assert_eq!(owner.request("uninstaller-b"), Decision::Activate);
        owner.operations = 0;
        owner.callbacks = None;
        assert_eq!(owner.request("uninstaller-b"), Decision::Activate);
    }

    #[test]
    fn precise_release_switches_only_an_idle_owner_and_rejects_a_busy_different_selection() {
        let requested="installer:install:C:\\setup.exe:release:release-b:digest-b";
        let mut owner=state();owner.entry="installer:install:C:\\setup.exe:release:release-a:digest-a".into();
        owner.operations=1;
        assert_eq!(owner.request(requested),Decision::Reject);
        assert!(!owner.releasing);
        assert_eq!(owner.request(&owner.entry.clone()),Decision::Activate);
        owner.operations=0;owner.callbacks=None;
        assert_eq!(owner.request(requested),Decision::Reject);
        owner.callbacks=Some(Callbacks{activate:Arc::new(||{}),release:Arc::new(||{})});
        assert_eq!(owner.request(requested),Decision::Switch);
    }

    #[test]
    fn activation_during_startup_is_delivered_when_the_window_is_bound() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let mut owner = state();
        owner.callbacks = None;
        let shared = Arc::new(Shared { state: Mutex::new(owner) });
        assert_eq!(shared.request("other").0, Decision::Activate);
        let activations = Arc::new(AtomicUsize::new(0));
        let count = activations.clone();
        WizardBinding(shared.clone()).bind(
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            }),
            Arc::new(|| {}),
        );
        assert_eq!(activations.load(Ordering::SeqCst), 1);
        assert!(!shared.state.lock().unwrap().releasing);
    }

    #[test]
    fn operation_and_switch_have_one_atomic_winner() {
        for _ in 0..100 {
            let owner = Arc::new(Mutex::new(state()));
            let contender = owner.clone();
            let operation = std::thread::spawn(move || contender.lock().unwrap().begin());
            let decision = owner.lock().unwrap().request("uninstaller-b");
            let admitted = operation.join().unwrap();
            assert_eq!(admitted, decision == Decision::Activate);
        }
    }

    #[test]
    fn failed_window_release_allows_activation_and_retry_without_a_stale_switch() {
        let shared = Arc::new(Shared { state: Mutex::new(state()) });
        let recover = WizardBinding(shared.clone()).release_failure_callback();
        assert_eq!(shared.request("other").0, Decision::Switch);
        assert!(!shared.state.lock().unwrap().begin());
        recover();
        assert_eq!(shared.request("installer-a").0, Decision::Activate);
        assert!(shared.state.lock().unwrap().begin());
        assert_eq!(shared.request("other").0, Decision::Activate);
    }

    #[test]
    fn nested_guards_and_idempotent_finish_do_not_release_new_operations() {
        let shared = Arc::new(Shared { state: Mutex::new(state()) });
        assert!(shared.state.lock().unwrap().begin());
        assert!(shared.state.lock().unwrap().begin());
        let preparation = WizardOperation { shared: Mutex::new(Some(shared.clone())) };
        let execution = WizardOperation { shared: Mutex::new(Some(shared.clone())) };
        preparation.finish();
        preparation.finish();
        assert_eq!(shared.request("other").0, Decision::Activate);
        drop(execution);
        assert_eq!(shared.request("other").0, Decision::Switch);
    }

    #[test]
    fn switching_dispatches_release_once_without_dispatching_activation() {
        let shared = Shared { state: Mutex::new(state()) };
        assert!(shared.request("other").1.is_some());
        assert!(shared.request("other").1.is_none());
        assert_eq!(shared.request("installer-a").0, Decision::Switch);
    }

    #[test]
    fn operation_admission_that_loses_to_switching_is_a_normal_outcome() {
        let shared = Arc::new(Shared { state: Mutex::new(state()) });
        assert_eq!(shared.request("other").0, Decision::Switch);
        assert!(WizardOperation::try_acquire(Some(shared.clone())).unwrap().is_none());
        assert_eq!(shared.state.lock().unwrap().operations, 0);
    }
}
