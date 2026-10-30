//! Opt-in comparison against FFmpeg's own display-matrix autorotation.
//! Uses an existing real recording without changing its bytes or metadata.

use std::path::{Path, PathBuf};

use splat_engine_ffmpeg::{plan_extraction, probe_video_with, FrameExtractionPreset};
use splat_process::background_command;

#[test]
#[ignore = "requires METORIGIN_TEST_VIDEO and local METORIGIN_TEST_FFMPEG/FFPROBE paths"]
fn explicit_display_rotation_matches_ffmpeg_autorotate_pixels() {
    let video = required_path("METORIGIN_TEST_VIDEO");
    let ffmpeg = required_path("METORIGIN_TEST_FFMPEG");
    let ffprobe = required_path("METORIGIN_TEST_FFPROBE");
    let original = probe_video_with(&ffprobe, &video).unwrap();
    assert!(original.duration_seconds > 2.0);
    let preset = FrameExtractionPreset {
        fps: original.fps,
        max_frames: 1,
        target_long_edge: 1024,
        colmap_long_edge: 1024,
    };

    for override_angle in [
        None,
        Some(-90),
        Some(90),
        Some(270),
        Some(-180),
        Some(180),
        Some(450),
        Some(-450),
        Some(0),
        Some(360),
        Some(-360),
    ] {
        let mut metadata = original.clone();
        if let Some(angle) = override_angle {
            metadata.rotation = Some(angle);
        }
        let plan = plan_extraction(&metadata, &preset);
        // This square bound lets FFmpeg independently derive the dimensions
        // after its own autorotation, instead of trusting the application plan.
        let reference = render_frame(
            &ffmpeg,
            &video,
            override_angle,
            None,
            "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease",
        );
        let explicit = render_frame(
            &ffmpeg,
            &video,
            override_angle,
            Some("-noautorotate"),
            &plan.filter_graph,
        );
        println!(
            "ROTATION_EVIDENCE {}",
            serde_json::json!({
                "override_angle": override_angle, "source_rotation": original.rotation,
                "plan": plan, "reference": reference, "explicit": explicit,
            })
        );
        assert_eq!(explicit, reference, "display rotation {override_angle:?}");
        assert_eq!(
            explicit.0,
            format!("{}x{}", plan.output_width, plan.output_height),
            "plan dimensions for {override_angle:?}"
        );
    }
}

fn render_frame(
    ffmpeg: &Path,
    video: &Path,
    rotation: Option<i32>,
    autorotate_override: Option<&str>,
    filter: &str,
) -> (String, Vec<String>) {
    let mut command = background_command(ffmpeg);
    command.args(["-v", "error", "-nostdin", "-threads", "1", "-ss", "2"]);
    if let Some(rotation) = rotation {
        command.arg("-display_rotation").arg(rotation.to_string());
    }
    if let Some(option) = autorotate_override {
        command.arg(option);
    }
    let output = command
        .arg("-i")
        .arg(video)
        .args([
            "-vf",
            filter,
            "-frames:v",
            "1",
            "-pix_fmt",
            "rgb24",
            "-f",
            "framemd5",
            "-",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "FFmpeg: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let dimensions = text
        .lines()
        .find_map(|line| line.strip_prefix("#dimensions 0: "))
        .expect("framemd5 dimensions")
        .to_owned();
    let frames: Vec<String> = text
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.to_owned())
        .collect();
    assert_eq!(frames.len(), 1);
    (dimensions, frames)
}

fn required_path(name: &str) -> PathBuf {
    let path =
        PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("{name} is required")));
    assert!(path.is_file(), "{name}: {}", path.display());
    path
}
