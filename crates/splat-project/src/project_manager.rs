use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::project::{Project, ProjectStatus};
use splat_domain::PipelineState;

use crate::migration::{self, CURRENT_SCHEMA_VERSION};
use crate::paths;

/// Manages project lifecycle: creation, opening, saving, validation.
pub struct ProjectManager {
    /// Root directory where projects are stored by default.
    default_projects_dir: PathBuf,
}

impl ProjectManager {
    /// Create a new project manager with the given default projects directory.
    pub fn new(default_projects_dir: PathBuf) -> Self {
        Self {
            default_projects_dir,
        }
    }

    /// Create a new project directory with the given name and return the Project.
    ///
    /// The project will be created at `{default_projects_dir}/{name}.splat-project/`.
    pub fn create_project(&self, name: &str) -> AppResult<(Project, PathBuf)> {
        let project_dir = self
            .default_projects_dir
            .join(format!("{}.splat-project", name));

        if project_dir.exists() {
            return Err(AppError::new(
                "E-1001",
                ErrorCategory::User,
                "Project Already Exists",
                format!(
                    "A project named '{}' already exists at '{}'.",
                    name,
                    project_dir.display()
                ),
            ));
        }

        let mut project = Project::new(name);
        project.status = ProjectStatus::Ready;

        // Create directory structure
        paths::create_project_directories(&project_dir).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Create Project Directory",
                format!("Could not create project directory: {}", e),
            )
            .with_technical(format!("{}", e))
            .retryable(true)
        })?;

        // Write initial project.json
        self.save_project_internal(&project, &project_dir)?;

        Ok((project, project_dir))
    }

    /// Open an existing project from its directory path.
    pub fn open_project(&self, project_dir: &Path) -> AppResult<Project> {
        let json_path = paths::project_json_path(project_dir);

        if !json_path.exists() {
            return Err(AppError::new(
                "E-1001",
                ErrorCategory::User,
                "Project Not Found",
                format!(
                    "No project.json found at '{}'. The directory may not be a valid project.",
                    json_path.display()
                ),
            ));
        }

        let content = std::fs::read_to_string(&json_path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Project File",
                format!("Could not read project.json: {}", e),
            )
            .with_technical(format!("{}", e))
        })?;

        let json_value: serde_json::Value = serde_json::from_str(&content).map_err(|e| {
            AppError::new(
                "E-1002",
                ErrorCategory::User,
                "Invalid Project JSON",
                "The project.json file contains invalid JSON.",
            )
            .with_technical(format!("JSON parse error: {}", e))
        })?;

        let version = migration::detect_schema_version(&json_value);
        if version != CURRENT_SCHEMA_VERSION {
            // Attempt migration
            let migrated = migration::migrate(json_value, version, CURRENT_SCHEMA_VERSION)?;
            let mut project: Project = serde_json::from_value(migrated).map_err(|e| {
                AppError::new(
                    "E-1002",
                    ErrorCategory::Internal,
                    "Project Migration Failed",
                    "The project data could not be migrated to the current version.",
                )
                .with_technical(format!("Deserialization error after migration: {}", e))
            })?;
            project.touch();
            self.save_project_internal(&project, project_dir)?;
            return Ok(project);
        }

        let project: Project = serde_json::from_value(json_value).map_err(|e| {
            AppError::new(
                "E-1002",
                ErrorCategory::User,
                "Invalid Project Data",
                "The project.json contains data that does not match the expected format.",
            )
            .with_technical(format!("Deserialization error: {}", e))
        })?;

        Ok(project)
    }

    /// Save a project to its directory (atomic write).
    pub fn save_project(&self, project: &Project, project_dir: &Path) -> AppResult<()> {
        self.save_project_internal(project, project_dir)
    }

    /// Atomically update the persisted pipeline and project lifecycle state.
    pub fn save_pipeline_state(
        &self,
        project_dir: &Path,
        pipeline_state: &PipelineState,
    ) -> AppResult<()> {
        let mut project = self.open_project(project_dir)?;
        project.pipeline_state = pipeline_state.clone();
        project.current_stage = pipeline_state
            .current_stage
            .map(|stage| format!("{stage:?}"));
        project.status = if pipeline_state
            .stages
            .values()
            .any(|stage| stage.status == splat_domain::StageStatus::Failed)
        {
            ProjectStatus::Failed
        } else if pipeline_state.stages.values().all(|stage| {
            matches!(
                stage.status,
                splat_domain::StageStatus::Completed | splat_domain::StageStatus::Skipped
            )
        }) {
            ProjectStatus::Completed
        } else if pipeline_state.current_stage.is_some() {
            ProjectStatus::Running
        } else {
            ProjectStatus::Ready
        };
        project.touch();
        self.save_project_internal(&project, project_dir)
    }

    /// Internal save with atomic write pattern:
    /// 1. Write to temp file
    /// 2. Flush
    /// 3. Atomic replace
    fn save_project_internal(&self, project: &Project, project_dir: &Path) -> AppResult<()> {
        let json_path = paths::project_json_path(project_dir);

        let json_content = serde_json::to_string_pretty(project).map_err(|e| {
            AppError::new(
                "E-9001",
                ErrorCategory::Internal,
                "Serialization Error",
                "Failed to serialize project data.",
            )
            .with_technical(format!("{}", e))
        })?;

        // Write to a temporary file first
        let temp_path = json_path.with_extension("json.tmp");
        std::fs::write(&temp_path, &json_content).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Write Project File",
                format!("Could not write to project directory: {}", e),
            )
            .with_technical(format!("{}", e))
            .retryable(true)
        })?;

        // Atomic replace
        std::fs::rename(&temp_path, &json_path).map_err(|e| {
            // Try to clean up the temp file
            let _ = std::fs::remove_file(&temp_path);
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Save Project",
                format!("Could not save project file: {}", e),
            )
            .with_technical(format!("{}", e))
            .retryable(true)
        })?;

        Ok(())
    }

    /// Validate a project's directory structure and data integrity.
    pub fn validate_project(&self, project_dir: &Path) -> AppResult<()> {
        let json_path = paths::project_json_path(project_dir);

        if !json_path.exists() {
            return Err(AppError::new(
                "E-1001",
                ErrorCategory::User,
                "Invalid Project",
                "The project directory does not contain a project.json file.",
            ));
        }

        // Verify required directories exist
        for dir in &[
            paths::source_dir(project_dir),
            paths::frames_dir(project_dir),
            paths::colmap_dir(project_dir),
            paths::training_dir(project_dir),
            paths::output_dir(project_dir),
            paths::logs_dir(project_dir),
        ] {
            if !dir.exists() {
                return Err(AppError::new(
                    "E-1001",
                    ErrorCategory::User,
                    "Incomplete Project",
                    format!(
                        "Required directory '{}' is missing from the project.",
                        dir.file_name().unwrap_or_default().to_string_lossy()
                    ),
                ));
            }
        }

        Ok(())
    }

    /// Return the default projects directory.
    pub fn default_projects_dir(&self) -> &Path {
        &self.default_projects_dir
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEMP_DIR_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> PathBuf {
        let sequence = TEMP_DIR_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("splat-test-{}-{sequence}", std::process::id()))
    }

    #[test]
    fn test_create_and_open_project() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());

        let (project, project_dir) = manager.create_project("test-create").unwrap();
        assert_eq!(project.name, "test-create");
        assert!(project_dir.exists());
        assert!(paths::project_json_path(&project_dir).exists());

        // Open it back
        let opened = manager.open_project(&project_dir).unwrap();
        assert_eq!(opened.id.to_string(), project.id.to_string());
        assert_eq!(opened.name, "test-create");
        assert_eq!(opened.settings.preset, "balanced");

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_create_duplicate_project_fails() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());

        manager.create_project("duplicate").unwrap();
        let result = manager.create_project("duplicate");
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_open_nonexistent_project_fails() {
        let manager = ProjectManager::new(PathBuf::from("/nonexistent"));
        let result = manager.open_project(Path::new("/nonexistent/test.splat-project"));
        assert!(result.is_err());
    }

    #[test]
    fn test_save_and_reopen_roundtrip() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());

        let (mut project, project_dir) = manager.create_project("roundtrip").unwrap();
        project.name = "updated-name".into();
        project.settings.preset = "quality".into();
        manager.save_project(&project, &project_dir).unwrap();

        let reopened = manager.open_project(&project_dir).unwrap();
        assert_eq!(reopened.name, "updated-name");
        assert_eq!(reopened.settings.preset, "quality");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_save_pipeline_state_updates_project() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());
        let (_, project_dir) = manager.create_project("pipeline-state").unwrap();
        let mut pipeline = PipelineState::new();
        pipeline.current_stage = Some(splat_domain::PipelineStageId::FrameExtraction);
        pipeline
            .stages
            .get_mut(&splat_domain::PipelineStageId::FrameExtraction)
            .unwrap()
            .status = splat_domain::StageStatus::Running;

        manager
            .save_pipeline_state(&project_dir, &pipeline)
            .unwrap();
        let reopened = manager.open_project(&project_dir).unwrap();
        assert_eq!(reopened.status, ProjectStatus::Running);
        assert_eq!(
            reopened.pipeline_state.current_stage,
            pipeline.current_stage
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_valid_project() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());

        let (_, project_dir) = manager.create_project("validate-test").unwrap();
        let result = manager.validate_project(&project_dir);
        assert!(result.is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_project_sets_ready_status_after_creation() {
        let dir = temp_dir();
        let manager = ProjectManager::new(dir.clone());

        let (project, project_dir) = manager.create_project("ready-test").unwrap();
        assert_eq!(project.status, ProjectStatus::Ready);

        let opened = manager.open_project(&project_dir).unwrap();
        assert_eq!(opened.status, ProjectStatus::Ready);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
