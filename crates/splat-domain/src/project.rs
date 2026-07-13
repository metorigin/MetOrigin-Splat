use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::pipeline::PipelineState;

/// Globally unique project identifier (UUID v7 for time-ordered values).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ProjectId(Uuid);

impl ProjectId {
    /// Create a new random project ID (UUID v7).
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    /// Create from an existing UUID string.
    pub fn from_uuid(uuid: Uuid) -> Self {
        Self(uuid)
    }

    /// Return the inner UUID.
    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for ProjectId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ProjectId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Lifecycle status of a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProjectStatus {
    /// Project is being created (directory setup in progress)
    Creating,
    /// Project is ready and no pipeline is running
    Ready,
    /// Pipeline is currently executing
    Running,
    /// Pipeline has been paused by the user
    Paused,
    /// All pipeline stages completed successfully
    Completed,
    /// Pipeline finished with one or more failures
    Failed,
}

impl std::fmt::Display for ProjectStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Creating => write!(f, "creating"),
            Self::Ready => write!(f, "ready"),
            Self::Running => write!(f, "running"),
            Self::Paused => write!(f, "paused"),
            Self::Completed => write!(f, "completed"),
            Self::Failed => write!(f, "failed"),
        }
    }
}

/// Describes the original input media for a project.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VideoSource {
    /// Original file name (e.g. "input.mp4")
    pub filename: String,
    /// Whether the source was copied into the project directory
    pub copied_to_project: bool,
}

/// Describes the original input media for a project.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageFolderSource {
    /// Folder name
    pub folder_name: String,
    /// Number of images found
    pub image_count: usize,
    /// Whether the source was copied into the project directory
    pub copied_to_project: bool,
}

/// The source type of the project media.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum ProjectSource {
    /// Single video file
    Video(VideoSource),
    /// Folder of images
    ImageFolder(ImageFolderSource),
}

impl ProjectSource {
    /// Human-readable label describing the source.
    pub fn label(&self) -> String {
        match self {
            Self::Video(src) => src.filename.clone(),
            Self::ImageFolder(src) => format!("{}（{} 张图片）", src.folder_name, src.image_count),
        }
    }
}

/// Configurable settings for a project.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProjectSettings {
    /// Training preset identifier (e.g. "fast", "balanced", "quality")
    pub preset: String,
    /// Maximum number of frames to extract (0 = no limit)
    pub max_frames: u32,
    /// Maximum dimension of the long edge of extracted images
    pub max_long_edge: u32,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            preset: "balanced".to_string(),
            max_frames: 800,
            max_long_edge: 1920,
        }
    }
}

/// A Gaussian Splatting project — the single source of truth.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Project {
    /// Schema version for migration support
    pub schema_version: u32,
    /// Unique project identifier
    pub id: ProjectId,
    /// Human-readable project name
    pub name: String,
    /// ISO 8601 creation timestamp
    pub created_at: DateTime<Utc>,
    /// ISO 8601 last update timestamp
    pub updated_at: DateTime<Utc>,
    /// Source media metadata
    pub source: Option<ProjectSource>,
    /// Project settings
    pub settings: ProjectSettings,
    /// Project lifecycle status
    pub status: ProjectStatus,
    /// ID of the currently active pipeline stage
    pub current_stage: Option<String>,
    /// Persisted pipeline state used for progress reporting and crash recovery.
    #[serde(default)]
    pub pipeline_state: PipelineState,
}

impl Project {
    /// Create a new project with default settings.
    pub fn new(name: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            schema_version: 1,
            id: ProjectId::new(),
            name: name.into(),
            created_at: now,
            updated_at: now,
            source: None,
            settings: ProjectSettings::default(),
            status: ProjectStatus::Creating,
            current_stage: None,
            pipeline_state: PipelineState::new(),
        }
    }

    /// Update the timestamp to now.
    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_id_creation() {
        let id = ProjectId::new();
        assert!(!format!("{}", id).is_empty());
    }

    #[test]
    fn test_project_id_unique() {
        let id1 = ProjectId::new();
        let id2 = ProjectId::new();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_new_project_defaults() {
        let project = Project::new("test-project");
        assert_eq!(project.name, "test-project");
        assert_eq!(project.schema_version, 1);
        assert_eq!(project.status, ProjectStatus::Creating);
        assert_eq!(project.settings.preset, "balanced");
        assert!(project.source.is_none());
    }

    #[test]
    fn test_project_serialization_roundtrip() {
        let project = Project::new("museum-room");
        let json = serde_json::to_string_pretty(&project).unwrap();
        let deserialized: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "museum-room");
        assert_eq!(deserialized.id.to_string(), project.id.to_string());
        assert_eq!(deserialized.schema_version, 1);
        assert!(json.contains("schema_version"));
        assert!(json.contains("museum-room"));
        assert!(json.contains("pipeline_state"));
    }

    #[test]
    fn test_legacy_project_without_pipeline_state_uses_default() {
        let project = Project::new("legacy");
        let mut value = serde_json::to_value(&project).unwrap();
        value.as_object_mut().unwrap().remove("pipeline_state");
        let restored: Project = serde_json::from_value(value).unwrap();
        assert_eq!(
            restored.pipeline_state.stages.len(),
            crate::pipeline::PipelineStageId::all().len()
        );
    }

    #[test]
    fn test_project_touch_updates_timestamp() {
        let mut project = Project::new("test");
        let old = project.updated_at;
        std::thread::sleep(std::time::Duration::from_millis(10));
        project.touch();
        assert!(project.updated_at > old);
    }

    #[test]
    fn test_project_source_label_video() {
        let source = ProjectSource::Video(VideoSource {
            filename: "demo.mp4".into(),
            copied_to_project: true,
        });
        assert_eq!(source.label(), "demo.mp4");
    }

    #[test]
    fn test_project_source_label_images() {
        let source = ProjectSource::ImageFolder(ImageFolderSource {
            folder_name: "photos".into(),
            image_count: 42,
            copied_to_project: false,
        });
        assert_eq!(source.label(), "photos（42 张图片）");
    }

    #[test]
    fn test_project_status_display() {
        assert_eq!(format!("{}", ProjectStatus::Creating), "creating");
        assert_eq!(format!("{}", ProjectStatus::Completed), "completed");
        assert_eq!(format!("{}", ProjectStatus::Failed), "failed");
    }
}
