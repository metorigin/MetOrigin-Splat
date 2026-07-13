use crate::probe::VideoMetadata;

/// Frame extraction parameters from a training preset.
///
/// Maps to the `frameExtraction` section of preset JSON files.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrameExtractionPreset {
    /// Target frames per second to extract
    pub fps: f64,
    /// Maximum number of frames to extract
    #[serde(rename = "maxFrames")]
    pub max_frames: u32,
    /// Target long edge dimension in pixels
    #[serde(rename = "targetLongEdge")]
    pub target_long_edge: u32,
}

/// A training preset loaded from a JSON file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Preset {
    /// Preset identifier (e.g. "fast", "balanced", "quality")
    pub id: String,
    /// Human-readable name
    pub name: String,
    /// Description of when to use this preset
    pub description: Option<String>,
    /// Frame extraction parameters
    #[serde(rename = "frameExtraction")]
    pub frame_extraction: FrameExtractionPreset,
}

/// Computed frame extraction plan based on video metadata and user preset.
///
/// This struct contains the concrete parameters that will be passed to FFmpeg.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExtractionPlan {
    /// Output frames per second
    pub fps: f64,
    /// Target number of frames to extract
    pub target_frame_count: u32,
    /// Estimated number of frames based on duration × fps (before max cap)
    pub estimated_frame_count: u32,
    /// Whether the source is being scaled down
    pub will_scale: bool,
    /// Whether rotation correction is applied
    pub rotation_correction: Option<String>,
    /// Output image width (after scaling)
    pub output_width: u32,
    /// Output image height (after scaling)
    pub output_height: u32,
    /// Filter graph string for ffmpeg -vf
    pub filter_graph: String,
    /// Estimated disk space needed in bytes
    pub estimated_bytes: u64,
    /// Output filename pattern (e.g. "frames/%06d.jpg")
    pub output_pattern: String,
}

/// Compute the optimal extraction plan for a video and preset combination.
///
/// This function is pure computation — no I/O, no external calls. It takes
/// the video metadata and a preset, and returns the concrete parameters
/// that FFmpeg will use.
pub fn plan_extraction(metadata: &VideoMetadata, preset: &FrameExtractionPreset) -> ExtractionPlan {
    // 1. Determine extraction fps (cap at source fps)
    let extraction_fps = metadata.fps.min(preset.fps);

    // 2. Calculate estimated and target frame counts
    let estimated = if metadata.duration_seconds > 0.0 {
        (extraction_fps * metadata.duration_seconds).ceil() as u32
    } else if metadata.frame_count > 0 {
        metadata.frame_count as u32
    } else {
        preset.max_frames
    };
    let target = estimated.min(preset.max_frames);

    // 3. Determine output dimensions (scale down but never scale up)
    let (out_w, out_h, will_scale) =
        compute_output_dimensions(metadata.width, metadata.height, preset.target_long_edge);

    // 4. Handle rotation
    let transpose_filter = match metadata.rotation {
        Some(90) => Some("transpose=1"),              // 90° clockwise
        Some(270) => Some("transpose=2"),             // 90° counter-clockwise
        Some(180) => Some("transpose=2,transpose=2"), // 180°
        _ => None,
    };

    // 5. Build filter graph
    let mut filter_parts: Vec<String> = Vec::new();

    // Add rotation first if needed
    if let Some(t) = transpose_filter {
        filter_parts.push(t.to_string());
    }

    // Add fps filter if different from source
    if (extraction_fps - metadata.fps).abs() > 0.01 {
        filter_parts.push(format!("fps={}", extraction_fps));
    }

    // Add scale filter if needed
    if will_scale {
        filter_parts.push(format!(
            "scale='min({},iw)':min'({},ih)':force_original_aspect_ratio=decrease",
            out_w, out_h
        ));
    }

    let filter_graph = if filter_parts.is_empty() {
        String::new()
    } else {
        filter_parts.join(",")
    };

    // 6. Swap width/height if rotated 90° or 270° for display purposes
    let (display_w, display_h) = match metadata.rotation {
        Some(90) | Some(270) => (out_h, out_w),
        _ => (out_w, out_h),
    };

    // 7. Estimate disk space (rough: ~300KB per frame for 1920, scales with resolution)
    let pixel_ratio = (display_w * display_h) as f64 / (1920.0 * 1080.0);
    let avg_bytes_per_frame = (300.0 * 1024.0 * pixel_ratio.max(0.5)) as u64;
    let estimated_bytes = target as u64 * avg_bytes_per_frame;

    ExtractionPlan {
        fps: extraction_fps,
        target_frame_count: target,
        estimated_frame_count: estimated,
        will_scale,
        rotation_correction: transpose_filter.map(String::from),
        output_width: display_w,
        output_height: display_h,
        filter_graph,
        estimated_bytes,
        output_pattern: "%06d.jpg".into(),
    }
}

/// Compute scaled output dimensions based on a target long edge length.
///
/// Never scales up: if the source is smaller than the target, keeps original size.
fn compute_output_dimensions(width: u32, height: u32, target_long_edge: u32) -> (u32, u32, bool) {
    if width == 0 || height == 0 {
        return (width, height, false);
    }

    let long_edge = width.max(height);
    if long_edge <= target_long_edge {
        // Source is already small enough — no scaling needed
        return (width, height, false);
    }

    let ratio = target_long_edge as f64 / long_edge as f64;
    let new_w = (width as f64 * ratio).round() as u32;
    let new_h = (height as f64 * ratio).round() as u32;

    // Ensure minimum dimensions
    let new_w = new_w.max(64);
    let new_h = new_h.max(64);

    (new_w, new_h, true)
}

/// Parse a preset from a JSON file path.
pub fn load_preset(path: &std::path::Path) -> Result<Preset, Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(path)?;
    let preset: Preset = serde_json::from_str(&content)?;
    Ok(preset)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_metadata(
        width: u32,
        height: u32,
        fps: f64,
        frame_count: u64,
        duration: f64,
        rotation: Option<i32>,
    ) -> VideoMetadata {
        VideoMetadata {
            width,
            height,
            fps,
            frame_count,
            duration_seconds: duration,
            codec: "h264".into(),
            rotation,
        }
    }

    fn balanced_preset() -> FrameExtractionPreset {
        FrameExtractionPreset {
            fps: 3.0,
            max_frames: 800,
            target_long_edge: 1920,
        }
    }

    fn fast_preset() -> FrameExtractionPreset {
        FrameExtractionPreset {
            fps: 2.0,
            max_frames: 300,
            target_long_edge: 1280,
        }
    }

    // ─── FPS & frame count ─────────────────────────────────────────────

    #[test]
    fn test_fps_clamped_to_source() {
        // Source is 24 fps, preset asks 3 → should use 3
        let meta = make_metadata(1920, 1080, 24.0, 0, 100.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!((plan.fps - 3.0).abs() < 0.001);
    }

    #[test]
    fn test_fps_capped_at_source() {
        // Source is 2 fps, preset asks 3 → should cap at 2
        let meta = make_metadata(1920, 1080, 2.0, 0, 100.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!((plan.fps - 2.0).abs() < 0.001);
    }

    #[test]
    fn test_target_frame_count_capped_by_max() {
        // duration * fps = 3000, but max is 800 → target = 800
        let meta = make_metadata(1920, 1080, 3.0, 0, 1000.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert_eq!(plan.target_frame_count, 800);
    }

    #[test]
    fn test_target_frame_count_within_limit() {
        // duration * fps = 150, max is 800 → target = 150
        let meta = make_metadata(1920, 1080, 3.0, 0, 50.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert_eq!(plan.target_frame_count, 150);
    }

    #[test]
    fn test_estimated_via_frame_count_when_no_duration() {
        // No duration but has frame_count, preset max is 300
        let meta = make_metadata(1920, 1080, 3.0, 100, 0.0, None);
        let plan = plan_extraction(&meta, &fast_preset());
        assert_eq!(plan.target_frame_count, 100);
    }

    #[test]
    fn test_estimated_fallback_when_no_metrics() {
        let meta = make_metadata(1920, 1080, 0.0, 0, 0.0, None);
        let plan = plan_extraction(&meta, &fast_preset());
        assert_eq!(plan.target_frame_count, 300);
    }

    // ─── Scaling ───────────────────────────────────────────────────────

    #[test]
    fn test_scales_down_4k() {
        let meta = make_metadata(3840, 2160, 24.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.will_scale);
        assert!(plan.output_width <= 1920);
        assert!(plan.output_height <= 1080);
    }

    #[test]
    fn test_no_scale_up() {
        let meta = make_metadata(640, 480, 24.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(!plan.will_scale);
        assert_eq!(plan.output_width, 640);
        assert_eq!(plan.output_height, 480);
    }

    #[test]
    fn test_scales_1080p_to_720p_with_fast_preset() {
        let meta = make_metadata(1920, 1080, 30.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &fast_preset());
        assert!(plan.will_scale);
        assert_eq!(plan.output_width, 1280);
        assert_eq!(plan.output_height, 720);
    }

    // ─── Rotation ──────────────────────────────────────────────────────

    #[test]
    fn test_rotation_90_swaps_dimensions() {
        let meta = make_metadata(1080, 1920, 30.0, 0, 60.0, Some(90));
        let plan = plan_extraction(&meta, &balanced_preset());
        assert_eq!(plan.rotation_correction, Some("transpose=1".into()));
        assert_eq!(plan.output_width, 1920);
        assert_eq!(plan.output_height, 1080);
    }

    #[test]
    fn test_rotation_270() {
        let meta = make_metadata(1080, 1920, 30.0, 0, 60.0, Some(270));
        let plan = plan_extraction(&meta, &balanced_preset());
        assert_eq!(plan.rotation_correction, Some("transpose=2".into()));
    }

    #[test]
    fn test_rotation_180() {
        let meta = make_metadata(1920, 1080, 30.0, 0, 60.0, Some(180));
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.rotation_correction.is_some());
    }

    #[test]
    fn test_no_rotation() {
        let meta = make_metadata(1920, 1080, 30.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.rotation_correction.is_none());
    }

    // ─── Filter graph ──────────────────────────────────────────────────

    #[test]
    fn test_filter_graph_with_fps_only() {
        // Source 60fps, preset 3fps, no scale needed (source <= target)
        let meta = make_metadata(1280, 720, 60.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.filter_graph.contains("fps=3"));
        assert!(!plan.filter_graph.contains("scale"));
    }

    #[test]
    fn test_filter_graph_with_scale_only() {
        // Source 3840x2160, same fps as preset
        let meta = make_metadata(3840, 2160, 3.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(!plan.filter_graph.contains("fps"));
        assert!(plan.filter_graph.contains("scale"));
    }

    #[test]
    fn test_filter_graph_empty_when_no_processing_needed() {
        // Source already matches preset exactly
        let meta = make_metadata(1920, 1080, 3.0, 0, 60.0, None);
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.filter_graph.is_empty());
    }

    #[test]
    fn test_filter_graph_with_rotation_plus_scale() {
        let meta = make_metadata(3840, 2160, 3.0, 0, 60.0, Some(90));
        let plan = plan_extraction(&meta, &balanced_preset());
        assert!(plan.filter_graph.contains("transpose=1"));
        assert!(plan.filter_graph.contains("scale"));
    }

    // ─── Disk estimate ────────────────────────────────────────────────

    #[test]
    fn test_estimated_bytes_positive() {
        let meta = make_metadata(1920, 1080, 30.0, 0, 100.0, None);
        let plan = plan_extraction(&meta, &fast_preset());
        assert!(plan.estimated_bytes > 0);
        assert!(plan.estimated_bytes < 1_000_000_000); // sanity check
    }
}
