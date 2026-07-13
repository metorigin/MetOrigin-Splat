use std::io::Read;
use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

use crate::plan::ExtractionPlan;
use crate::probe::VideoMetadata;

/// Entry for a single extracted frame.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrameEntry {
    /// Frame filename (e.g. "000042.jpg")
    pub filename: String,
    /// Frame index (0-based)
    pub index: u32,
    /// Image width in pixels
    pub width: u32,
    /// Image height in pixels
    pub height: u32,
    /// File size in bytes
    pub size_bytes: u64,
}

/// Manifest file listing all extracted frames.
///
/// Written to `frames/frames.json` after successful extraction.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrameManifest {
    /// Schema version for forward compatibility
    pub schema_version: u32,
    /// Total number of frames extracted
    pub total_frames: u32,
    /// Original video metadata used for extraction
    pub source_metadata: VideoMetadata,
    /// Extraction parameters used
    pub extraction_plan: ExtractionPlan,
    /// List of all frame entries (in index order)
    pub frames: Vec<FrameEntry>,
    /// Total disk usage in bytes
    pub total_size_bytes: u64,
}

/// Validate extracted frames in a directory and produce a manifest.
///
/// Scans `frame_dir` for all `.jpg` files, validates each frame,
/// and returns a `FrameManifest` describing the results.
///
/// # Errors
///
/// Returns an error if:
/// - The directory doesn't exist (`E-1201`)
/// - No frames were extracted (`E-1103`)
/// - A frame file is empty or corrupted (`E-1103`)
pub fn validate_frames(
    frame_dir: &Path,
    plan: &ExtractionPlan,
    metadata: &VideoMetadata,
) -> AppResult<FrameManifest> {
    if !frame_dir.exists() {
        return Err(AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Frames Directory Not Found",
            format!(
                "The frames output directory '{}' does not exist.",
                frame_dir.display()
            ),
        ));
    }

    // Read directory entries
    let dir_reader = std::fs::read_dir(frame_dir).map_err(|e| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read Frames Directory",
            format!("Could not read frames directory: {}", e),
        )
        .with_technical(format!("{}", e))
    })?;

    // Collect all .jpg/.jpeg files
    let mut entries: Vec<std::fs::DirEntry> = dir_reader
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .map(|ext| ext == "jpg" || ext == "jpeg")
                .unwrap_or(false)
        })
        .collect();

    // Sort by filename (alphabetical order = numerical order for zero-padded)
    entries.sort_by_key(|a| a.file_name());

    if entries.is_empty() {
        return Err(AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "No Frames Extracted",
            "FFmpeg did not produce any output frames. The video may be corrupted or empty.",
        )
        .with_suggestions(vec![
            "Check that the video file is not corrupted",
            "Try a different video file to verify the extraction works",
            "Check the FFmpeg log for detailed error messages",
        ]));
    }

    let mut frames = Vec::with_capacity(entries.len());
    let mut total_size: u64 = 0;

    for (i, entry) in entries.iter().enumerate() {
        let path = entry.path();
        let file_meta = std::fs::metadata(&path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Frame File",
                format!("Could not read frame file '{}': {}", path.display(), e),
            )
        })?;

        let size = file_meta.len();

        if size == 0 {
            return Err(AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Corrupted Frame File",
                format!(
                    "Frame file '{}' is empty (0 bytes). The extraction may have failed.",
                    path.display()
                ),
            )
            .retryable(true));
        }

        // Try to read JPEG dimensions from the file header
        let (width, height) = read_jpeg_dimensions(&path).unwrap_or((0, 0));

        frames.push(FrameEntry {
            filename: entry.file_name().to_string_lossy().to_string(),
            index: i as u32,
            width,
            height,
            size_bytes: size,
        });

        total_size += size;
    }

    // Warn if frame count deviates significantly from expected
    let expected = plan.target_frame_count;
    let actual = entries.len() as u32;
    let deviation = if expected > 0 {
        (actual as i64 - expected as i64).unsigned_abs()
    } else {
        0
    };

    if deviation > 10 && expected > 0 {
        tracing::warn!(
            "Frame count mismatch: expected ~{}, got {} (deviation: {})",
            expected,
            actual,
            deviation
        );
    }

    tracing::info!(
        "Frame validation complete: {} frames, {} total (expected ~{})",
        actual,
        format_size(total_size),
        expected
    );

    Ok(FrameManifest {
        schema_version: 1,
        total_frames: actual,
        source_metadata: metadata.clone(),
        extraction_plan: plan.clone(),
        frames,
        total_size_bytes: total_size,
    })
}

/// Read JPEG dimensions from the file header without decoding the full image.
///
/// Parses the SOF0 (Start of Frame) marker to extract width and height.
/// Returns `(0, 0)` if the dimensions cannot be determined.
fn read_jpeg_dimensions(path: &Path) -> Option<(u32, u32)> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 2 + 2 + 2 + 2 + 1 + 2 + 2]; // Minimal JPEG header

    file.read_exact(&mut buf).ok()?;

    // Check SOI marker
    if buf[0] != 0xFF || buf[1] != 0xD8 {
        return None;
    }

    // Scan for SOF0 marker (0xFF 0xC0) or SOF2 (0xFF 0xC2 for progressive)
    // We need to read more of the file to find the marker
    drop(file);

    let file = std::fs::File::open(path).ok()?;
    let mut full_buf = Vec::new();

    // Read first 64KB which should contain the SOF marker
    file.take(64 * 1024).read_to_end(&mut full_buf).ok()?;

    // Search for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
    for window in full_buf.windows(5) {
        if (window[0] == 0xFF && (window[1] == 0xC0 || window[1] == 0xC2))
            || (window[0] == 0xC0 && window[1] == 0xFF)
        {
            // Found SOF marker — extract dimensions
            // Layout after marker: 2 bytes length, 1 byte precision, 2 bytes height, 2 bytes width
            if window[0] == 0xFF {
                // Normal: FF C0
                let h = u16::from_be_bytes([window[3], window[4]]);
                if window.len() >= 7 {
                    let w = u16::from_be_bytes([window[5], window[6]]);
                    return Some((w as u32, h as u32));
                }
                return Some((0, h as u32));
            } else {
                // Reversed: C0 FF — search differently
                // This path is a fallback
                let idx = window.as_ptr() as usize - full_buf.as_ptr() as usize;
                if idx + 7 <= full_buf.len() {
                    let h = u16::from_be_bytes([full_buf[idx + 2], full_buf[idx + 3]]);
                    let w = u16::from_be_bytes([full_buf[idx + 4], full_buf[idx + 5]]);
                    return Some((w as u32, h as u32));
                }
            }
        }
    }

    // Fallback: couldn't find SOF marker
    None
}

/// Format bytes as a human-readable string.
fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    fn create_test_frame(dir: &Path, name: &str, size: usize) -> PathBuf {
        let path = dir.join(name);
        let _content = vec![0xFFu8; size]; // Fake JPEG (just FF bytes)
        if size > 0 {
            let mut file_content = vec![0xFF, 0xD8]; // SOI marker
            file_content.extend(std::iter::repeat_n(0xFFu8, size.saturating_sub(2)));
            let mut file = std::fs::File::create(&path).unwrap();
            file.write_all(&file_content).unwrap();
        } else {
            std::fs::File::create(&path).unwrap();
        }
        path
    }

    fn sample_plan() -> ExtractionPlan {
        ExtractionPlan {
            fps: 3.0,
            target_frame_count: 5,
            estimated_frame_count: 5,
            will_scale: false,
            rotation_correction: None,
            output_width: 1920,
            output_height: 1080,
            filter_graph: "fps=3".into(),
            estimated_bytes: 100_000,
            output_pattern: "%06d.jpg".into(),
        }
    }

    fn sample_metadata() -> VideoMetadata {
        VideoMetadata {
            width: 1920,
            height: 1080,
            fps: 30.0,
            frame_count: 150,
            duration_seconds: 5.0,
            codec: "h264".into(),
            rotation: None,
        }
    }

    #[test]
    fn test_validate_empty_directory() {
        let dir = std::env::temp_dir().join("splat-manifest-empty");
        let _ = std::fs::create_dir_all(&dir);

        let result = validate_frames(&dir, &sample_plan(), &sample_metadata());
        assert!(result.is_err());
        if let Err(e) = result {
            assert!(e.code.contains("1103"));
            assert!(e.title.contains("No Frames"));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_nonexistent_directory() {
        let result = validate_frames(
            Path::new("/nonexistent/manifest-test"),
            &sample_plan(),
            &sample_metadata(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_with_valid_frames() {
        let dir = std::env::temp_dir().join("splat-manifest-valid");
        let _ = std::fs::create_dir_all(&dir);

        // Create test frames
        create_test_frame(&dir, "000000.jpg", 10240);
        create_test_frame(&dir, "000001.jpg", 8192);
        create_test_frame(&dir, "000002.jpg", 12288);

        let result = validate_frames(&dir, &sample_plan(), &sample_metadata()).unwrap();
        assert_eq!(result.total_frames, 3);
        assert_eq!(result.frames.len(), 3);
        assert!(result.total_size_bytes > 0);

        // Verify ordering
        assert_eq!(result.frames[0].filename, "000000.jpg");
        assert_eq!(result.frames[1].filename, "000001.jpg");
        assert_eq!(result.frames[2].filename, "000002.jpg");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_ignores_non_jpg_files() {
        let dir = std::env::temp_dir().join("splat-manifest-mixed");
        let _ = std::fs::create_dir_all(&dir);

        create_test_frame(&dir, "000000.jpg", 100);
        create_test_frame(&dir, "000001.jpg", 200);
        // These should be ignored
        create_test_frame(&dir, "readme.txt", 50);
        create_test_frame(&dir, "thumbs.db", 1024);

        let result = validate_frames(&dir, &sample_plan(), &sample_metadata()).unwrap();
        assert_eq!(result.total_frames, 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_validate_detects_empty_file() {
        let dir = std::env::temp_dir().join("splat-manifest-empty-file");
        let _ = std::fs::create_dir_all(&dir);

        create_test_frame(&dir, "000000.jpg", 100);
        create_test_frame(&dir, "000001.jpg", 0); // Empty!

        let result = validate_frames(&dir, &sample_plan(), &sample_metadata());
        assert!(result.is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_manifest_serialization_roundtrip() {
        let manifest = FrameManifest {
            schema_version: 1,
            total_frames: 2,
            source_metadata: sample_metadata(),
            extraction_plan: sample_plan(),
            frames: vec![
                FrameEntry {
                    filename: "000000.jpg".into(),
                    index: 0,
                    width: 1920,
                    height: 1080,
                    size_bytes: 10240,
                },
                FrameEntry {
                    filename: "000001.jpg".into(),
                    index: 1,
                    width: 1920,
                    height: 1080,
                    size_bytes: 8192,
                },
            ],
            total_size_bytes: 18432,
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let deserialized: FrameManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.total_frames, 2);
        assert_eq!(deserialized.frames.len(), 2);
        assert_eq!(deserialized.total_size_bytes, 18432);
    }

    #[test]
    fn test_format_size() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(500), "500 B");
        assert_eq!(format_size(1536), "1.50 KB");
        assert_eq!(format_size(1_048_576), "1.00 MB");
        assert_eq!(format_size(1_073_741_824), "1.00 GB");
    }
}
