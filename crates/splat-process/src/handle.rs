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
    /// Receiver for process events (stdout, stderr, exit, etc.)
    pub events: broadcast::Receiver<ProcessEvent>,
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
            child: Arc::new(Mutex::new(child)),
            started_at,
            events,
        }
    }
}

impl Clone for ProcessHandle {
    fn clone(&self) -> Self {
        // Note: cloning a ProcessHandle is only meaningful for tests.
        // The child reference is shared, but each clone gets an independent
        // event receiver. This is intentional for multi-consumer scenarios.
        Self {
            process_id: self.process_id,
            child: self.child.clone(),
            started_at: self.started_at,
            events: self.events.resubscribe(),
        }
    }
}
