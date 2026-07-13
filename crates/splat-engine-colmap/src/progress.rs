use splat_domain::progress::TaskProgress;
use splat_process::ProgressParser;

/// Parses COLMAP `feature_extractor` and `sequential_matcher` progress output.
///
/// COLMAP uses Google Log (glog) format. Progress lines look like:
/// ```text
/// I20240712 12:00:00.123456  5678 feature_extractor.cc:200] [0.123s] Extracting features: [50/100]
/// I20240712 12:01:00.789012  5678 sequential_matcher.cc:150] [0.456s] Matching images: [30/100]
/// ```
///
/// This parser:
/// 1. Filters for lines containing the expected operation name
/// 2. Extracts the `[current/total]` bracket pattern
/// 3. Computes progress as current/total
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
}

impl ProgressParser for ColmapFeatureParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        // Must contain the operation name indicating feature extraction or matching
        if !line.contains("Extracting features") && !line.contains("Matching images") {
            return None;
        }

        // Extract [current/total] from the line
        let (current, total) = Self::extract_brackets(line)?;

        if total == 0 {
            return None;
        }

        let percent = (current as f64).min(total as f64) / total as f64;

        let message = if line.contains("Extracting features") {
            format!("Extracting features: {}/{}", current, total)
        } else {
            format!("Matching images: {}/{}", current, total)
        };

        Some(
            TaskProgress::new(&self.stage_id, message)
                .with_percent(percent)
                .with_items(current, self.total_images.max(total)),
        )
    }
}

/// Parses COLMAP `mapper` progress output.
///
/// The mapper has a different progress style — it outputs registration
/// progress as images are added:
/// ```text
/// I20240712 12:00:00.123456  5678 mapper.cc:300] [0.123s] Registering image [50/100]
/// ```
pub struct ColmapMapperParser {
    stage_id: String,
}

impl ColmapMapperParser {
    pub fn new(stage_id: impl Into<String>) -> Self {
        Self {
            stage_id: stage_id.into(),
        }
    }
}

impl ProgressParser for ColmapMapperParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
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
    fn test_mapper_parser_skips_non_mapping() {
        let parser = ColmapMapperParser::new("mapping");
        assert!(parser
            .parse_line("I20240712 12:00:00.123  5678 mapper.cc:100] Loading model")
            .is_none());
    }
}
