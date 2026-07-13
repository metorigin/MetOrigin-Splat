use splat_domain::progress::TaskProgress;
use splat_process::ProgressParser;

/// Parses FFmpeg's frame-level progress output from stdout/stderr.
///
/// FFmpeg outputs lines like the following during frame extraction:
/// ```text
/// frame=  123 fps= 12 q=28.0 size=    1024kB time=00:00:04.10 bitrate=2045.0kbits/s speed=0.987x
/// ```
///
/// This parser extracts the current frame number and computes progress
/// as a fraction of the total expected frames.
pub struct FfmpegFrameParser {
    stage_id: String,
    total_frames: u64,
}

impl FfmpegFrameParser {
    /// Create a new FFmpeg frame parser.
    ///
    /// * `stage_id` — The pipeline stage ID for progress events
    /// * `total_frames` — Total number of frames expected (0 if unknown)
    pub fn new(stage_id: impl Into<String>, total_frames: u64) -> Self {
        Self {
            stage_id: stage_id.into(),
            total_frames,
        }
    }
}

impl ProgressParser for FfmpegFrameParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        // FFmpeg progress lines always start with "frame=" at the beginning
        // (after optional whitespace). Skip non-progress lines quickly.
        let trimmed = line.trim_start();
        if !trimmed.starts_with("frame=") {
            return None;
        }

        // Extract the frame number after "frame="
        // Pattern: "frame=N" where N may have leading spaces
        let rest = trimmed.trim_start_matches("frame=");
        let frame_str = rest.split_whitespace().next()?;
        let current: u64 = frame_str.parse().ok()?;

        if current == 0 {
            return None;
        }

        let percent = if self.total_frames > 0 {
            (current as f64).min(self.total_frames as f64) / self.total_frames as f64
        } else {
            0.0
        };

        let message = if self.total_frames > 0 {
            format!("Extracting frame {} of {}", current, self.total_frames)
        } else {
            format!("Extracting frame {}", current)
        };

        Some(
            TaskProgress::new(&self.stage_id, message)
                .with_percent(percent)
                .with_items(current, self.total_frames),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> FfmpegFrameParser {
        FfmpegFrameParser::new("frame_extraction", 800)
    }

    #[test]
    fn test_parses_frame_number() {
        let p = parser();
        let result = p.parse_line("frame=  123 fps= 12 q=28.0 size=    1024kB time=00:00:04.10 bitrate=2045.0kbits/s speed=0.987x");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert_eq!(progress.current_item, 123);
        assert_eq!(progress.total_items, 800);
    }

    #[test]
    fn test_computes_percent() {
        let p = parser();
        let result = p.parse_line("frame=  400 fps= 12 q=28.0");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert!((progress.percent - 0.5).abs() < 0.001);
    }

    #[test]
    fn test_handles_large_frame_number() {
        let p = parser();
        let result = p.parse_line("frame= 12345 fps= 30 q=1.0 size=   50000kB");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert_eq!(progress.current_item, 12345);
        // Cap at 100% if over total
        assert!(progress.percent <= 1.0);
    }

    #[test]
    fn test_skips_non_progress_lines() {
        let p = parser();
        assert!(p.parse_line("ffmpeg version 7.0.2 Copyright ...").is_none());
        assert!(p.parse_line("").is_none());
        assert!(p.parse_line("  ").is_none());
    }

    #[test]
    fn test_skips_header_lines() {
        let p = parser();
        assert!(p
            .parse_line("Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':")
            .is_none());
        assert!(p.parse_line("Stream #0:0[0x1](und): Video: h264 (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080").is_none());
    }

    #[test]
    fn test_skips_final_line() {
        let p = parser();
        assert!(p.parse_line("video:1024kB audio:128kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.5%").is_none());
    }

    #[test]
    fn test_unknown_total_frames() {
        let p = FfmpegFrameParser::new("frame_extraction", 0);
        let result = p.parse_line("frame=   50 fps= 12");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert!((progress.percent - 0.0).abs() < 0.001);
        assert_eq!(progress.total_items, 0);
        assert_eq!(progress.current_item, 50);
    }

    #[test]
    fn test_zero_frame_returns_none() {
        let p = parser();
        // FFmpeg outputs "frame=    0" briefly at start, skip it
        assert!(p.parse_line("frame=    0 fps=  0").is_none());
    }

    #[test]
    fn test_handles_frame_equals_with_spaces() {
        // Different padding variations
        let p = parser();
        let r1 = p.parse_line("frame=    1 fps=0.0").unwrap();
        let r2 = p.parse_line("frame=   10 fps=0.0").unwrap();
        let r3 = p.parse_line("frame=  100 fps=0.0").unwrap();
        assert_eq!(r1.current_item, 1);
        assert_eq!(r2.current_item, 10);
        assert_eq!(r3.current_item, 100);
    }

    #[test]
    fn test_implements_progress_parser_trait() {
        let p: Box<dyn ProgressParser> = Box::new(FfmpegFrameParser::new("test", 100));
        let result = p.parse_line("frame=   50 fps= 12");
        assert!(result.is_some());
    }
}
