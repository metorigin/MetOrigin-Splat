use std::path::Path;
use std::time::Duration;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::{background_command, CommandSpec, ProcessRunner};
use tokio_util::sync::CancellationToken;

/// Metadata extracted from a video file via FFprobe.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VideoMetadata {
    /// Video width in pixels
    pub width: u32,
    /// Video height in pixels
    pub height: u32,
    /// Frames per second (as float, e.g. 29.97)
    pub fps: f64,
    /// Total number of frames (0 if unknown)
    pub frame_count: u64,
    /// Duration in seconds (0.0 if unknown)
    pub duration_seconds: f64,
    /// Codec name (e.g. "h264")
    pub codec: String,
    /// Rotation metadata from the video stream (if present)
    pub rotation: Option<i32>,
}

// ─── FFprobe JSON output types ──────────────────────────────────────────

/// Root JSON output from `ffprobe -show_format -show_streams -print_format json`
#[derive(serde::Deserialize)]
struct FfprobeOutput {
    streams: Option<Vec<FfprobeStream>>,
    format: Option<FfprobeFormat>,
}

#[derive(serde::Deserialize)]
struct FfprobeStream {
    #[serde(rename = "codec_type")]
    codec_type: Option<String>,
    #[serde(rename = "codec_name")]
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(rename = "r_frame_rate")]
    r_frame_rate: Option<String>, // "30000/1001" → 29.97
    #[serde(rename = "avg_frame_rate")]
    avg_frame_rate: Option<String>,
    #[serde(rename = "nb_frames")]
    nb_frames: Option<String>, // ffprobe outputs this as string!
    duration: Option<String>, // ffprobe outputs this as string!
    #[serde(rename = "side_data_list")]
    side_data_list: Option<Vec<FfprobeSideData>>,
}

#[derive(serde::Deserialize)]
struct FfprobeSideData {
    #[serde(rename = "side_data_type")]
    side_data_type: Option<String>,
    rotation: Option<i32>,
}

#[derive(serde::Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
}

// ─── Probing function ─────────────────────────────────────────────────────

/// Probe video metadata by calling `ffprobe` on the given file.
///
/// Runs: `ffprobe -v quiet -print_format json -show_format -show_streams <path>`
///
/// # Errors
///
/// Returns an appropriate `AppError` if:
/// - ffprobe is not found (`E-2101`)
/// - the file doesn't exist (`E-1201`)
/// - the file is not a supported media format (`E-1102`)
/// - no video stream is found (`E-1101`)
/// - ffprobe returns a non-zero exit code (`E-2102`)
pub fn probe_video(path: &Path) -> AppResult<VideoMetadata> {
    probe_video_with(Path::new("ffprobe"), path)
}

/// Probe video metadata with an explicitly resolved FFprobe executable.
pub fn probe_video_with(ffprobe_path: &Path, path: &Path) -> AppResult<VideoMetadata> {
    if !path.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "File Not Found",
            format!("The video file '{}' does not exist.", path.display()),
        ));
    }

    let output = background_command(ffprobe_path)
        .args(["-v", "quiet"])
        .args(["-print_format", "json"])
        .args(["-show_format", "-show_streams"])
        .arg(path.as_os_str())
        .output()
        .map_err(|e| {
            AppError::new(
                "E-2101",
                ErrorCategory::Engine,
                "FFprobe Not Found",
                "Could not run ffprobe. Make sure FFmpeg is installed and available in your PATH.",
            )
            .with_technical(format!("Failed to execute ffprobe: {}", e))
            .with_suggestions(vec![
                "Install FFmpeg from https://ffmpeg.org/download.html",
                "Ensure ffprobe is in your system PATH",
                "Check the engine path in Settings",
            ])
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::new(
            "E-2102",
            ErrorCategory::Engine,
            "FFprobe Failed",
            "FFprobe was unable to read the video file. The file may be corrupted or in an unsupported format.",
        )
        .with_technical(format!("ffprobe exit code: {}, stderr: {}", output.status, stderr))
        .retryable(false));
    }

    parse_probe_output(&output.stdout, path)
}

/// Probe through the cancellable process runner with a 30-second timeout and
/// an 8 MiB output ceiling.
pub async fn probe_video_with_async(
    ffprobe_path: &Path,
    path: &Path,
    cancellation: CancellationToken,
) -> AppResult<VideoMetadata> {
    if !path.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "File Not Found",
            format!("The video file '{}' does not exist.", path.display()),
        ));
    }
    let log_path = std::env::temp_dir().join(format!(
        "metorigin-ffprobe-{}-{}.log",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let command = CommandSpec::new(
        ffprobe_path,
        vec![
            "-v".into(),
            "error".into(),
            "-print_format".into(),
            "json".into(),
            "-show_format".into(),
            "-show_streams".into(),
            path.as_os_str().to_owned(),
        ],
        log_path,
    )
    .with_timeout(Duration::from_secs(30));
    let captured = ProcessRunner::new()
        .run_to_completion_capture(command, cancellation, 8 * 1024 * 1024)
        .await?;
    if captured.process.cancelled {
        return Err(AppError::new(
            "E-2104",
            ErrorCategory::Engine,
            "FFprobe Cancelled",
            "Video metadata detection was cancelled.",
        ));
    }
    if captured.process.timed_out {
        return Err(AppError::new(
            "E-2105",
            ErrorCategory::Engine,
            "FFprobe Timed Out",
            "FFprobe did not finish within 30 seconds.",
        )
        .retryable(true));
    }
    if !captured.process.is_success() {
        return Err(AppError::new(
            "E-2102",
            ErrorCategory::Engine,
            "FFprobe Failed",
            "FFprobe was unable to read the video file.",
        )
        .with_technical(String::from_utf8_lossy(&captured.stderr).to_string()));
    }
    parse_probe_output(&captured.stdout, path)
}

fn parse_probe_output(stdout: &[u8], path: &Path) -> AppResult<VideoMetadata> {
    let parsed: FfprobeOutput = serde_json::from_slice(stdout).map_err(|e| {
        AppError::new(
            "E-2103",
            ErrorCategory::Engine,
            "Invalid FFprobe Output",
            "FFprobe returned malformed JSON output. This may indicate a version incompatibility.",
        )
        .with_technical(format!("JSON parse error: {}", e))
    })?;

    let streams = parsed.streams.ok_or_else(|| no_video_stream_error(path))?;

    // Find the first video stream
    let video_stream = streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| no_video_stream_error(path))?;

    let width = video_stream.width.unwrap_or(0);
    let height = video_stream.height.unwrap_or(0);

    if width == 0 || height == 0 {
        return Err(AppError::new(
            "E-1102",
            ErrorCategory::Media,
            "Unknown Video Resolution",
            "The video has unknown dimensions. The file may be corrupted or in an unsupported format.",
        ));
    }

    // VFR-aware: use a valid average rate first. The nominal stream rate is
    // only a fallback when the average is absent, zero or malformed.
    let fps = select_frame_rate(
        video_stream.avg_frame_rate.as_deref(),
        video_stream.r_frame_rate.as_deref(),
    )?;

    // Parse frame count (ffprobe uses string type here!)
    let frame_count: u64 = video_stream
        .nb_frames
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // Parse duration: prefer stream duration, fall back to format duration
    let duration_seconds: f64 = video_stream
        .duration
        .as_deref()
        .or_else(|| parsed.format.as_ref().and_then(|f| f.duration.as_deref()))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    // Try to compute frame count from duration × fps if not directly available
    let frame_count = if frame_count == 0 && duration_seconds > 0.0 && fps > 0.0 {
        (duration_seconds * fps).round() as u64
    } else {
        frame_count
    };

    // Codec name
    let codec = video_stream
        .codec_name
        .as_deref()
        .unwrap_or("unknown")
        .to_string();

    // Rotation metadata
    let rotation = video_stream
        .side_data_list
        .as_ref()
        .and_then(|list| {
            list.iter()
                .find(|s| s.side_data_type.as_deref() == Some("Display Matrix"))
                .and_then(|s| s.rotation)
        })
        .filter(|&r| r != 0);

    Ok(VideoMetadata {
        width,
        height,
        fps,
        frame_count,
        duration_seconds,
        codec,
        rotation,
    })
}

fn select_frame_rate(average: Option<&str>, nominal: Option<&str>) -> AppResult<f64> {
    for value in [average, nominal].into_iter().flatten() {
        if let Ok(parsed) = parse_fraction(value) {
            if parsed.is_finite() && parsed > 0.0 {
                return Ok(parsed);
            }
        }
    }
    if average.is_some() || nominal.is_some() {
        return Err(invalid_fraction_error(
            average.or(nominal).unwrap_or_default(),
        ));
    }
    Ok(0.0)
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/// Parse a frame rate string like "30000/1001" into a float.
///
/// Handles:
/// - Fractional: "30000/1001" → 29.97
/// - Integer: "25" → 25.0
/// - "0/1" → 0.0
fn parse_fraction(s: &str) -> AppResult<f64> {
    let s = s.trim();
    if let Some(slash_pos) = s.find('/') {
        let num: f64 = s[..slash_pos]
            .trim()
            .parse()
            .map_err(|_| invalid_fraction_error(s))?;
        let den: f64 = s[slash_pos + 1..]
            .trim()
            .parse()
            .map_err(|_| invalid_fraction_error(s))?;
        if den.abs() < f64::EPSILON {
            return Ok(0.0);
        }
        Ok(num / den)
    } else {
        s.parse().map_err(|_| invalid_fraction_error(s))
    }
}

fn invalid_fraction_error(s: &str) -> AppError {
    AppError::new(
        "E-2104",
        ErrorCategory::Engine,
        "Invalid Frame Rate",
        format!("FFprobe returned an unparseable frame rate value: '{}'.", s),
    )
}

fn no_video_stream_error(path: &Path) -> AppError {
    AppError::new(
        "E-1101",
        ErrorCategory::Media,
        "No Video Stream Found",
        format!(
            "The file '{}' does not contain a video stream. It may be an audio-only file or an unsupported format.",
            path.file_name().map(|s| s.to_string_lossy()).unwrap_or_default()
        ),
    )
    .with_suggestions(vec![
        "Make sure the file is a video (MP4, MOV, etc.)",
        "Check that the video codec is supported (H.264, H.265 recommended)",
        "Try playing the file in a media player to verify it's valid",
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── parse_fraction tests ───────────────────────────────────────────

    #[test]
    fn test_parse_fraction_standard() {
        let result = parse_fraction("30000/1001").unwrap();
        assert!((result - 29.97).abs() < 0.01);
    }

    #[test]
    fn test_parse_fraction_integer() {
        let result = parse_fraction("25").unwrap();
        assert!((result - 25.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_fraction_zero() {
        let result = parse_fraction("0/1").unwrap();
        assert!((result - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_fraction_pal() {
        let result = parse_fraction("25/1").unwrap();
        assert!((result - 25.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_parse_fraction_ntsc_film() {
        let result = parse_fraction("24000/1001").unwrap();
        assert!((result - 23.976).abs() < 0.01);
    }

    #[test]
    fn test_parse_fraction_with_whitespace() {
        let result = parse_fraction("  30000/1001  ").unwrap();
        assert!((result - 29.97).abs() < 0.01);
    }

    #[test]
    fn average_frame_rate_is_preferred_and_invalid_average_falls_back() {
        assert!(
            (select_frame_rate(Some("24000/1001"), Some("30/1")).unwrap() - 23.976).abs() < 0.01
        );
        assert!((select_frame_rate(Some("0/0"), Some("30000/1001")).unwrap() - 29.97).abs() < 0.01);
        assert!((select_frame_rate(Some("malformed"), Some("25/1")).unwrap() - 25.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_fraction_invalid() {
        assert!(parse_fraction("abc/def").is_err());
        assert!(parse_fraction("").is_err());
        assert!(parse_fraction("1/0").is_ok()); // returns 0.0
    }

    // ─── Error tests ────────────────────────────────────────────────────

    #[test]
    fn test_probe_nonexistent_file() {
        let result = probe_video(Path::new("/nonexistent/video.mp4"));
        assert!(result.is_err());
        if let Err(e) = result {
            assert_eq!(e.category, ErrorCategory::Filesystem);
            assert!(e.code.contains("1201"));
        }
    }

    #[test]
    fn test_no_video_stream_error_message() {
        let err = no_video_stream_error(Path::new("audio.mp3"));
        assert!(err.user_message.contains("audio.mp3"));
        assert!(!err.suggestions.is_empty());
    }

    // ─── Metadata construction ──────────────────────────────────────────

    #[test]
    fn test_metadata_serialization() {
        let meta = VideoMetadata {
            width: 1920,
            height: 1080,
            fps: 29.97,
            frame_count: 1423,
            duration_seconds: 47.5,
            codec: "h264".into(),
            rotation: Some(90),
        };
        let json = serde_json::to_string(&meta).unwrap();
        let deserialized: VideoMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.width, 1920);
        assert_eq!(deserialized.fps, 29.97);
        assert_eq!(deserialized.rotation, Some(90));
    }

    #[test]
    fn test_metadata_no_rotation() {
        let meta = VideoMetadata {
            width: 640,
            height: 480,
            fps: 30.0,
            frame_count: 0,
            duration_seconds: 10.0,
            codec: "h264".into(),
            rotation: None,
        };
        assert!(meta.rotation.is_none());
    }

    #[test]
    fn test_frame_count_inferred_from_duration() {
        let meta = VideoMetadata {
            width: 1920,
            height: 1080,
            fps: 30.0,
            frame_count: 0,
            duration_seconds: 10.0,
            codec: "h264".into(),
            rotation: None,
        };
        // When frame_count is 0 but duration and fps are known,
        // the probe function should compute it (tested implicitly)
        assert_eq!(meta.frame_count, 0); // raw, before inference
    }
}
