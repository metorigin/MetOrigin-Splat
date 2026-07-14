use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EngineInfo;
use splat_process::CommandSpec;

use crate::checkpoint::{Checkpoint, CheckpointScanner};
use crate::config::TrainingConfig;
use crate::dataset::{DatasetValidationResult, DatasetValidator};
use crate::export::{ExportManager, ExportRequest, ExportResult};

/// Brush training engine adapter.
///
/// Provides:
/// - Brush detection and version checking
/// - Dataset validation (COLMAP output completeness)
/// - Training configuration generation from presets
/// - Training command generation
/// - Checkpoint scanning and management
/// - PLY export
///
/// All Brush interactions must go through this adapter — never
/// construct Brush commands directly in business logic or UI.
///
/// # CLI Stability
///
/// ⚠️ Brush CLI parameters may change between versions. This adapter
/// should be tested against the pinned Brush version before each release.
pub struct BrushAdapter {
    /// Path to the detected Brush executable
    brush_path: PathBuf,
    /// Parsed Brush version string
    brush_version: String,
}

impl BrushAdapter {
    // ─── Detection ──────────────────────────────────────────────────────

    /// Detect Brush availability on the system.
    ///
    /// Runs `brush --version` to check if Brush is accessible.
    pub fn detect() -> EngineInfo {
        match Self::find_brush() {
            Ok(path) => {
                let version = Self::get_brush_version(&path).unwrap_or_default();
                EngineInfo {
                    name: "brush".into(),
                    version: Some(version),
                    path: Some(path.to_string_lossy().to_string()),
                    available: true,
                }
            }
            Err(_) => EngineInfo {
                name: "brush".into(),
                version: None,
                path: None,
                available: false,
            },
        }
    }

    /// Create a new adapter instance, detecting Brush.
    ///
    /// Returns `None` if Brush is not available.
    pub fn new() -> Option<Self> {
        let brush_path = Self::find_brush().ok()?;
        let brush_version = Self::get_brush_version(&brush_path).ok()?;
        Some(Self {
            brush_path,
            brush_version,
        })
    }

    /// Create an adapter from a path resolved by the application.
    pub fn from_path(brush_path: PathBuf) -> AppResult<Self> {
        let brush_version = Self::get_brush_version(&brush_path)?;
        let adapter = Self {
            brush_path,
            brush_version,
        };
        adapter.validate()?;
        Ok(adapter)
    }

    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo {
            name: "brush".into(),
            version: Some(self.brush_version.clone()),
            path: Some(self.brush_path.to_string_lossy().to_string()),
            available: true,
        }
    }

    /// Validate that Brush is functional by running a basic check.
    pub fn validate(&self) -> AppResult<()> {
        let output = std::process::Command::new(&self.brush_path)
            .arg("--version")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-4001",
                    ErrorCategory::Engine,
                    "Brush Validation Failed",
                    format!(
                        "Could not run Brush at '{}': {}",
                        self.brush_path.display(),
                        e
                    ),
                )
                .retryable(true)
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-4002",
                ErrorCategory::Engine,
                "Brush Not Responding",
                "Brush is installed but returned an error when running a basic check.",
            ));
        }

        Ok(())
    }

    /// Return the detected Brush version string.
    pub fn version(&self) -> &str {
        &self.brush_version
    }

    /// Return the path to the Brush executable.
    pub fn brush_path(&self) -> &Path {
        &self.brush_path
    }

    // ─── Preset Loading ─────────────────────────────────────────────────

    /// Load a training preset from a JSON file and generate a training config.
    pub fn load_config(&self, preset_path: &Path) -> AppResult<TrainingConfig> {
        let preset = TrainingConfig::load_preset(preset_path)?;
        Ok(TrainingConfig::from_preset(&preset))
    }

    // ─── Dataset Validation ─────────────────────────────────────────────

    /// Validate that the COLMAP dataset is complete and ready for training.
    pub fn validate_dataset(
        &self,
        colmap_dir: &Path,
        frames_dir: &Path,
    ) -> DatasetValidationResult {
        DatasetValidator::validate(colmap_dir, frames_dir)
    }

    // ─── Training Command ───────────────────────────────────────────────

    /// Build a `CommandSpec` for Brush training.
    ///
    /// ⚠️ CLI flags must be verified with `brush train --help`.
    pub fn build_train_command(
        &self,
        config: &TrainingConfig,
        dataset_path: &Path,
        checkpoint_path: &Path,
        start_iteration: u32,
        log_path: &Path,
    ) -> CommandSpec {
        let args = config.to_cli_args(dataset_path, checkpoint_path, start_iteration);

        CommandSpec::new(&self.brush_path, args, log_path)
    }

    // ─── Checkpoints ────────────────────────────────────────────────────

    /// Scan the training output directory for checkpoints.
    pub fn scan_checkpoints(&self, training_dir: &Path) -> AppResult<Vec<Checkpoint>> {
        CheckpointScanner::scan(training_dir)
    }

    /// Find the latest checkpoint for resuming training.
    pub fn find_latest_checkpoint(&self, training_dir: &Path) -> AppResult<Option<Checkpoint>> {
        CheckpointScanner::find_latest(training_dir)
    }

    /// Check whether training can be resumed.
    pub fn can_resume(&self, training_dir: &Path) -> bool {
        CheckpointScanner::has_resumable(training_dir)
    }

    // ─── Export ─────────────────────────────────────────────────────────

    /// Find the best PLY file from training output.
    pub fn find_best_ply(&self, training_dir: &Path) -> Option<PathBuf> {
        ExportManager::find_best_ply(training_dir)
    }

    /// Export PLY to the specified destination.
    pub fn export_ply(&self, request: &ExportRequest) -> AppResult<ExportResult> {
        ExportManager::export(request)
    }

    /// Validate a PLY file.
    pub fn validate_ply(&self, path: &Path) -> AppResult<()> {
        ExportManager::validate_ply(path)
    }

    // ─── Internal ───────────────────────────────────────────────────────

    /// Find the Brush executable in PATH.
    fn find_brush() -> AppResult<PathBuf> {
        std::process::Command::new("brush")
            .arg("--version")
            .output()
            .map_err(|_| {
                AppError::new(
                    "E-4001",
                    ErrorCategory::Engine,
                    "Brush Not Found",
                    "Brush is not installed or not available in your system PATH.",
                )
                .with_suggestions(vec![
                    "Install Brush from https://github.com/ArthurBrussee/brush",
                    "Ensure Brush is in your system PATH",
                    "You can also specify the Brush path in Settings",
                ])
            })?;

        // Try to locate the actual path
        #[cfg(target_os = "windows")]
        {
            if let Ok(output) = std::process::Command::new("where").arg("brush").output() {
                if output.status.success() {
                    if let Some(path) = String::from_utf8(output.stdout)
                        .ok()
                        .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                    {
                        return Ok(PathBuf::from(path));
                    }
                }
            }
        }

        Ok(PathBuf::from("brush"))
    }

    /// Get Brush version string from `brush --version`.
    fn get_brush_version(path: &Path) -> AppResult<String> {
        let output = std::process::Command::new(path)
            .arg("--version")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-4001",
                    ErrorCategory::Engine,
                    "Brush Detection Failed",
                    format!("Could not run brush: {}", e),
                )
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-4002",
                ErrorCategory::Engine,
                "Brush Version Check Failed",
                "Brush returned an error while reporting its version.",
            ));
        }
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let version = combined.lines().next().unwrap_or("").trim().to_string();

        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_info() {
        let info = BrushAdapter::detect();
        assert_eq!(info.name, "brush");
        // On CI without Brush, available will be false — that's fine
    }

    #[test]
    fn test_version_string() {
        let adapter = BrushAdapter {
            brush_path: PathBuf::from("brush"),
            brush_version: "0.2.0".into(),
        };
        assert_eq!(adapter.version(), "0.2.0");
    }

    #[test]
    fn test_build_train_command() {
        let adapter = BrushAdapter {
            brush_path: PathBuf::from("brush"),
            brush_version: "0.2.0".into(),
        };

        let config = TrainingConfig {
            iterations: 7000,
            sh_degree: 1,
            quality: "balanced".into(),
            antialiasing: true,
            densify: true,
            checkpoint_interval: 1000,
            render_interval: 700,
        };

        let spec = adapter.build_train_command(
            &config,
            Path::new("project.splat-project"),
            Path::new("training/checkpoints"),
            1000,
            Path::new("training/logs/brush.log"),
        );

        assert!(spec.program.to_string_lossy().contains("brush"));
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");
        assert!(args_str.contains("--total-steps"));
        assert!(args_str.contains("7000"));
        assert!(args_str.contains("project.splat-project"));
        assert!(args_str.contains("--export-path"));
        assert!(args_str.contains("--start-iter"));
    }

    #[test]
    fn test_can_resume_no_training_dir() {
        let adapter = BrushAdapter {
            brush_path: PathBuf::from("brush"),
            brush_version: "0.2.0".into(),
        };
        assert!(!adapter.can_resume(Path::new("/nonexistent/training")));
    }

    #[test]
    fn test_find_best_ply_no_dir() {
        let adapter = BrushAdapter {
            brush_path: PathBuf::from("brush"),
            brush_version: "0.2.0".into(),
        };
        assert!(adapter.find_best_ply(Path::new("/nonexistent")).is_none());
    }
}
