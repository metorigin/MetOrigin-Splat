//! Explicit COLMAP 4.1 execution settings. Defaults in the existing adapter are
//! unchanged; configuring these settings freezes backends and thread budgets.

use splat_domain::runtime::{ColmapBackend, ColmapExecution, ExecutionProfile, RuntimePlatform};
use splat_domain::{AppError, AppResult, ErrorCategory};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColmapExecutionSettings {
    platform: RuntimePlatform,
    colmap: ColmapExecution,
    threads: u32,
}

impl ColmapExecutionSettings {
    /// Validate independent SfM settings without assuming the host's backend.
    pub fn new(
        platform: RuntimePlatform,
        colmap: ColmapExecution,
        threads: u32,
    ) -> AppResult<Self> {
        if threads == 0 || threads > i32::MAX as u32 {
            return Err(invalid_settings(
                "COLMAP num_threads must fit a positive signed 32-bit integer",
            ));
        }
        if platform == RuntimePlatform::Macos
            && [
                colmap.feature_backend,
                colmap.matching_backend,
                colmap.global_positioning_backend,
            ]
            .iter()
            .any(|backend| *backend != ColmapBackend::Cpu)
        {
            return Err(invalid_settings(
                "The macOS COLMAP profile requires CPU extraction, matching and global positioning",
            ));
        }
        Ok(Self {
            platform,
            colmap,
            threads,
        })
    }

    /// Validate the frozen profile's data, without requiring training readiness
    /// merely to build a CPU SfM command. Application preflight checks readiness.
    pub fn from_execution_profile(profile: &ExecutionProfile) -> AppResult<Self> {
        profile.validate()?;
        Self::new(
            profile.platform,
            profile.colmap.clone(),
            profile.effective_training.threads,
        )
    }

    pub fn platform(&self) -> RuntimePlatform {
        self.platform
    }

    pub fn colmap(&self) -> &ColmapExecution {
        &self.colmap
    }

    pub fn threads(&self) -> u32 {
        self.threads
    }

    pub fn feature_uses_gpu(&self) -> bool {
        self.colmap.feature_backend == ColmapBackend::Cuda
    }

    pub(crate) fn validate_engine_version(&self, version: &str) -> AppResult<()> {
        validate_engine_version(version)
    }
}

/// Check the command/database contract before constructing an executable
/// adapter, including legacy runs that do not have an execution profile.
/// COLMAP 4.3 may migrate a 4.1 database as soon as it opens it.
pub(crate) fn validate_engine_version(version: &str) -> AppResult<()> {
    let (base, metadata) = version.split_once('+').unwrap_or((version, ""));
    let valid_metadata = !version.contains('+')
        || metadata.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        });
    if base != "4.1.0" || !valid_metadata {
        return Err(AppError::new(
            "E-3006",
            ErrorCategory::Engine,
            "Incompatible COLMAP Version",
            "This application requires the verified COLMAP 4.1.0 command and database interface.",
        )
        .with_technical(format!("detected COLMAP version: {version}"))
        .with_suggestions(vec![
            "Select the COLMAP 4.1.0 engine pack and run preflight again.",
        ]));
    }
    Ok(())
}

pub(crate) fn gpu_flag(backend: ColmapBackend) -> &'static str {
    match backend {
        ColmapBackend::Cpu => "0",
        ColmapBackend::Cuda => "1",
    }
}

fn invalid_settings(technical: &str) -> AppError {
    AppError::new(
        "E-3007",
        ErrorCategory::User,
        "Invalid COLMAP Execution Settings",
        "The selected COLMAP execution settings are not supported.",
    )
    .with_technical(technical)
    .with_suggestions(vec![
        "Use a supported platform profile and a positive thread budget.",
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_selects_cpu_explicitly_and_rejects_invalid_thread_budgets() {
        let profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        let settings = ColmapExecutionSettings::from_execution_profile(&profile).unwrap();
        assert!(!settings.feature_uses_gpu());
        assert_eq!(settings.threads(), 4);
        for threads in [0, u32::MAX] {
            assert!(ColmapExecutionSettings::new(
                profile.platform,
                profile.colmap.clone(),
                threads
            )
            .is_err());
        }
        assert!(ColmapExecutionSettings::new(profile.platform, profile.colmap, 1).is_ok());
    }

    #[test]
    fn independent_mac_settings_cannot_select_cuda() {
        let profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        for backend in 0..3 {
            let mut colmap = profile.colmap.clone();
            match backend {
                0 => colmap.feature_backend = ColmapBackend::Cuda,
                1 => colmap.matching_backend = ColmapBackend::Cuda,
                _ => colmap.global_positioning_backend = ColmapBackend::Cuda,
            }
            assert!(ColmapExecutionSettings::new(RuntimePlatform::Macos, colmap, 4).is_err());
        }
    }

    #[test]
    fn explicit_interface_accepts_only_the_verified_release_and_valid_metadata() {
        let profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        let settings = ColmapExecutionSettings::from_execution_profile(&profile).unwrap();
        for version in ["4.1.0", "4.1.0+metorigin-macos.1"] {
            settings.validate_engine_version(version).unwrap();
        }
        for version in [
            "unknown",
            "3.9.1",
            "4.3.0",
            "4.1.0-rc.1",
            "4.1.0+",
            "4.1.0+a..b",
            "4.1.0+a+b",
        ] {
            assert_eq!(
                settings.validate_engine_version(version).unwrap_err().code,
                "E-3006"
            );
        }
    }

    #[test]
    fn sfm_settings_preserve_diagnostic_profiles_without_claiming_training_readiness() {
        let mut profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        profile.brush.probe_result.status = splat_domain::runtime::CapabilityStatus::Unknown;
        assert!(profile.validate_for_execution().is_err());
        assert!(ColmapExecutionSettings::from_execution_profile(&profile).is_ok());
    }
}
