use splat_domain::progress::TaskProgress;

/// Parses a line of process output and optionally produces a progress update.
///
/// Each engine adapter implements this trait to handle its own output format.
/// The `ProcessRunner` uses a `CompositeParser` to try registered parsers
/// in order and emit `ProcessEvent::Progress` when a match is found.
pub trait ProgressParser: Send + Sync {
    /// Parse a single line of output.
    ///
    /// Returns `Some(TaskProgress)` if the line contains progress information,
    /// or `None` if the line should be treated as a normal output line.
    fn parse_line(&self, line: &str) -> Option<TaskProgress>;
}

/// Combines multiple progress parsers and tries them in order.
///
/// The first parser that returns a non-None result wins.
/// This allows falling back from engine-specific parsers
/// to generic parsers (e.g. percentage-based).
pub struct CompositeParser {
    parsers: Vec<Box<dyn ProgressParser>>,
}

impl CompositeParser {
    /// Create a new empty composite parser.
    pub fn new() -> Self {
        Self {
            parsers: Vec::new(),
        }
    }

    /// Add a parser to the end of the chain.
    pub fn add(&mut self, parser: Box<dyn ProgressParser>) {
        self.parsers.push(parser);
    }

    /// Try all registered parsers in order.
    ///
    /// Returns the first non-None result, or `None` if no parser matched.
    pub fn parse(&self, line: &str) -> Option<TaskProgress> {
        for parser in &self.parsers {
            if let Some(progress) = parser.parse_line(line) {
                return Some(progress);
            }
        }
        None
    }

    /// Returns `true` if no parsers are registered.
    pub fn is_empty(&self) -> bool {
        self.parsers.is_empty()
    }

    /// Returns the number of registered parsers.
    pub fn len(&self) -> usize {
        self.parsers.len()
    }
}

impl Default for CompositeParser {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Built-in parsers ────────────────────────────────────────────────────

/// Parser that extracts percentage values from lines like "45% completed".
pub struct PercentageParser {
    stage_id: String,
}

impl PercentageParser {
    /// Create a new percentage parser for a given stage.
    pub fn new(stage_id: impl Into<String>) -> Self {
        Self {
            stage_id: stage_id.into(),
        }
    }
}

impl ProgressParser for PercentageParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        // Look for patterns like "45%", "progress: 75%", "75% complete"
        let re = regex_lite::Regex::new(r"(\d+)%").ok()?;
        if let Some(caps) = re.captures(line) {
            let pct: f64 = caps.get(1)?.as_str().parse().ok()?;
            let stage_id = self.stage_id.clone();
            return Some(TaskProgress::new(stage_id, line.to_string()).with_percent(pct / 100.0));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MockParser {
        stage_id: String,
        should_match: bool,
    }

    impl ProgressParser for MockParser {
        fn parse_line(&self, line: &str) -> Option<TaskProgress> {
            if self.should_match {
                Some(TaskProgress::new(&self.stage_id, line).with_percent(0.5))
            } else {
                None
            }
        }
    }

    #[test]
    fn test_composite_parser_empty() {
        let parser = CompositeParser::new();
        assert!(parser.is_empty());
        assert_eq!(parser.len(), 0);
        assert!(parser.parse("anything").is_none());
    }

    #[test]
    fn test_composite_parser_first_match_wins() {
        let mut parser = CompositeParser::new();
        parser.add(Box::new(MockParser {
            stage_id: "stage1".into(),
            should_match: true,
        }));
        parser.add(Box::new(MockParser {
            stage_id: "stage2".into(),
            should_match: true,
        }));

        let result = parser.parse("test line").unwrap();
        assert_eq!(result.stage_id, "stage1");
    }

    #[test]
    fn test_composite_parser_skip_non_matching() {
        let mut parser = CompositeParser::new();
        parser.add(Box::new(MockParser {
            stage_id: "skip".into(),
            should_match: false,
        }));
        parser.add(Box::new(MockParser {
            stage_id: "match".into(),
            should_match: true,
        }));

        let result = parser.parse("test line").unwrap();
        assert_eq!(result.stage_id, "match");
    }

    #[test]
    fn test_percentage_parser_matches() {
        let parser = PercentageParser::new("training");
        let result = parser.parse_line("Progress: 45% completed").unwrap();
        assert!((result.percent - 0.45).abs() < 1e-6);
        assert_eq!(result.stage_id, "training");
    }

    #[test]
    fn test_percentage_parser_no_match() {
        let parser = PercentageParser::new("training");
        assert!(parser.parse_line("Starting process").is_none());
        assert!(parser.parse_line("").is_none());
    }
}
