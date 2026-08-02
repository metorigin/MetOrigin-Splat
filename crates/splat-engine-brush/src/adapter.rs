use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EngineInfo;
use splat_process::{background_command, CommandSpec};

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

const BRUSH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const DIAGNOSTIC_OUTPUT_LIMIT: usize = 2_048;

struct BrushProbeOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

enum BrushProbeFailure {
    Launch(std::io::Error),
    TimedOut(BrushProbeOutput),
}

impl BrushAdapter {
    // ─── Detection ──────────────────────────────────────────────────────

    /// Detect Brush availability on the system.
    ///
    /// Runs `brush --version` to check if Brush is accessible.
    pub fn detect() -> EngineInfo {
        match Self::find_brush()
            .and_then(|path| Self::get_brush_version(&path).map(|version| (path, version)))
        {
            Ok((path, version)) => EngineInfo {
                name: "brush".into(),
                version: Some(version),
                path: Some(path.to_string_lossy().to_string()),
                available: true,
            },
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
        Ok(Self {
            brush_path,
            brush_version,
        })
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
        Self::get_brush_version(&self.brush_path).map(|_| ())
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
        // Try to locate the actual path
        #[cfg(target_os = "windows")]
        {
            for executable in ["brush", "brush_app"] {
                if let Ok(output) = background_command("where").arg(executable).output() {
                    if output.status.success() {
                        if let Some(path) = String::from_utf8(output.stdout)
                            .ok()
                            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                            .filter(|path| !path.is_empty())
                        {
                            return Ok(PathBuf::from(path));
                        }
                    }
                }
            }
        }

        Ok(PathBuf::from("brush"))
    }

    /// Get Brush version string from `brush --version`.
    fn get_brush_version(path: &Path) -> AppResult<String> {
        let output = match run_brush_probe(path) {
            Ok(output) => output,
            Err(BrushProbeFailure::Launch(error)) => {
                return Err(AppError::new(
                    "E-4001",
                    ErrorCategory::Engine,
                    "Brush Detection Failed",
                    "Could not start the configured Brush executable.",
                )
                .with_technical(format!("brush --version launch error: {error}"))
                .retryable(true));
            }
            Err(BrushProbeFailure::TimedOut(output)) => {
                return Err(AppError::new(
                    "E-4002",
                    ErrorCategory::Engine,
                    "Brush Version Check Timed Out",
                    "Brush did not finish its version check within 10 seconds.",
                )
                .with_technical(probe_diagnostic("timed_out", &output))
                .retryable(true));
            }
        };

        interpret_brush_probe(output)
    }
}

fn interpret_brush_probe(output: BrushProbeOutput) -> AppResult<String> {
    if !output.success {
        let exit_code = output
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated".into());
        return Err(AppError::new(
            "E-4002",
            ErrorCategory::Engine,
            "Brush Version Check Failed",
            format!("Brush --version exited unsuccessfully (exit code {exit_code})."),
        )
        .with_technical(probe_diagnostic("non_zero_exit", &output))
        .retryable(true));
    }
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string();

    if version.is_empty() {
        return Err(AppError::new(
            "E-4002",
            ErrorCategory::Engine,
            "Brush Version Check Failed",
            "Brush exited successfully but did not report a version.",
        )
        .with_technical(probe_diagnostic("empty_version", &output)));
    }

    Ok(version)
}

fn run_brush_probe(path: &Path) -> Result<BrushProbeOutput, BrushProbeFailure> {
    let mut command = background_command(path);
    command
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(BrushProbeFailure::Launch)?;
    let started = Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child
                    .wait_with_output()
                    .map_err(BrushProbeFailure::Launch)?;
                return Ok(BrushProbeOutput {
                    success: output.status.success(),
                    exit_code: output.status.code(),
                    stdout: output.stdout,
                    stderr: output.stderr,
                });
            }
            Ok(None) if started.elapsed() < BRUSH_PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let output = child
                    .wait_with_output()
                    .map_err(BrushProbeFailure::Launch)?;
                return Err(BrushProbeFailure::TimedOut(BrushProbeOutput {
                    success: false,
                    exit_code: output.status.code(),
                    stdout: output.stdout,
                    stderr: output.stderr,
                }));
            }
            Err(error) => return Err(BrushProbeFailure::Launch(error)),
        }
    }
}

fn probe_diagnostic(reason: &str, output: &BrushProbeOutput) -> String {
    format!(
        "reason={reason}, exit_code={:?}, stdout={:?}, stderr={:?}",
        output.exit_code,
        diagnostic_snippet(&output.stdout),
        diagnostic_snippet(&output.stderr)
    )
}

/// Keep diagnostic output bounded and exclude the executable path and command
/// environment. `--version` receives no user or project path arguments.
fn diagnostic_snippet(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut snippet = text
        .trim()
        .chars()
        .take(DIAGNOSTIC_OUTPUT_LIMIT)
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\r' | '\t') {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect::<String>();
    if text.trim().chars().count() > DIAGNOSTIC_OUTPUT_LIMIT {
        snippet.push_str("...<truncated>");
    }
    if snippet.is_empty() {
        snippet.push_str("<empty>");
    }
    snippet
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe_output(
        success: bool,
        exit_code: Option<i32>,
        stdout: &[u8],
        stderr: &[u8],
    ) -> BrushProbeOutput {
        BrushProbeOutput {
            success,
            exit_code,
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[cfg(windows)]
    fn fake_brush_script(directory: &Path) -> PathBuf {
        let script = directory.join("fake-brush.cmd");
        std::fs::write(
            &script,
            "@echo off\r\necho call>>\"%~dp0calls.txt\"\r\necho brush-cli 0.3.0\r\n",
        )
        .unwrap();
        script
    }

    #[cfg(unix)]
    fn fake_brush_script(directory: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let script = directory.join("fake-brush");
        std::fs::write(
            &script,
            "#!/bin/sh\necho call >> \"$(dirname \"$0\")/calls.txt\"\necho brush-cli 0.3.0\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();
        script
    }

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
    fn from_path_runs_the_version_probe_once() {
        let directory = tempfile::tempdir().unwrap();
        let script = fake_brush_script(directory.path());

        let adapter = BrushAdapter::from_path(script).unwrap();

        assert_eq!(adapter.version(), "brush-cli 0.3.0");
        let calls = std::fs::read_to_string(directory.path().join("calls.txt")).unwrap();
        assert_eq!(calls.lines().count(), 1);
    }

    #[test]
    fn parses_version_from_successful_probe_output() {
        let version =
            interpret_brush_probe(probe_output(true, Some(0), b"brush-cli 0.3.0\n", b"")).unwrap();

        assert_eq!(version, "brush-cli 0.3.0");
    }

    #[test]
    fn non_zero_probe_preserves_bounded_diagnostics() {
        let error = interpret_brush_probe(probe_output(
            false,
            Some(7),
            b"",
            b"GPU initialization failed",
        ))
        .unwrap_err();

        assert_eq!(error.code, "E-4002");
        assert!(error.user_message.contains("exit code 7"));
        let technical = error.technical_message.as_deref().unwrap();
        assert!(technical.contains("non_zero_exit"));
        assert!(technical.contains("GPU initialization failed"));
        assert!(!technical.contains("brush_app.exe"));
    }

    #[test]
    fn diagnostic_output_is_sanitized_and_truncated() {
        let mut output = vec![b'x'; DIAGNOSTIC_OUTPUT_LIMIT + 10];
        output[2] = 0;

        let diagnostic = diagnostic_snippet(&output);

        assert!(diagnostic.contains('\u{fffd}'));
        assert!(diagnostic.ends_with("...<truncated>"));
        assert!(diagnostic.chars().count() <= DIAGNOSTIC_OUTPUT_LIMIT + 14);
    }

    #[test]
    fn successful_probe_without_version_is_rejected() {
        let error = interpret_brush_probe(probe_output(true, Some(0), b"\r\n", b"")).unwrap_err();

        assert_eq!(error.code, "E-4002");
        assert!(error
            .technical_message
            .as_deref()
            .is_some_and(|message| message.contains("empty_version")));
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
