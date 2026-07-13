use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EngineInfo;
use splat_process::CommandSpec;

use crate::plan::{plan_extraction, ExtractionPlan, FrameExtractionPreset};
use crate::probe::probe_video;
use crate::probe::VideoMetadata;

/// FFmpeg engine adapter.
///
/// Provides:
/// - FFmpeg/FFprobe detection and version checking
/// - Video metadata probing via FFprobe
/// - Frame extraction plan computation
/// - CommandSpec generation for frame extraction
/// - Output frame validation
///
/// All FFmpeg interactions must go through this adapter — never
/// construct FFmpeg commands directly in business logic or UI.
pub struct FfmpegAdapter {
    /// Path to the detected ffmpeg executable
    ffmpeg_path: PathBuf,
    /// Path to the detected ffprobe executable
    ffprobe_path: PathBuf,
    /// Parsed FFmpeg version string
    ffmpeg_version: String,
}

impl FfmpegAdapter {
    // ─── Detection ──────────────────────────────────────────────────────

    /// Detect FFmpeg and FFprobe availability on the system.
    ///
    /// Returns an `EngineInfo` describing what was found. If engines are
    /// not available, `available` will be `false` with appropriate warnings.
    pub fn detect() -> EngineInfo {
        let ffmpeg_result = Self::find_executable("ffmpeg");
        let ffmpeg_path = match ffmpeg_result {
            Ok(p) => p,
            Err(_) => {
                return EngineInfo {
                    name: "ffmpeg".into(),
                    version: None,
                    path: None,
                    available: false,
                };
            }
        };

        let version = Self::get_ffmpeg_version(&ffmpeg_path).unwrap_or_default();

        EngineInfo {
            name: "ffmpeg".into(),
            version: Some(version),
            path: Some(ffmpeg_path.to_string_lossy().to_string()),
            available: true,
        }
    }

    /// Create an adapter instance, detecting FFmpeg paths.
    ///
    /// Returns `None` if FFmpeg is not available.
    pub fn new() -> Option<Self> {
        let ffmpeg_path = Self::find_executable("ffmpeg").ok()?;
        let ffprobe_path = Self::find_executable("ffprobe").ok()?;
        let ffmpeg_version = Self::get_ffmpeg_version(&ffmpeg_path).ok()?;

        Some(Self {
            ffmpeg_path,
            ffprobe_path,
            ffmpeg_version,
        })
    }

    /// Validate that FFmpeg is functional by running a simple check.
    pub fn validate(&self) -> AppResult<()> {
        let output = std::process::Command::new(&self.ffmpeg_path)
            .arg("-version")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-2101",
                    ErrorCategory::Engine,
                    "FFmpeg Validation Failed",
                    format!(
                        "Could not run FFmpeg at '{}': {}",
                        self.ffmpeg_path.display(),
                        e
                    ),
                )
                .retryable(true)
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-2102",
                ErrorCategory::Engine,
                "FFmpeg Not Responding",
                "FFmpeg is installed but returned an error when running -version.",
            ));
        }

        Ok(())
    }

    /// Return the detected FFmpeg version string.
    pub fn version(&self) -> &str {
        &self.ffmpeg_version
    }

    /// Return the path to the FFmpeg executable.
    pub fn ffmpeg_path(&self) -> &Path {
        &self.ffmpeg_path
    }

    /// Return the path to the FFprobe executable.
    pub fn ffprobe_path(&self) -> &Path {
        &self.ffprobe_path
    }

    // ─── Probing ────────────────────────────────────────────────────────

    /// Probe video metadata using FFprobe.
    ///
    /// Delegates to [`probe_video`] — see that function for details.
    pub fn probe_metadata(&self, video_path: &Path) -> AppResult<VideoMetadata> {
        probe_video(video_path)
    }

    // ─── Planning ───────────────────────────────────────────────────────

    /// Compute the optimal frame extraction plan.
    ///
    /// Takes video metadata and a preset, returns concrete parameters
    /// that will be passed to FFmpeg.
    pub fn plan_extraction(
        &self,
        metadata: &VideoMetadata,
        preset: &FrameExtractionPreset,
    ) -> ExtractionPlan {
        plan_extraction(metadata, preset)
    }

    // ─── Command building ───────────────────────────────────────────────

    /// Build a `CommandSpec` for frame extraction using FFmpeg.
    ///
    /// # Arguments
    ///
    /// * `plan` — The extraction plan computed by [`plan_extraction`]
    /// * `video_path` — Path to the source video file
    /// * `output_dir` — Directory where extracted frames will be written
    /// * `log_path` — Path to the FFmpeg log file
    pub fn build_command(
        &self,
        plan: &ExtractionPlan,
        video_path: &Path,
        output_dir: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        let mut args: Vec<std::ffi::OsString> = Vec::new();

        // Input file
        args.push("-i".into());
        args.push(video_path.as_os_str().to_owned());

        // Video filter graph (fps, scale, rotation)
        if !plan.filter_graph.is_empty() {
            args.push("-vf".into());
            args.push(plan.filter_graph.clone().into());
        }

        // Output quality (JPEG)
        args.push("-q:v".into()); // JPEG quality (2-31, lower = better)
        args.push("2".into()); // high quality

        // Start numbering from 0
        args.push("-start_number".into());
        args.push("0".into());

        // Video sync method
        args.push("-vsync".into());
        args.push("vfr".into()); // variable frame rate

        // Overwrite output files
        args.push("-y".into());

        // Output pattern
        let output_pattern = output_dir.join(&plan.output_pattern);
        args.push(output_pattern.as_os_str().to_owned());

        CommandSpec::new(&self.ffmpeg_path, args, log_path)
            .with_cwd(output_dir.parent().unwrap_or(output_dir))
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    /// Find an executable in the system PATH.
    fn find_executable(name: &str) -> AppResult<PathBuf> {
        // Use `std::process::Command` with the program name directly;
        // the OS will search PATH. If it can't be found, we provide
        // a helpful error.
        let output = std::process::Command::new(name)
            .arg("-version")
            .output()
            .map_err(|_| {
                AppError::new(
                    "E-2101",
                    ErrorCategory::Engine,
                    format!("{} Not Found", name),
                    format!(
                        "{} is not installed or not available in your system PATH.",
                        name
                    ),
                )
                .with_suggestions(vec![
                    &format!("Install {} from https://ffmpeg.org/download.html", name),
                    &format!(
                        "Make sure {} is in your system PATH after installation",
                        name
                    ),
                    "Restart the application after installing FFmpeg",
                ])
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-2102",
                ErrorCategory::Engine,
                format!("{} Error", name),
                format!("{} is installed but returned an error.", name),
            ));
        }

        // On Windows, use `where` to find the path; on Unix, use `which`
        // (although finding via PATH is enough — we use the name below)
        #[cfg(target_os = "windows")]
        {
            let where_output = std::process::Command::new("where")
                .arg(name)
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        String::from_utf8(o.stdout)
                            .ok()
                            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                    } else {
                        None
                    }
                });

            if let Some(path) = where_output {
                return Ok(PathBuf::from(path));
            }
        }

        // Fallback: return the name itself (OS will resolve via PATH on execution)
        Ok(PathBuf::from(name))
    }

    /// Get the FFmpeg version string from `ffmpeg -version`.
    fn get_ffmpeg_version(path: &Path) -> AppResult<String> {
        let output = std::process::Command::new(path)
            .arg("-version")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-2101",
                    ErrorCategory::Engine,
                    "FFmpeg Detection Failed",
                    format!("Could not run ffmpeg: {}", e),
                )
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        // Parse first line: "ffmpeg version 7.0.2 Copyright ..."
        let first_line = stdout.lines().next().unwrap_or("");
        // Extract version after "ffmpeg version " and before the next space
        let version = first_line
            .strip_prefix("ffmpeg version ")
            .or_else(|| first_line.strip_prefix("ffmpeg version "))
            .and_then(|rest| rest.split_whitespace().next())
            .unwrap_or("unknown");

        Ok(version.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Version parsing ────────────────────────────────────────────────

    #[test]
    fn test_ffmpeg_version_not_available_returns_none() {
        let adapter = FfmpegAdapter {
            ffmpeg_path: PathBuf::from("nonexistent-ffmpeg"),
            ffprobe_path: PathBuf::from("nonexistent-ffprobe"),
            ffmpeg_version: "0.0".into(),
        };

        // This should fail because the path doesn't exist
        let result = adapter.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_detect_returns_info() {
        let info = FfmpegAdapter::detect();
        // On CI without ffmpeg, available will be false
        // (this is fine — we're testing the interface, not the result)
        assert_eq!(info.name, "ffmpeg");
    }

    #[test]
    fn test_build_command_produces_valid_spec() {
        let adapter = FfmpegAdapter {
            ffmpeg_path: PathBuf::from("ffmpeg.exe"),
            ffprobe_path: PathBuf::from("ffprobe.exe"),
            ffmpeg_version: "7.0.2".into(),
        };

        let plan = ExtractionPlan {
            fps: 3.0,
            target_frame_count: 800,
            estimated_frame_count: 800,
            will_scale: true,
            rotation_correction: None,
            output_width: 1920,
            output_height: 1080,
            filter_graph:
                "fps=3,scale='min(1920,iw)':min'(1080,ih)':force_original_aspect_ratio=decrease"
                    .into(),
            estimated_bytes: 250_000_000,
            output_pattern: "%06d.jpg".into(),
        };

        let video = Path::new("input.mp4");
        let output = Path::new("output/frames");
        let log = Path::new("logs/ffmpeg.log");

        let spec = adapter.build_command(&plan, video, output, log);

        // Check the command contains required arguments
        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("-i"));
        assert!(args_str.contains("input.mp4"));
        assert!(args_str.contains("-vf"));
        assert!(args_str.contains("fps=3"));
        assert!(args_str.contains("-q:v"));
        assert!(args_str.contains("2"));
        assert!(args_str.contains("-start_number"));
        assert!(args_str.contains("0"));
        assert!(args_str.contains("-y"));
        assert!(args_str.contains("%06d.jpg"));
    }

    #[test]
    fn test_build_command_empty_filter_graph() {
        let adapter = FfmpegAdapter {
            ffmpeg_path: PathBuf::from("ffmpeg.exe"),
            ffprobe_path: PathBuf::from("ffprobe.exe"),
            ffmpeg_version: "7.0.2".into(),
        };

        let plan = ExtractionPlan {
            fps: 24.0,
            target_frame_count: 500,
            estimated_frame_count: 500,
            will_scale: false,
            rotation_correction: None,
            output_width: 1920,
            output_height: 1080,
            filter_graph: String::new(),
            estimated_bytes: 150_000_000,
            output_pattern: "%06d.jpg".into(),
        };

        let spec = adapter.build_command(
            &plan,
            Path::new("video.mp4"),
            Path::new("frames"),
            Path::new("log.txt"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        // No -vf when filter graph is empty
        assert!(!args_str.contains("-vf"));
        assert!(args_str.contains("-q:v 2"));
    }
}
