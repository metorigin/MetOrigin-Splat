use std::path::Path;

use splat_domain::error::{AppError, AppResult, ErrorCategory};

/// Training parameters parsed from a preset JSON file.
///
/// Maps to the `training` section of preset JSON files:
/// ```json
/// { "iterations": 7000, "quality": "balanced", "shDegree": 1 }
/// ```
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TrainingPreset {
    /// Number of training iterations
    pub iterations: u32,
    /// Quality level label (preview / balanced / quality)
    pub quality: String,
    /// Spherical harmonics degree (0/1/2)
    #[serde(rename = "shDegree")]
    pub sh_degree: u32,
}

/// Complete training configuration for the Brush engine.
///
/// Generated from a `TrainingPreset` (loaded from preset JSON) combined
/// with hardware information and user options.
///
/// # CLI Parameter Warning
///
/// Brush CLI parameter names (marked with ⚠️ in the source) are initial
/// estimates based on known 3DGS implementations. They MUST be verified
/// against the output of `brush train --help` for the specific pinned
/// version of Brush used in the project.
#[derive(Debug, Clone)]
pub struct TrainingConfig {
    /// Number of training iterations
    pub iterations: u32,
    /// Spherical harmonics maximum degree
    pub sh_degree: u32,
    /// Quality level label
    pub quality: String,
    /// Whether to enable antialiasing (reduces artifacts)
    pub antialiasing: bool,
    /// Whether to enable densification (grows Gaussians)
    pub densify: bool,
    /// Frequency (in iterations) to save training checkpoints
    pub checkpoint_interval: u32,
    /// Frequency (in iterations) to output render previews
    pub render_interval: u32,
}

impl TrainingConfig {
    /// Create a training config from a parsed preset.
    pub fn from_preset(preset: &TrainingPreset) -> Self {
        Self {
            iterations: preset.iterations,
            sh_degree: preset.sh_degree,
            quality: preset.quality.clone(),
            antialiasing: true,
            densify: true,
            checkpoint_interval: Self::calc_checkpoint_interval(preset.iterations),
            render_interval: Self::calc_render_interval(preset.iterations),
        }
    }

    /// Load a preset from a JSON file path.
    pub fn load_preset(path: &Path) -> AppResult<TrainingPreset> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            AppError::new(
                "E-1201",
                ErrorCategory::Filesystem,
                "Failed to Read Preset",
                format!("Could not read training preset '{}': {}", path.display(), e),
            )
        })?;

        let preset: TrainingPreset = serde_json::from_str(&content).map_err(|e| {
            AppError::new(
                "E-1002",
                ErrorCategory::User,
                "Invalid Preset JSON",
                format!(
                    "The preset file '{}' contains invalid JSON: {}",
                    path.display(),
                    e
                ),
            )
        })?;

        if preset.iterations == 0 {
            return Err(AppError::new(
                "E-1002",
                ErrorCategory::User,
                "Invalid Preset",
                "Training iterations must be greater than 0.",
            ));
        }

        Ok(preset)
    }

    /// Load the training section from one of the versioned built-in presets.
    pub fn from_builtin(name: &str) -> AppResult<Self> {
        #[derive(serde::Deserialize)]
        struct PresetFile {
            training: TrainingPreset,
        }

        let json = match name {
            "fast" => include_str!("../../../presets/fast.json"),
            "balanced" => include_str!("../../../presets/balanced.json"),
            "quality" => include_str!("../../../presets/quality.json"),
            _ => {
                return Err(AppError::new(
                    "E-1002",
                    ErrorCategory::User,
                    "Unknown Training Preset",
                    format!("The training preset '{name}' is not supported."),
                ));
            }
        };
        let preset: PresetFile = serde_json::from_str(json).map_err(|error| {
            AppError::new(
                "E-9001",
                ErrorCategory::Internal,
                "Invalid Built-in Training Preset",
                "A built-in training preset could not be loaded.",
            )
            .with_technical(error.to_string())
        })?;
        Ok(Self::from_preset(&preset.training))
    }

    /// Build arguments verified against Brush v0.3.0 (`brush_app --help`).
    pub fn to_cli_args(
        &self,
        dataset_path: &Path,
        checkpoint_path: &Path,
        start_iteration: u32,
    ) -> Vec<std::ffi::OsString> {
        let mut args: Vec<std::ffi::OsString> = vec![
            dataset_path.as_os_str().to_owned(),
            "--total-steps".into(),
            self.iterations.to_string().into(),
            "--sh-degree".into(),
            self.sh_degree.to_string().into(),
            "--export-every".into(),
            self.checkpoint_interval.to_string().into(),
            "--export-path".into(),
            checkpoint_path.as_os_str().to_owned(),
            "--export-name".into(),
            "checkpoint_{iter}.ply".into(),
            "--eval-every".into(),
            self.render_interval.to_string().into(),
        ];
        if start_iteration > 0 {
            args.push("--start-iter".into());
            args.push(start_iteration.to_string().into());
        }
        args
    }

    fn calc_checkpoint_interval(iterations: u32) -> u32 {
        if iterations <= 1000 {
            100
        } else if iterations <= 3000 {
            500
        } else if iterations <= 7000 {
            1000
        } else {
            5000
        }
    }

    fn calc_render_interval(iterations: u32) -> u32 {
        if iterations <= 1000 {
            100
        } else {
            (iterations / 10).max(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_preset() -> TrainingPreset {
        TrainingPreset {
            iterations: 3000,
            quality: "preview".into(),
            sh_degree: 0,
        }
    }

    fn balanced_preset() -> TrainingPreset {
        TrainingPreset {
            iterations: 7000,
            quality: "balanced".into(),
            sh_degree: 1,
        }
    }

    fn quality_preset() -> TrainingPreset {
        TrainingPreset {
            iterations: 30000,
            quality: "quality".into(),
            sh_degree: 2,
        }
    }

    #[test]
    fn test_from_preset_fast() {
        let config = TrainingConfig::from_preset(&fast_preset());
        assert_eq!(config.iterations, 3000);
        assert_eq!(config.sh_degree, 0);
        assert_eq!(config.quality, "preview");
        assert!(config.antialiasing);
        assert!(config.densify);
    }

    #[test]
    fn test_from_preset_balanced() {
        let config = TrainingConfig::from_preset(&balanced_preset());
        assert_eq!(config.iterations, 7000);
        assert_eq!(config.sh_degree, 1);
        assert_eq!(config.checkpoint_interval, 1000);
    }

    #[test]
    fn test_from_preset_quality() {
        let config = TrainingConfig::from_preset(&quality_preset());
        assert_eq!(config.iterations, 30000);
        assert_eq!(config.sh_degree, 2);
        assert_eq!(config.checkpoint_interval, 5000);
        assert_eq!(config.render_interval, 3000);
    }

    #[test]
    fn test_to_cli_args() {
        let config = TrainingConfig::from_preset(&balanced_preset());
        let args = config.to_cli_args(Path::new("project"), Path::new("checkpoints"), 1000);

        let args_str: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let joined = args_str.join(" ");

        assert!(joined.contains("project"));
        assert!(joined.contains("--total-steps"));
        assert!(joined.contains("7000"));
        assert!(joined.contains("--sh-degree"));
        assert!(joined.contains("1"));
        assert!(joined.contains("--export-every"));
        assert!(joined.contains("checkpoint_{iter}.ply"));
        assert!(joined.contains("--start-iter"));
    }

    #[test]
    fn test_to_cli_args_without_densify() {
        let mut config = TrainingConfig::from_preset(&balanced_preset());
        config.densify = false;
        let args = config.to_cli_args(Path::new("project"), Path::new("out"), 0);
        let joined: String = args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(!joined.contains("--start-iter"));
    }

    #[test]
    fn test_checkpoint_interval() {
        assert_eq!(TrainingConfig::calc_checkpoint_interval(500), 100);
        assert_eq!(TrainingConfig::calc_checkpoint_interval(3000), 500);
        assert_eq!(TrainingConfig::calc_checkpoint_interval(30000), 5000);
    }

    #[test]
    fn test_render_interval() {
        assert_eq!(TrainingConfig::calc_render_interval(500), 100);
        assert_eq!(TrainingConfig::calc_render_interval(7000), 700);
        assert_eq!(TrainingConfig::calc_render_interval(30000), 3000);
    }

    #[test]
    fn test_load_preset_file_nonexistent() {
        let result = TrainingConfig::load_preset(Path::new("/nonexistent/preset.json"));
        assert!(result.is_err());
    }

    #[test]
    fn test_load_builtin_fast() {
        let config = TrainingConfig::from_builtin("fast").unwrap();
        assert_eq!(config.iterations, 3000);
        assert_eq!(config.sh_degree, 0);
        assert_eq!(config.checkpoint_interval, 500);
    }

    #[test]
    fn test_deserialize_preset() {
        let json = r#"{"iterations": 7000, "quality": "balanced", "shDegree": 1}"#;
        let preset: TrainingPreset = serde_json::from_str(json).unwrap();
        assert_eq!(preset.iterations, 7000);
        assert_eq!(preset.sh_degree, 1);
    }
}
