use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::process::Child;
use tokio::sync::{broadcast, Mutex};

use crate::event::ProcessEvent;

/// Handle to a running process, returned by `ProcessRunner::execute`.
///
/// Can be used to monitor process output via the event channel,
/// and to cancel the process via `ProcessRunner::cancel`.
#[derive(Debug)]
pub struct ProcessHandle {
    /// System process ID
    pub process_id: u32,
    /// When the process was started
    pub started_at: DateTime<Utc>,
    /// The underlying child process (for cancellation / waiting)
    pub(crate) child: Arc<Mutex<Child>>,
    pub(crate) lifecycle: Arc<Mutex<LifecycleReceipt>>,
    #[cfg(unix)]
    pub(crate) process_group: Arc<crate::unix_group::ProcessGroup>,
    /// Receiver for process events (stdout, stderr, exit, etc.)
    pub events: broadcast::Receiver<ProcessEvent>,
}

#[derive(Debug, Default)]
pub(crate) struct LifecycleReceipt {
    pub task: Option<tokio::task::JoinHandle<Result<(), String>>>,
    // A failed cleanup remains owned; the next finish attempt must retry it.
    pub error: Option<String>,
}

impl ProcessHandle {
    /// Create a new process handle.
    pub(crate) fn new(
        child: Child,
        started_at: DateTime<Utc>,
        events: broadcast::Receiver<ProcessEvent>,
    ) -> Self {
        Self {
            process_id: child.id().unwrap_or(0),
            #[cfg(unix)]
            process_group: Arc::new(crate::unix_group::ProcessGroup::new(
                child.id().unwrap_or(0),
            )),
            child: Arc::new(Mutex::new(child)),
            lifecycle: Arc::new(Mutex::new(LifecycleReceipt::default())),
            started_at,
            events,
        }
    }
}

impl Clone for ProcessHandle {
    fn clone(&self) -> Self {
        // Ownership and lifecycle receipt are shared; events are independent.
        Self {
            process_id: self.process_id,
            child: self.child.clone(),
            lifecycle: self.lifecycle.clone(),
            #[cfg(unix)]
            process_group: self.process_group.clone(),
            started_at: self.started_at,
            events: self.events.resubscribe(),
        }
    }
}
