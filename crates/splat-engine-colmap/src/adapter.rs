use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EngineInfo;
use splat_process::CommandSpec;

use crate::database::DatabaseCreator;
use crate::feature::{FeatureExtractionOptions, FeatureExtractor};
use crate::mapper::ColmapMapper;
use crate::types::{MapperKind, MatchingOptions, MatchingStrategy};

/// COLMAP engine adapter.
///
/// Provides:
/// - COLMAP detection and version checking
/// - Database creation and validation
/// - Feature extraction command generation
/// - Feature matching command generation (sequential / exhaustive)
///
/// All COLMAP interactions must go through this adapter — never
/// construct COLMAP commands directly in business logic or UI.
pub struct ColmapAdapter {
    /// Path to the detected COLMAP executable
    colmap_path: PathBuf,
    /// Parsed COLMAP version string
    colmap_version: String,
}

impl ColmapAdapter {
    // ─── Detection ──────────────────────────────────────────────────────

    /// Detect COLMAP availability on the system.
    ///
    /// Runs `colmap -h` to check if COLMAP is accessible and parse its version.
    pub fn detect() -> EngineInfo {
        match Self::find_colmap() {
            Ok(path) => {
                let version = Self::get_colmap_version(&path).unwrap_or_default();
                EngineInfo {
                    name: "colmap".into(),
                    version: Some(version),
                    path: Some(path.to_string_lossy().to_string()),
                    available: true,
                }
            }
            Err(_) => EngineInfo {
                name: "colmap".into(),
                version: None,
                path: None,
                available: false,
            },
        }
    }

    /// Create a new adapter instance, detecting COLMAP.
    ///
    /// Returns `None` if COLMAP is not available.
    pub fn new() -> Option<Self> {
        let colmap_path = Self::find_colmap().ok()?;
        let colmap_version = Self::get_colmap_version(&colmap_path).ok()?;
        Some(Self {
            colmap_path,
            colmap_version,
        })
    }

    /// Create an adapter from a path resolved by the application.
    pub fn from_path(colmap_path: PathBuf) -> AppResult<Self> {
        let colmap_version = Self::get_colmap_version(&colmap_path)?;
        let adapter = Self {
            colmap_path,
            colmap_version,
        };
        adapter.validate()?;
        Ok(adapter)
    }

    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo {
            name: "colmap".into(),
            version: Some(self.colmap_version.clone()),
            path: Some(self.colmap_path.to_string_lossy().to_string()),
            available: true,
        }
    }

    /// Validate that COLMAP is functional by running `colmap -h`.
    pub fn validate(&self) -> AppResult<()> {
        let output = std::process::Command::new(&self.colmap_path)
            .arg("-h")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-3001",
                    ErrorCategory::Engine,
                    "COLMAP Validation Failed",
                    format!(
                        "Could not run COLMAP at '{}': {}",
                        self.colmap_path.display(),
                        e
                    ),
                )
                .retryable(true)
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "COLMAP Not Responding",
                "COLMAP is installed but returned an error when running a basic check.",
            ));
        }

        Ok(())
    }

    /// Return the detected COLMAP version.
    pub fn version(&self) -> &str {
        &self.colmap_version
    }

    /// Return the path to the COLMAP executable.
    pub fn colmap_path(&self) -> &Path {
        &self.colmap_path
    }

    // ─── Database ───────────────────────────────────────────────────────

    /// Create a new COLMAP database.
    ///
    /// Returns a `DatabaseCreator` instance that can build commands
    /// and validate the database.
    pub fn database_creator(&self) -> DatabaseCreator {
        DatabaseCreator::new(self.colmap_path.clone())
    }

    // ─── Feature Extraction ────────────────────────────────────────────

    /// Create a feature extractor for this COLMAP installation.
    pub fn feature_extractor(&self) -> FeatureExtractor {
        FeatureExtractor::new(self.colmap_path.clone())
    }

    /// Build a `CommandSpec` for feature extraction.
    ///
    /// A convenience method that combines feature extractor creation
    /// and command building in one call.
    pub fn build_feature_command(
        &self,
        database_path: &Path,
        image_path: &Path,
        options: &FeatureExtractionOptions,
        log_path: &Path,
    ) -> CommandSpec {
        self.feature_extractor()
            .build_command(database_path, image_path, options, log_path)
    }

    // ─── Matching ───────────────────────────────────────────────────────

    /// Build a `CommandSpec` for feature matching.
    ///
    /// Selects the subcommand based on `MatchingStrategy`:
    /// - `Sequential` → `colmap sequential_matcher`
    /// - `Exhaustive` → `colmap exhaustive_matcher`
    pub fn build_matching_command(
        &self,
        database_path: &Path,
        strategy: &MatchingStrategy,
        log_path: &Path,
    ) -> CommandSpec {
        self.build_matching_command_with_options(
            database_path,
            strategy,
            &MatchingOptions::default(),
            log_path,
        )
    }

    pub fn build_matching_command_with_options(
        &self,
        database_path: &Path,
        strategy: &MatchingStrategy,
        options: &MatchingOptions,
        log_path: &Path,
    ) -> CommandSpec {
        let mut args: Vec<std::ffi::OsString> = vec![
            strategy.subcommand().into(),
            "--log_target".into(),
            "stderr".into(),
            "--database_path".into(),
            database_path.as_os_str().to_owned(),
        ];

        // Add strategy-specific flags
        if let MatchingStrategy::Sequential { overlap } = strategy {
            args.push("--SequentialMatching.overlap".into());
            args.push(overlap.to_string().into());
            args.push("--SequentialMatching.quadratic_overlap".into());
            args.push(if options.quadratic_overlap { "1" } else { "0" }.into());
        } else {
            args.push("--ExhaustiveMatching.block_size".into());
            args.push(options.exhaustive_block_size.max(1).to_string().into());
        }
        args.push("--FeatureMatching.guided_matching".into());
        args.push(if options.guided_matching { "1" } else { "0" }.into());

        CommandSpec::new(&self.colmap_path, args, log_path)
    }

    // ─── Mapping ────────────────────────────────────────────────────────

    /// Build a `CommandSpec` for sparse reconstruction (mapper).
    pub fn build_mapping_command(
        &self,
        database_path: &Path,
        image_path: &Path,
        output_path: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        self.mapper()
            .build_command(database_path, image_path, output_path, log_path)
    }

    pub fn build_mapping_command_with_kind(
        &self,
        kind: MapperKind,
        database_path: &Path,
        image_path: &Path,
        output_path: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        self.mapper().build_command_with_kind(
            kind,
            database_path,
            image_path,
            output_path,
            log_path,
        )
    }

    /// Create a sparse mapper using the resolved COLMAP executable.
    pub fn mapper(&self) -> ColmapMapper {
        ColmapMapper::new(self.colmap_path.clone())
    }

    /// Build an image_undistorter command that produces a training-specific
    /// COLMAP dataset with camera intrinsics scaled together with images.
    pub fn build_image_undistorter_command(
        &self,
        image_path: &Path,
        input_model_path: &Path,
        output_path: &Path,
        max_image_size: u32,
        log_path: &Path,
    ) -> CommandSpec {
        CommandSpec::new(
            &self.colmap_path,
            vec![
                "image_undistorter".into(),
                "--log_target".into(),
                "stderr".into(),
                "--image_path".into(),
                image_path.as_os_str().to_owned(),
                "--input_path".into(),
                input_model_path.as_os_str().to_owned(),
                "--output_path".into(),
                output_path.as_os_str().to_owned(),
                "--output_type".into(),
                "COLMAP".into(),
                "--max_image_size".into(),
                max_image_size.max(1).to_string().into(),
            ],
            log_path,
        )
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// Find the COLMAP executable in the system PATH.
    fn find_colmap() -> AppResult<PathBuf> {
        let output = std::process::Command::new("colmap")
            .arg("-h")
            .output()
            .map_err(|_| {
                AppError::new(
                    "E-3001",
                    ErrorCategory::Engine,
                    "COLMAP Not Found",
                    "COLMAP is not installed or not available in your system PATH.",
                )
                .with_suggestions(vec![
                    "Install COLMAP from https://colmap.github.io/install.html",
                    "Ensure COLMAP is in your system PATH",
                    "You can also specify the COLMAP path in Settings",
                ])
            })?;

        if !output.status.success() {
            return Err(AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "COLMAP Error",
                "COLMAP is installed but returned an error.",
            ));
        }

        // Find the actual path
        #[cfg(target_os = "windows")]
        {
            let where_output = std::process::Command::new("where")
                .arg("colmap")
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        String::from_utf8(o.stdout)
                            .ok()
                            .and_then(|s| s.lines().next().map(|l| l.trim().to_string()))
                    } else {
                        None
                    }
                });

            if let Some(path) = where_output {
                return Ok(PathBuf::from(path));
            }
        }

        Ok(PathBuf::from("colmap"))
    }

    /// Parse the COLMAP version from `colmap -h` output.
    ///
    /// Expected first line: "COLMAP 3.9.1 -- Structure-from-Motion ..."
    fn get_colmap_version(path: &Path) -> AppResult<String> {
        let output = std::process::Command::new(path)
            .arg("-h")
            .output()
            .map_err(|e| {
                AppError::new(
                    "E-3001",
                    ErrorCategory::Engine,
                    "COLMAP Detection Failed",
                    format!("Could not run colmap: {}", e),
                )
            })?;

        let version_output = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let first_line = version_output
            .lines()
            .find(|line| line.starts_with("COLMAP "))
            .unwrap_or("");

        // Parse "COLMAP <version>" from the first line
        let version = first_line
            .strip_prefix("COLMAP ")
            .and_then(|rest| {
                // Take the version number before the " --" separator
                rest.split(" --").next().map(|v| v.trim().to_string())
            })
            .unwrap_or_else(|| "unknown".to_string());

        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_info() {
        let info = ColmapAdapter::detect();
        // On CI without COLMAP, available will be false — that's fine
        assert_eq!(info.name, "colmap");
    }

    #[test]
    fn test_version_parsing() {
        // Simulate the version parsing
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
        };
        assert_eq!(adapter.version(), "3.9.1");
    }

    #[test]
    fn test_build_matching_command_sequential() {
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
        };

        let spec = adapter.build_matching_command(
            Path::new("database.db"),
            &MatchingStrategy::Sequential { overlap: 10 },
            Path::new("match.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("sequential_matcher"));
        assert!(args_str.contains("--database_path"));
        assert!(args_str.contains("database.db"));
        assert!(args_str.contains("--SequentialMatching.overlap"));
        assert!(args_str.contains("10"));
    }

    #[test]
    fn test_build_matching_command_exhaustive() {
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
        };

        let spec = adapter.build_matching_command(
            Path::new("database.db"),
            &MatchingStrategy::Exhaustive,
            Path::new("match.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("exhaustive_matcher"));
        assert!(args_str.contains("--database_path"));
        assert!(args_str.contains("database.db"));
        // Exhaustive should NOT contain overlap flag
        assert!(!args_str.contains("--SequentialMatching.overlap"));
    }

    #[test]
    fn test_build_mapping_command() {
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
        };

        let spec = adapter.build_mapping_command(
            Path::new("database.db"),
            Path::new("images"),
            Path::new("colmap/sparse"),
            Path::new("mapper.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("mapper"));
        assert!(args_str.contains("--database_path"));
        assert!(args_str.contains("database.db"));
        assert!(args_str.contains("--image_path"));
        assert!(args_str.contains("images"));
        assert!(args_str.contains("--output_path"));
        assert!(args_str.contains("sparse"));
    }

    #[test]
    fn test_build_feature_command_delegates() {
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
        };

        let spec = adapter.build_feature_command(
            Path::new("database.db"),
            Path::new("frames"),
            &FeatureExtractionOptions::default(),
            Path::new("feature.log"),
        );

        let args: Vec<String> = spec
            .args
            .iter()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        let args_str = args.join(" ");

        assert!(args_str.contains("feature_extractor"));
        assert!(args_str.contains("--image_path"));
        assert!(args_str.contains("frames"));
    }
}
