use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_domain::hardware::EngineInfo;
use splat_domain::runtime::ExecutionProfile;
use splat_process::CommandSpec;
#[cfg(target_os = "windows")]
use splat_process::{background_command, probe_output_sync};

use crate::database::DatabaseCreator;
use crate::execution::{gpu_flag, validate_engine_version, ColmapExecutionSettings};
use crate::feature::{FeatureExtractionOptions, FeatureExtractor};
use crate::mapper::ColmapMapper;
use crate::runtime;
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
    execution_settings: Option<ColmapExecutionSettings>,
}

impl ColmapAdapter {
    // ─── Detection ──────────────────────────────────────────────────────

    /// Detect COLMAP availability on the system.
    ///
    /// Runs `colmap -h` to check if COLMAP is accessible and parse its version.
    pub fn detect() -> EngineInfo {
        match Self::find_colmap() {
            Ok(path) => {
                let version = Self::get_colmap_version(&path, None).unwrap_or_default();
                let available = validate_engine_version(&version).is_ok();
                EngineInfo {
                    name: "colmap".into(),
                    version: Some(version),
                    path: Some(path.to_string_lossy().to_string()),
                    available,
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
        Self::from_path(colmap_path).ok()
    }

    /// Create an adapter from a path resolved by the application.
    pub fn from_path(colmap_path: PathBuf) -> AppResult<Self> {
        let colmap_version = Self::get_colmap_version(&colmap_path, None)?;
        validate_engine_version(&colmap_version)?;
        Ok(Self {
            colmap_path,
            colmap_version,
            execution_settings: None,
        })
    }

    /// Resolve a known binary using a frozen, platform-explicit execution profile.
    /// Readiness and binary integrity are checked by application preflight.
    pub fn from_path_with_profile(
        colmap_path: PathBuf,
        profile: &ExecutionProfile,
    ) -> AppResult<Self> {
        Self::from_path_with_settings(
            colmap_path,
            ColmapExecutionSettings::from_execution_profile(profile)?,
        )
    }

    pub fn from_path_with_settings(
        colmap_path: PathBuf,
        settings: ColmapExecutionSettings,
    ) -> AppResult<Self> {
        let colmap_version = Self::get_colmap_version(&colmap_path, Some(&settings))?;
        settings.validate_engine_version(&colmap_version)?;
        Ok(Self {
            colmap_path,
            colmap_version,
            execution_settings: Some(settings),
        })
    }

    /// Existing callers retain their original defaults until they opt in here.
    pub fn with_execution_settings(mut self, settings: ColmapExecutionSettings) -> AppResult<Self> {
        settings.validate_engine_version(&self.colmap_version)?;
        self.execution_settings = Some(settings);
        Ok(self)
    }

    pub fn execution_settings(&self) -> Option<&ColmapExecutionSettings> {
        self.execution_settings.as_ref()
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
        let version =
            Self::get_colmap_version(&self.colmap_path, self.execution_settings.as_ref())?;
        validate_engine_version(&version)
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
        let creator = DatabaseCreator::new(self.colmap_path.clone());
        match &self.execution_settings {
            Some(settings) => creator.with_execution_settings(settings.clone()),
            None => creator,
        }
    }

    // ─── Feature Extraction ────────────────────────────────────────────

    /// Create a feature extractor for this COLMAP installation.
    pub fn feature_extractor(&self) -> FeatureExtractor {
        let extractor = FeatureExtractor::new(self.colmap_path.clone());
        match &self.execution_settings {
            Some(settings) => extractor.with_execution_settings(settings.clone()),
            None => extractor,
        }
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

        if let Some(settings) = &self.execution_settings {
            args.extend([
                "--FeatureMatching.use_gpu".into(),
                gpu_flag(settings.colmap().matching_backend).into(),
                "--FeatureMatching.num_threads".into(),
                settings.threads().to_string().into(),
            ]);
        }

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

        runtime::command_spec_with_settings(
            &self.colmap_path,
            args,
            log_path,
            self.execution_settings.as_ref(),
        )
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
        let mapper = ColmapMapper::new(self.colmap_path.clone());
        match &self.execution_settings {
            Some(settings) => mapper.with_execution_settings(settings.clone()),
            None => mapper,
        }
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
        let mut args: Vec<std::ffi::OsString> = vec![
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
        ];
        if let Some(settings) = &self.execution_settings {
            args.extend([
                "--num_threads".into(),
                settings.threads().to_string().into(),
            ]);
        }
        runtime::command_spec_with_settings(
            &self.colmap_path,
            args,
            log_path,
            self.execution_settings.as_ref(),
        )
    }

    // ─── Internal helpers ───────────────────────────────────────────────

    /// Find the COLMAP executable in the system PATH.
    fn find_colmap() -> AppResult<PathBuf> {
        let output =
            probe_colmap_help(runtime::command(Path::new("colmap")).arg("-h")).map_err(|_| {
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
            let where_output = probe_output_sync(background_command("where").arg("colmap"))
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
    fn get_colmap_version(
        path: &Path,
        settings: Option<&ColmapExecutionSettings>,
    ) -> AppResult<String> {
        let output = probe_colmap_help(runtime::command_with_settings(path, settings).arg("-h"))
            .map_err(|e| {
                AppError::new(
                    "E-3001",
                    ErrorCategory::Engine,
                    "COLMAP Detection Failed",
                    format!("Could not run colmap: {}", e),
                )
            })?;
        if !output.status.success() {
            return Err(AppError::new(
                "E-3002",
                ErrorCategory::Engine,
                "COLMAP Detection Failed",
                "COLMAP returned an error while reporting its command interface.",
            ));
        }

        let version_output = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(parse_colmap_version(&version_output).unwrap_or_else(|| "unknown".into()))
    }
}

fn probe_colmap_help(
    command: &mut std::process::Command,
) -> std::io::Result<splat_process::ProbeOutput> {
    #[cfg(target_os = "macos")]
    {
        // A fresh-path launch of the frozen native dylib closure took 16.9–25.3s
        // on the development host. Keep one bounded attempt, not a warm retry.
        splat_process::probe_output_sync_with_timeout(command, std::time::Duration::from_secs(45))
    }
    #[cfg(not(target_os = "macos"))]
    {
        splat_process::probe_output_sync(command)
    }
}

fn parse_colmap_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        line.strip_prefix("COLMAP ")
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use splat_domain::runtime::{ColmapBackend, RuntimePlatform};
    use std::ffi::OsStr;

    fn cpu_settings() -> ColmapExecutionSettings {
        let profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        ColmapExecutionSettings::from_execution_profile(&profile).unwrap()
    }

    fn profile_adapter(settings: Option<ColmapExecutionSettings>) -> ColmapAdapter {
        ColmapAdapter {
            colmap_path: PathBuf::from("引擎 pack/colmap/bin/colmap"),
            colmap_version: "4.1.0".into(),
            execution_settings: settings,
        }
    }

    fn flag<'a>(spec: &'a CommandSpec, name: &str) -> Option<&'a OsStr> {
        spec.args
            .windows(2)
            .find_map(|pair| (pair[0] == name).then_some(pair[1].as_os_str()))
    }

    fn all_pipeline_commands(adapter: &ColmapAdapter) -> Vec<CommandSpec> {
        let database = Path::new("项目 space/数据库.db");
        let images = Path::new("项目 space/原始 照片");
        let output = Path::new("项目 space/输出 sparse");
        let log = Path::new("项目 space/logs/命令.log");
        vec![
            adapter.database_creator().build_command(database, log),
            adapter.build_feature_command(
                database,
                images,
                &FeatureExtractionOptions::default(),
                log,
            ),
            adapter.build_matching_command(
                database,
                &MatchingStrategy::Sequential { overlap: 10 },
                log,
            ),
            adapter.build_matching_command(database, &MatchingStrategy::Exhaustive, log),
            adapter.build_mapping_command(database, images, output, log),
            adapter.build_mapping_command_with_kind(
                MapperKind::Global,
                database,
                images,
                output,
                log,
            ),
            adapter.build_image_undistorter_command(
                images,
                output,
                Path::new("项目 space/训练"),
                960,
                log,
            ),
        ]
    }

    #[test]
    fn cpu_profile_overrides_gpu_default_and_freezes_every_sfm_backend_and_thread_budget() {
        let adapter = profile_adapter(Some(cpu_settings()));
        assert!(!adapter.execution_settings().unwrap().feature_uses_gpu());
        let commands = all_pipeline_commands(&adapter);
        assert_eq!(
            flag(&commands[1], "--FeatureExtraction.use_gpu"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&commands[1], "--FeatureExtraction.num_threads"),
            Some(OsStr::new("4"))
        );
        for spec in &commands[2..4] {
            assert_eq!(
                flag(spec, "--FeatureMatching.use_gpu"),
                Some(OsStr::new("0"))
            );
            assert_eq!(
                flag(spec, "--FeatureMatching.num_threads"),
                Some(OsStr::new("4"))
            );
        }
        assert_eq!(
            flag(&commands[4], "--Mapper.ba_use_gpu"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&commands[4], "--Mapper.num_threads"),
            Some(OsStr::new("4"))
        );
        assert_eq!(
            flag(&commands[5], "--GlobalMapper.gp_use_gpu"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&commands[5], "--GlobalMapper.ba_ceres_use_gpu"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&commands[5], "--GlobalMapper.num_threads"),
            Some(OsStr::new("4"))
        );
        assert_eq!(flag(&commands[6], "--num_threads"), Some(OsStr::new("4")));
        assert_eq!(
            flag(&commands[6], "--max_image_size"),
            Some(OsStr::new("960"))
        );
        assert_eq!(
            flag(&commands[6], "--output_type"),
            Some(OsStr::new("COLMAP"))
        );
        for spec in commands {
            assert!(
                spec.env.is_empty(),
                "native commands do not inject Windows or DYLD paths"
            );
            assert!(!spec
                .args
                .iter()
                .any(|arg| arg.to_string_lossy().contains("gpu_index")));
            assert_eq!(spec.program, adapter.colmap_path());
            assert_eq!(spec.log_file, Path::new("项目 space/logs/命令.log"));
            if let Some(path) = flag(&spec, "--database_path") {
                assert_eq!(path, OsStr::new("项目 space/数据库.db"));
            }
            if let Some(path) = flag(&spec, "--image_path") {
                assert_eq!(path, OsStr::new("项目 space/原始 照片"));
            }
        }
    }

    #[test]
    fn explicit_backends_preserve_matching_quality_options() {
        let adapter = profile_adapter(Some(cpu_settings()));
        let options = MatchingOptions {
            guided_matching: true,
            exhaustive_block_size: 17,
            quadratic_overlap: false,
        };
        let sequential = adapter.build_matching_command_with_options(
            Path::new("data.db"),
            &MatchingStrategy::Sequential { overlap: 13 },
            &options,
            Path::new("match.log"),
        );
        let exhaustive = adapter.build_matching_command_with_options(
            Path::new("data.db"),
            &MatchingStrategy::Exhaustive,
            &options,
            Path::new("match.log"),
        );
        assert_eq!(
            flag(&sequential, "--SequentialMatching.overlap"),
            Some(OsStr::new("13"))
        );
        assert_eq!(
            flag(&sequential, "--SequentialMatching.quadratic_overlap"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&exhaustive, "--ExhaustiveMatching.block_size"),
            Some(OsStr::new("17"))
        );
        for spec in [sequential, exhaustive] {
            assert_eq!(
                flag(&spec, "--FeatureMatching.guided_matching"),
                Some(OsStr::new("1"))
            );
        }
    }

    #[test]
    fn legacy_defaults_remain_gpu_feature_and_engine_selected_matching_and_mapping() {
        let commands = all_pipeline_commands(&profile_adapter(None));
        assert_eq!(
            flag(&commands[1], "--FeatureExtraction.use_gpu"),
            Some(OsStr::new("1"))
        );
        for spec in commands {
            assert!(!spec
                .args
                .iter()
                .any(|arg| arg.to_string_lossy().contains("num_threads")));
            for name in [
                "--FeatureMatching.use_gpu",
                "--Mapper.ba_use_gpu",
                "--GlobalMapper.gp_use_gpu",
                "--GlobalMapper.ba_ceres_use_gpu",
            ] {
                assert!(flag(&spec, name).is_none());
            }
            assert!(spec.env.contains_key(OsStr::new("QT_PLUGIN_PATH")));
        }
    }

    #[test]
    fn explicit_windows_backends_are_independent_and_do_not_depend_on_host() {
        let mut colmap = cpu_settings().colmap().clone();
        colmap.feature_backend = ColmapBackend::Cuda;
        colmap.global_positioning_backend = ColmapBackend::Cuda;
        let settings = ColmapExecutionSettings::new(RuntimePlatform::Windows, colmap, 6).unwrap();
        let commands = all_pipeline_commands(&profile_adapter(Some(settings)));
        assert_eq!(
            flag(&commands[1], "--FeatureExtraction.use_gpu"),
            Some(OsStr::new("1"))
        );
        assert_eq!(
            flag(&commands[2], "--FeatureMatching.use_gpu"),
            Some(OsStr::new("0"))
        );
        assert_eq!(
            flag(&commands[5], "--GlobalMapper.gp_use_gpu"),
            Some(OsStr::new("1"))
        );
        assert_eq!(
            flag(&commands[5], "--GlobalMapper.ba_ceres_use_gpu"),
            Some(OsStr::new("0"))
        );
        for spec in commands {
            assert!(spec.env.contains_key(OsStr::new("QT_PLUGIN_PATH")));
            assert!(spec.env.contains_key(OsStr::new("PATH")));
        }
    }

    #[test]
    fn parses_real_cpu_help_header_and_legacy_version_without_build_description() {
        for (help, expected) in [
            (
                "COLMAP 4.1.0 (Commit fa8e3b3 on 2026-04-16 without CUDA)\nUsage:",
                "4.1.0",
            ),
            (
                "COLMAP 3.9.1 -- Structure-from-Motion and Multi-View Stereo",
                "3.9.1",
            ),
        ] {
            assert_eq!(parse_colmap_version(help).as_deref(), Some(expected));
        }
        assert_eq!(parse_colmap_version("COLMAP \n"), None);
        assert_eq!(parse_colmap_version("failed to initialize"), None);
    }

    #[cfg(unix)]
    #[test]
    fn profile_constructor_checks_actual_version_and_help_exit_status() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("colmap 程序");
        for (version, exit_code, expected_error) in [
            ("4.1.0 (Commit fa8e3b3 without CUDA)", 0, None),
            ("4.3.0", 0, Some("E-3006")),
            ("unknown", 0, Some("E-3006")),
            ("4.1.0", 1, Some("E-3002")),
        ] {
            std::fs::write(
                &executable,
                format!("#!/bin/sh\nprintf 'COLMAP {version}\\n' >&2\nexit {exit_code}\n"),
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let result = ColmapAdapter::from_path_with_settings(executable.clone(), cpu_settings());
            match expected_error {
                Some(code) => assert_eq!(result.err().unwrap().code, code),
                None => assert_eq!(result.unwrap().version(), "4.1.0"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn database_path_preserves_non_utf8_os_bytes() {
        use std::os::unix::ffi::OsStringExt;
        let database = PathBuf::from(std::ffi::OsString::from_vec(b"project/db-\xff.db".to_vec()));
        let spec = profile_adapter(Some(cpu_settings()))
            .database_creator()
            .build_command(&database, Path::new("db.log"));
        assert_eq!(flag(&spec, "--database_path"), Some(database.as_os_str()));
    }

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
            execution_settings: None,
        };
        assert_eq!(adapter.version(), "3.9.1");
    }

    #[test]
    fn test_build_matching_command_sequential() {
        let adapter = ColmapAdapter {
            colmap_path: PathBuf::from("colmap"),
            colmap_version: "3.9.1".into(),
            execution_settings: None,
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
            execution_settings: None,
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
            execution_settings: None,
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
            execution_settings: None,
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

    #[test]
    fn every_pipeline_command_inherits_the_portable_runtime() {
        let executable = PathBuf::from("engine-pack")
            .join("colmap")
            .join("COLMAP-4.1.0")
            .join("bin")
            .join(if cfg!(windows) {
                "colmap.exe"
            } else {
                "colmap"
            });
        let adapter = ColmapAdapter {
            colmap_path: executable.clone(),
            colmap_version: "4.1.0".into(),
            execution_settings: None,
        };
        let specs = vec![
            adapter
                .database_creator()
                .build_command(Path::new("database.db"), Path::new("database.log")),
            adapter.build_feature_command(
                Path::new("database.db"),
                Path::new("images"),
                &FeatureExtractionOptions::default(),
                Path::new("feature.log"),
            ),
            adapter.build_matching_command(
                Path::new("database.db"),
                &MatchingStrategy::Exhaustive,
                Path::new("matching.log"),
            ),
            adapter.build_mapping_command(
                Path::new("database.db"),
                Path::new("images"),
                Path::new("sparse"),
                Path::new("mapping.log"),
            ),
            adapter.build_image_undistorter_command(
                Path::new("images"),
                Path::new("sparse/0"),
                Path::new("training"),
                1600,
                Path::new("undistorter.log"),
            ),
        ];

        for spec in specs {
            let path = spec.env.get(std::ffi::OsStr::new("PATH")).unwrap();
            let entries = std::env::split_paths(path).collect::<Vec<_>>();
            assert_eq!(entries[0], executable.parent().unwrap());
            assert_eq!(
                spec.env.get(std::ffi::OsStr::new("QT_PLUGIN_PATH")),
                Some(
                    &executable
                        .parent()
                        .unwrap()
                        .parent()
                        .unwrap()
                        .join("plugins")
                        .into_os_string()
                )
            );
        }
    }
}
