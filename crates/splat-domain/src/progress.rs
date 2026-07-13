/// Represents progress information for a task or pipeline stage.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TaskProgress {
    /// Which stage this progress update belongs to
    pub stage_id: String,
    /// Progress percentage (0.0 – 1.0)
    pub percent: f64,
    /// Human-readable status message
    pub message: String,
    /// Current item being processed (e.g. frame number)
    pub current_item: u64,
    /// Total items to process (0 if unknown)
    pub total_items: u64,
}

impl TaskProgress {
    /// Create a new progress update.
    pub fn new(stage_id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            stage_id: stage_id.into(),
            percent: 0.0,
            message: message.into(),
            current_item: 0,
            total_items: 0,
        }
    }

    /// Set the progress fraction.
    pub fn with_percent(mut self, percent: f64) -> Self {
        self.percent = percent.clamp(0.0, 1.0);
        self
    }

    /// Set the item count.
    pub fn with_items(mut self, current: u64, total: u64) -> Self {
        self.current_item = current;
        self.total_items = total;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_task_progress_creation() {
        let progress = TaskProgress::new("frame_extraction", "Extracting frames...");
        assert_eq!(progress.stage_id, "frame_extraction");
        assert_eq!(progress.percent, 0.0);
    }

    #[test]
    fn test_task_progress_with_percent() {
        let progress = TaskProgress::new("training", "Training...").with_percent(0.5);
        assert!((progress.percent - 0.5).abs() < 1e-6);
    }

    #[test]
    fn test_task_progress_clamped() {
        let progress = TaskProgress::new("test", "test").with_percent(1.5);
        assert!((progress.percent - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_task_progress_with_items() {
        let progress = TaskProgress::new("extract", "Extracting").with_items(42, 100);
        assert_eq!(progress.current_item, 42);
        assert_eq!(progress.total_items, 100);
    }

    #[test]
    fn test_task_progress_serialization() {
        let progress = TaskProgress::new("test", "test")
            .with_percent(0.75)
            .with_items(3, 4);
        let json = serde_json::to_string(&progress).unwrap();
        let deserialized: TaskProgress = serde_json::from_str(&json).unwrap();
        assert!((deserialized.percent - 0.75).abs() < 1e-6);
        assert_eq!(deserialized.current_item, 3);
    }
}
