use splat_domain::progress::TaskProgress;
use splat_process::ProgressParser;

/// Parses COLMAP feature extraction and matching progress output.
///
/// Supports the legacy Windows output and COLMAP 4.1's glog messages:
/// ```text
/// I20240712 12:00:00.123456  5678 feature_extractor.cc:200] [0.123s] Extracting features: [50/100]
/// I20240712 12:01:00.789012  5678 sequential_matcher.cc:150] [0.456s] Matching images: [30/100]
/// I20261027 15:34:17.831679 0x16db47000 feature_extraction.cc:270] Processed file [311/311]
/// I20261027 15:34:18.603133 0x16d927000 pairing.cc:213] Processing block [1/7, 1/7]
/// I20261027 15:34:18.603133 0x16d927000 pairing.cc:485] Processing image [1/311]
/// ```
///
/// Matching messages announce the next batch before it runs. Report only the
/// preceding completed batches, in their actual units, and leave final completion
/// to the successful pipeline stage. Batch progress is not an image-pair count.
/// The 4.1 semantics below were checked against pinned upstream commit
/// `fa8e3b3ff591552855f8ad2806723c80f963f69c` (controllers/pairing.cc and
/// controllers/feature_matching.cc), matching the packaged source identity.
pub struct ColmapFeatureParser {
    stage_id: String,
    total_images: u64,
}

impl ColmapFeatureParser {
    /// Create a new COLMAP progress parser for feature extraction.
    ///
    /// * `stage_id` — Pipeline stage ID for progress events
    /// * `total_images` — Total number of images to process (0 if unknown)
    pub fn new(stage_id: impl Into<String>, total_images: u64) -> Self {
        Self {
            stage_id: stage_id.into(),
            total_images,
        }
    }

    /// Extract the `[current/total]` pattern from a line.
    /// Looks for the LAST bracket pair in the line.
    fn extract_brackets(line: &str) -> Option<(u64, u64)> {
        // Find last '[' and matching ']'
        let open_bracket = line.rfind('[')?;
        let close_bracket = line[open_bracket..].find(']')?;
        let content = &line[open_bracket + 1..open_bracket + close_bracket];

        // Content should be "current/total"
        let slash_pos = content.find('/')?;
        let current: u64 = content[..slash_pos].trim().parse().ok()?;
        let total: u64 = content[slash_pos + 1..].trim().parse().ok()?;

        Some((current, total))
    }

    fn parse_exhaustive_block(&self, line: &str) -> Option<TaskProgress> {
        let content = line.split_once("Processing block [")?.1.split_once(']')?.0;
        let (row, column) = content.split_once(',')?;
        let parse_axis = |axis: &str| -> Option<(u64, u64)> {
            let (current, total) = axis.trim().split_once('/')?;
            Some((current.trim().parse().ok()?, total.trim().parse().ok()?))
        };
        let (row, rows) = parse_axis(row)?;
        let (column, columns) = parse_axis(column)?;
        if rows == 0 || rows != columns || row == 0 || row > rows || column == 0 || column > columns
        {
            return None;
        }

        // Pinned COLMAP fa8e3b3: controllers/pairing.cc:202-234 traverses the
        // full square grid row-major, including both halves (not a triangle).
        // controllers/feature_matching.cc:214-217 calls Next() before Match(),
        // so this log announces a block that has not completed yet.
        let total = rows.checked_mul(columns)?;
        let completed = (row - 1).checked_mul(columns)?.checked_add(column - 1)?;
        Some(
            TaskProgress::new(
                &self.stage_id,
                format!(
                    "Matching blocks: {completed}/{total} completed; processing block [{row}/{rows}, {column}/{columns}]"
                ),
            )
            .with_percent(Self::incomplete_fraction(completed, total))
            .with_items(completed, total),
        )
    }

    fn parse_sequential_image(&self, line: &str) -> Option<TaskProgress> {
        let (current, total) = Self::extract_brackets(line)?;
        if total == 0 || current == 0 || current > total {
            return None;
        }
        // Pinned COLMAP fa8e3b3, controllers/pairing.cc:477-486: each image
        // announces a matching batch before its pairs are generated/matched.
        let completed = current - 1;
        Some(
            TaskProgress::new(
                &self.stage_id,
                format!(
                    "Matching image batches: {completed}/{total} completed; processing image {current}/{total}"
                ),
            )
            .with_percent(Self::incomplete_fraction(completed, total))
            .with_items(completed, total),
        )
    }

    fn incomplete_fraction(completed: u64, total: u64) -> f64 {
        // Large integer counts can round to the same f64. A batch-start log must
        // still never claim that the whole stage has completed.
        (completed as f64 / total as f64).min(1.0 - f64::EPSILON)
    }
}

impl ProgressParser for ColmapFeatureParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        if line.contains("Processing block") {
            return self.parse_exhaustive_block(line);
        }
        if line.contains("Processing image") {
            return self.parse_sequential_image(line);
        }
        let processed_file = line.contains("Processed file");
        if !processed_file
            && !line.contains("Extracting features")
            && !line.contains("Matching images")
        {
            return None;
        }

        // Extract [current/total] from the line
        let (current, total) = Self::extract_brackets(line)?;

        if total == 0 || (processed_file && (current == 0 || current > total)) {
            return None;
        }

        let percent = (current as f64).min(total as f64) / total as f64;

        let message = if processed_file {
            format!("Processed files: {}/{}", current, total)
        } else if line.contains("Extracting features") {
            format!("Extracting features: {}/{}", current, total)
        } else {
            format!("Matching images: {}/{}", current, total)
        };

        Some(
            TaskProgress::new(&self.stage_id, message)
                .with_percent(percent)
                .with_items(
                    current,
                    if processed_file {
                        total
                    } else {
                        self.total_images.max(total)
                    },
                ),
        )
    }
}

/// Parses COLMAP `mapper` progress output.
///
/// The mapper has a different progress style — it outputs registration
/// progress as images are added:
/// ```text
/// I20240712 12:00:00.123456  5678 mapper.cc:300] [0.123s] Registering image [50/100]
/// I20261027 15:34:18.603133 0x16d927000 incremental_pipeline.cc:537] Registering image #72 (num_reg_frames=25)
/// ```
/// COLMAP's count-only fields describe the current model before the next
/// registration attempt. They carry no total or overall completion fraction.
/// Global Mapper phase headings and BA sub-iterations remain indeterminate.
pub struct ColmapMapperParser {
    stage_id: String,
}

impl ColmapMapperParser {
    pub fn new(stage_id: impl Into<String>) -> Self {
        Self {
            stage_id: stage_id.into(),
        }
    }

    fn parse_registered_count(&self, line: &str) -> Option<TaskProgress> {
        if !line.contains("Registering image #") {
            return None;
        }
        let frames = line.contains("(num_reg_frames=");
        let images = line.contains("(num_reg_images=");
        let (marker, unit) = match (frames, images) {
            (true, false) => ("(num_reg_frames=", "frames"),
            (false, true) => ("(num_reg_images=", "images"),
            _ => return None,
        };
        let value = line.split_once(marker)?.1.split_once(')')?.0.trim();
        let registered: u64 = value.parse().ok()?;

        // COLMAP fa8e3b3, incremental_pipeline.cc:537-557 logs NumRegFrames()
        // before RegisterNextImage. reconstruction.h:323 counts registered
        // frame IDs. feature_extraction.cc:326-329 creates one frame per image;
        // our camera consolidation preserves those frame/data assignments.
        // Never use the candidate image ID, add one for an unproven success, or
        // accumulate across retries/submodels. No total is present in this log.
        Some(
            TaskProgress::new(
                &self.stage_id,
                format!(
                    "Current model: {registered} registered {unit}; attempting next image (overall progress unknown)"
                ),
            )
            .with_items(registered, 0),
        )
    }
}

impl ProgressParser for ColmapMapperParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        if line.contains("num_reg_frames=") || line.contains("num_reg_images=") {
            return self.parse_registered_count(line);
        }
        if !line.contains("Registering image") && !line.contains("Reconstructing") {
            return None;
        }

        let (current, total) = ColmapFeatureParser::extract_brackets(line)?;

        if total == 0 {
            return None;
        }

        let percent = (current as f64).min(total as f64) / total as f64;

        Some(
            TaskProgress::new(
                &self.stage_id,
                format!("Reconstruction: {}/{}", current, total),
            )
            .with_percent(percent)
            .with_items(current, total),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── extract_brackets ──────────────────────────────────────────────

    #[test]
    fn test_extract_brackets_basic() {
        let result = ColmapFeatureParser::extract_brackets(
            "I20240712 12:00:00.123456  5678 feature_extractor.cc:200] [0.123s] Extracting features: [50/100]"
        );
        assert_eq!(result, Some((50, 100)));
    }

    #[test]
    fn test_extract_brackets_single_digit() {
        let result = ColmapFeatureParser::extract_brackets("[5/10]");
        assert_eq!(result, Some((5, 10)));
    }

    #[test]
    fn test_extract_brackets_large_numbers() {
        let result = ColmapFeatureParser::extract_brackets("[12345/99999]");
        assert_eq!(result, Some((12345, 99999)));
    }

    #[test]
    fn test_extract_brackets_no_match() {
        assert!(ColmapFeatureParser::extract_brackets("No brackets here").is_none());
        assert!(ColmapFeatureParser::extract_brackets("").is_none());
        assert!(ColmapFeatureParser::extract_brackets("[no numbers]").is_none());
    }

    #[test]
    fn test_extract_brackets_uses_last_pair() {
        let result = ColmapFeatureParser::extract_brackets("some [1/2] text [3/4]");
        assert_eq!(result, Some((3, 4)));
    }

    // ─── ColmapFeatureParser ───────────────────────────────────────────

    #[test]
    fn test_parses_feature_extraction_progress() {
        let parser = ColmapFeatureParser::new("feature_extraction", 100);
        let result = parser.parse_line(
            "I20240712 12:00:00.123456  5678 feature_extractor.cc:200] [0.123s] Extracting features: [50/100]"
        );
        assert!(result.is_some());
        let p = result.unwrap();
        assert_eq!(p.current_item, 50);
        assert!((p.percent - 0.5).abs() < 0.001);
        assert!(p.message.contains("Extracting features"));
    }

    #[test]
    fn test_parses_matching_progress() {
        let parser = ColmapFeatureParser::new("matching", 100);
        let result = parser.parse_line(
            "I20240712 12:01:00.789012  5678 sequential_matcher.cc:150] [0.456s] Matching images: [30/100]"
        );
        assert!(result.is_some());
        let p = result.unwrap();
        assert_eq!(p.current_item, 30);
        assert!((p.percent - 0.3).abs() < 0.001);
        assert!(p.message.contains("Matching images"));
    }

    #[test]
    fn test_parses_colmap_4_1_processed_file_log() {
        // Captured from the 2026-10-27 311-image native run of app 8656d4e0,
        // logs/colmap_feature_extraction.log, using the frozen 4.1 engine.
        let parser = ColmapFeatureParser::new("ColmapFeatureExtraction", 311);
        let progress = parser
            .parse_line("I20261027 15:34:11.746418 0x16db47000 feature_extraction.cc:270] Processed file [306/311]")
            .unwrap();
        assert_eq!(progress.stage_id, "ColmapFeatureExtraction");
        assert_eq!((progress.current_item, progress.total_items), (306, 311));
        assert!((progress.percent - 306.0 / 311.0).abs() < 1e-12);
        assert_eq!(progress.message, "Processed files: 306/311");

        let complete = parser.parse_line("Processed file [311/311]").unwrap();
        assert_eq!(complete.percent, 1.0);
        let unknown_total = ColmapFeatureParser::new("feature", 0)
            .parse_line("Processed file [1/311]")
            .unwrap();
        assert_eq!(
            (unknown_total.current_item, unknown_total.total_items),
            (1, 311)
        );
    }

    #[test]
    fn test_exhaustive_blocks_follow_full_row_major_grid_before_matching() {
        let parser = ColmapFeatureParser::new("ColmapMatching", 311);
        // Pinned pairing.cc advances column first across all 7*7 blocks, not
        // just the triangular half. Each message precedes work on that block.
        for row in 1..=7 {
            for column in 1..=7 {
                let line = format!(
                    "I20261027 15:34:18.603133 0x16d927000 pairing.cc:213] Processing block [{row}/7, {column}/7]"
                );
                let progress = parser.parse_line(&line).unwrap();
                let completed = (row - 1) * 7 + column - 1;
                assert_eq!(progress.stage_id, "ColmapMatching");
                assert_eq!(
                    (progress.current_item, progress.total_items),
                    (completed, 49)
                );
                assert!((progress.percent - completed as f64 / 49.0).abs() < 1e-12);
                assert!(progress.percent < 1.0);
                assert!(progress.message.contains("Matching blocks:"));
                assert!(!progress.message.contains("images"));
                assert!(!progress.message.contains("pairs"));
            }
        }
    }

    #[test]
    fn test_one_exhaustive_block_does_not_finish_at_start() {
        let progress = ColmapFeatureParser::new("matching", 31)
            .parse_line("Processing block [1/1, 1/1]")
            .unwrap();
        assert_eq!((progress.current_item, progress.total_items), (0, 1));
        assert_eq!(progress.percent, 0.0);
    }

    #[test]
    fn test_sequential_image_batches_report_only_preceding_completed_batches() {
        let parser = ColmapFeatureParser::new("ColmapMatching", 311);
        for current in [1, 156, 311] {
            let line = format!(
                "I20261027 15:34:18.603133 0x16d927000 pairing.cc:485] Processing image [{current}/311]"
            );
            let progress = parser.parse_line(&line).unwrap();
            assert_eq!(
                (progress.current_item, progress.total_items),
                (current - 1, 311)
            );
            assert!((progress.percent - (current - 1) as f64 / 311.0).abs() < 1e-12);
            assert!(progress.percent < 1.0);
            assert!(progress.message.contains("Matching image batches:"));
            assert!(!progress.message.contains("pairs"));
        }
    }

    #[test]
    fn test_colmap_4_1_rejects_invalid_counts_and_block_overflow() {
        let parser = ColmapFeatureParser::new("test", 311);
        for line in [
            "Processed file [0/0]",
            "Processed file [0/311]",
            "Processed file [312/311]",
            "Processed file [-1/311]",
            "Processing image [0/311]",
            "Processing image [312/311]",
            "Processing image [1/0]",
            "Processing image [18446744073709551616/311]",
            "Processing block [1/0, 1/0]",
            "Processing block [0/7, 1/7]",
            "Processing block [1/7, 0/7]",
            "Processing block [8/7, 1/7]",
            "Processing block [1/7, 8/7]",
            "Processing block [1/7, 1/8]",
            "Processing block [1/7]",
            "Processing block [1/7, 1/7, 1/7]",
            "Processing block [1/7, -1/7]",
            "Processing block [1/4294967296, 1/4294967296]",
            "Processing block [1/18446744073709551616, 1/18446744073709551616]",
        ] {
            assert!(parser.parse_line(line).is_none(), "accepted {line}");
        }
    }

    #[test]
    fn test_large_batch_counts_cannot_round_start_of_last_batch_to_complete() {
        let parser = ColmapFeatureParser::new("matching", 0);
        for line in [
            "Processing image [18446744073709551615/18446744073709551615]",
            "Processing block [4294967295/4294967295, 4294967295/4294967295]",
        ] {
            let progress = parser.parse_line(line).unwrap();
            assert_eq!(progress.current_item + 1, progress.total_items);
            assert!(progress.percent < 1.0);
            assert!(progress.percent > 0.99);
        }
    }

    #[test]
    fn test_skips_warning_lines() {
        let parser = ColmapFeatureParser::new("feature_extraction", 100);
        assert!(parser.parse_line("W20240712 12:00:00.123  5678 feature_extractor.cc:200] Low contrast in image 5.jpg").is_none());
    }

    #[test]
    fn test_skips_irrelevant_lines() {
        let parser = ColmapFeatureParser::new("feature_extraction", 100);
        assert!(parser.parse_line("").is_none());
        assert!(parser.parse_line("Loading database").is_none());
        assert!(parser
            .parse_line("I20240712 12:00:00.123  5678 database_creator.cc:100] Creating database")
            .is_none());
    }

    #[test]
    fn test_zero_brackets() {
        let parser = ColmapFeatureParser::new("feature_extraction", 100);
        let result = parser.parse_line("Extracting features: [0/100]");
        assert!(result.is_some());
        assert!((result.unwrap().percent - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_completion() {
        let parser = ColmapFeatureParser::new("feature_extraction", 100);
        let result = parser.parse_line("Extracting features: [100/100]");
        assert!(result.is_some());
        assert!((result.unwrap().percent - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_zero_denominator_safe() {
        let parser = ColmapFeatureParser::new("feature_extraction", 0);
        let result = parser.parse_line("Extracting features: [0/0]");
        assert!(result.is_none());
    }

    #[test]
    fn test_implements_trait() {
        let parser: Box<dyn ProgressParser> = Box::new(ColmapFeatureParser::new("test", 100));
        let result = parser.parse_line("Extracting features: [50/100]");
        assert!(result.is_some());
    }

    // ─── ColmapMapperParser ────────────────────────────────────────────

    #[test]
    fn test_mapper_parser_registering() {
        let parser = ColmapMapperParser::new("mapping");
        let result = parser.parse_line(
            "I20240712 12:00:00.123  5678 mapper.cc:300] [0.123s] Registering image [25/80]",
        );
        assert!(result.is_some());
        let p = result.unwrap();
        assert_eq!(p.current_item, 25);
        assert_eq!(p.total_items, 80);
    }

    #[test]
    fn test_mapper_registered_frames_are_current_count_before_attempt_not_image_id() {
        let progress = ColmapMapperParser::new("ColmapMapping")
            .parse_line("I20261027 15:34:18.603133 0x16d927000 incremental_pipeline.cc:537] Registering image #9999 (num_reg_frames=25)")
            .unwrap();
        assert_eq!(progress.stage_id, "ColmapMapping");
        assert_eq!((progress.current_item, progress.total_items), (25, 0));
        assert_eq!(progress.percent, 0.0);
        assert!(progress.message.contains("25 registered frames"));
        assert!(progress.message.contains("overall progress unknown"));
        assert!(!progress.message.contains("9999"));
    }

    #[test]
    fn test_mapper_retains_legacy_registered_image_count_format() {
        let progress = ColmapMapperParser::new("mapping")
            .parse_line("Registering image #900 (num_reg_images=12)")
            .unwrap();
        assert_eq!((progress.current_item, progress.total_items), (12, 0));
        assert_eq!(progress.percent, 0.0);
        assert!(progress.message.contains("12 registered images"));
    }

    #[test]
    fn test_mapper_count_retries_and_new_submodels_do_not_invent_registered_frames() {
        let parser = ColmapMapperParser::new("mapping");
        for (candidate, registered) in [(100, 8), (200, 8), (300, 2), (400, 0)] {
            let progress = parser
                .parse_line(&format!(
                    "Registering image #{candidate} (num_reg_frames={registered})"
                ))
                .unwrap();
            assert_eq!(progress.current_item, registered);
            assert_eq!(progress.total_items, 0);
            assert_eq!(progress.percent, 0.0);
        }
    }

    #[test]
    fn test_mapper_rejects_invalid_or_ambiguous_registered_counts() {
        let parser = ColmapMapperParser::new("mapping");
        for line in [
            "Registering image #72 (num_reg_frames=-1)",
            "Registering image #72 (num_reg_frames=1.5)",
            "Registering image #72 (num_reg_frames=18446744073709551616)",
            "Registering image #72 (num_reg_frames=)",
            "Registering image #72 (num_reg_frames=25",
            "Registering image #72 (num_reg_images=12 frames)",
            "Registering image #72 (num_reg_frames=25) (num_reg_images=26)",
            "Unrelated diagnostic (num_reg_frames=25)",
        ] {
            assert!(parser.parse_line(line).is_none(), "accepted {line}");
        }
    }

    #[test]
    fn test_global_mapper_phases_and_ba_iterations_do_not_claim_overall_progress() {
        let parser = ColmapMapperParser::new("mapping");
        // Pinned global_mapper.cc:352, 362, 511 and global_pipeline.cc:110, 122.
        for line in [
            "=== Running global positioning ===",
            "Global bundle adjustment iteration 1 / 3, fixed-rotation stage finished",
            "Global bundle adjustment iteration 3 / 3 finished",
            "Reconstruction done in 24.8 seconds",
            "Extracting colors ...",
        ] {
            assert!(parser.parse_line(line).is_none(), "accepted {line}");
        }
    }

    #[test]
    fn test_mapper_parser_skips_non_mapping() {
        let parser = ColmapMapperParser::new("mapping");
        assert!(parser
            .parse_line("I20240712 12:00:00.123  5678 mapper.cc:100] Loading model")
            .is_none());
    }
}
