use splat_domain::progress::TaskProgress;
use splat_process::ProgressParser;

/// Parses Brush training iteration progress from stdout/stderr.
///
/// # Output Format (⚠️ Verify with actual Brush)
///
/// Typical 3DGS training progress lines look like:
/// ```text
/// Iteration: 1000 Loss: 0.0523 (t=0.123s)
/// Iteration: 2000 Loss: 0.0417 (t=0.118s)
/// Iteration: 7000 Loss: 0.0289 (t=0.125s)
/// Saving checkpoint at iteration 7000
/// ```
///
/// This parser:
/// 1. Matches lines containing "Iteration:" (case-insensitive)
/// 2. Extracts the iteration number
/// 3. Optionally extracts the loss value
/// 4. Computes progress as current_iteration / total_iterations
pub struct BrushProgressParser {
    stage_id: String,
    total_iterations: u64,
}

impl BrushProgressParser {
    /// Create a new Brush progress parser.
    ///
    /// * `stage_id` — Pipeline stage ID for progress events
    /// * `total_iterations` — Total training iterations (0 if unknown)
    pub fn new(stage_id: impl Into<String>, total_iterations: u64) -> Self {
        Self {
            stage_id: stage_id.into(),
            total_iterations,
        }
    }

    /// Extract the iteration number from a line containing "Iteration: <N>".
    fn extract_iteration(line: &str) -> Option<u64> {
        let lower = line.to_lowercase();
        let marker = "iteration:";
        let pos = lower.find(marker)?;
        let rest = lower[pos + marker.len()..].trim_start();
        let num_str = rest.split_whitespace().next()?;
        // Remove trailing punctuation like ":"
        let num_str = num_str.trim_end_matches(|c: char| !c.is_ascii_digit());
        if num_str.is_empty() {
            return None;
        }
        num_str.parse::<u64>().ok()
    }

    /// Extract the loss value from a line containing "Loss: <N>" or "loss <N>".
    fn extract_loss(line: &str) -> Option<f64> {
        let lower = line.to_lowercase();

        // Try "loss:" first
        if let Some(pos) = lower.find("loss:") {
            let rest = lower[pos + 5..].trim_start();
            let val_str = rest.split_whitespace().next()?;
            // Remove trailing characters like ")" or ","
            let val_str = val_str.trim_end_matches(|c: char| {
                !c.is_ascii_digit() && c != '.' && c != 'e' && c != '-' && c != '+'
            });
            return val_str.parse::<f64>().ok();
        }

        // Try "loss "
        if let Some(pos) = lower.find("loss ") {
            let rest = lower[pos + 5..].trim_start();
            let val_str = rest.split_whitespace().next()?;
            let val_str = val_str.trim_end_matches(|c: char| {
                !c.is_ascii_digit() && c != '.' && c != 'e' && c != '-' && c != '+'
            });
            return val_str.parse::<f64>().ok();
        }

        None
    }
}

impl ProgressParser for BrushProgressParser {
    fn parse_line(&self, line: &str) -> Option<TaskProgress> {
        let current = Self::extract_iteration(line)?;

        // Skip iteration 0 (initialization step)
        if current == 0 {
            return None;
        }

        let percent = if self.total_iterations > 0 {
            (current as f64).min(self.total_iterations as f64) / self.total_iterations as f64
        } else {
            0.0
        };

        let loss = Self::extract_loss(line);

        let message = match loss {
            Some(l) => format!(
                "Iteration {} / {} (Loss: {:.4})",
                current, self.total_iterations, l
            ),
            None => format!("Iteration {} / {}", current, self.total_iterations),
        };

        Some(
            TaskProgress::new(&self.stage_id, message)
                .with_percent(percent)
                .with_items(current, self.total_iterations),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> BrushProgressParser {
        BrushProgressParser::new("training", 7000)
    }

    // ─── extract_iteration ─────────────────────────────────────────────

    #[test]
    fn test_extract_iteration_basic() {
        assert_eq!(
            BrushProgressParser::extract_iteration("Iteration: 3500 Loss: 0.0421"),
            Some(3500)
        );
    }

    #[test]
    fn test_extract_iteration_lowercase() {
        assert_eq!(
            BrushProgressParser::extract_iteration("iteration: 1000"),
            Some(1000)
        );
    }

    #[test]
    fn test_extract_iteration_no_match() {
        assert!(BrushProgressParser::extract_iteration("Starting training...").is_none());
        assert!(BrushProgressParser::extract_iteration("").is_none());
    }

    #[test]
    fn test_extract_iteration_with_parentheses() {
        assert_eq!(
            BrushProgressParser::extract_iteration("Iteration: 7000 Loss: 0.0289 (t=0.125s)"),
            Some(7000)
        );
    }

    #[test]
    fn test_extract_iteration_zero() {
        assert_eq!(
            BrushProgressParser::extract_iteration("Iteration: 0"),
            Some(0)
        );
    }

    // ─── extract_loss ──────────────────────────────────────────────────

    #[test]
    fn test_extract_loss_basic() {
        let loss = BrushProgressParser::extract_loss("Iteration: 1000 Loss: 0.0523");
        assert!(loss.is_some());
        assert!((loss.unwrap() - 0.0523).abs() < 0.0001);
    }

    #[test]
    fn test_extract_loss_scientific() {
        let loss = BrushProgressParser::extract_loss("Iteration: 100 Loss: 3.21e-2");
        assert!(loss.is_some());
        assert!((loss.unwrap() - 0.0321).abs() < 0.001);
    }

    #[test]
    fn test_extract_loss_no_match() {
        assert!(BrushProgressParser::extract_loss("Saving checkpoint...").is_none());
        assert!(BrushProgressParser::extract_loss("").is_none());
    }

    #[test]
    fn test_extract_loss_lowercase() {
        let loss = BrushProgressParser::extract_loss("iteration: 500 loss 0.0156");
        assert!(loss.is_some());
        assert!((loss.unwrap() - 0.0156).abs() < 0.0001);
    }

    // ─── parse_line ────────────────────────────────────────────────────

    #[test]
    fn test_parse_line_full() {
        let p = parser();
        let result = p.parse_line("Iteration: 3500 Loss: 0.0421 (t=0.123s)");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert_eq!(progress.current_item, 3500);
        assert_eq!(progress.total_items, 7000);
        assert!((progress.percent - 0.5).abs() < 0.001);
        assert!(progress.message.contains("Loss: 0.0421"));
    }

    #[test]
    fn test_parse_line_without_loss() {
        let p = parser();
        let result = p.parse_line("Iteration: 2000");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert_eq!(progress.current_item, 2000);
        // Should not mention Loss:
        assert!(!progress.message.contains("Loss"));
    }

    #[test]
    fn test_parse_line_skip_non_iteration() {
        let p = parser();
        assert!(p
            .parse_line("Saving checkpoint at iteration 7000")
            .is_none());
        assert!(p.parse_line("Training started").is_none());
        assert!(p.parse_line("").is_none());
    }

    #[test]
    fn test_parse_line_skip_zero() {
        let p = parser();
        assert!(p.parse_line("Iteration: 0").is_none());
    }

    #[test]
    fn test_parse_line_completion() {
        let p = parser();
        let result = p.parse_line("Iteration: 7000 Loss: 0.0289");
        assert!(result.is_some());
        let progress = result.unwrap();
        assert!((progress.percent - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_line_unknown_total() {
        let p = BrushProgressParser::new("training", 0);
        let result = p.parse_line("Iteration: 5000 Loss: 0.0321").unwrap();
        assert!((result.percent - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_implements_progress_parser_trait() {
        let p: Box<dyn ProgressParser> = Box::new(BrushProgressParser::new("training", 7000));
        let result = p.parse_line("Iteration: 3500 Loss: 0.0421");
        assert!(result.is_some());
    }
}
