//! Versioned, portable execution contract stored separately from project.json.
//!
//! Deserialization validates the schema and cross-field invariants. Unknown
//! probe evidence is readable, but callers must use `validate_for_execution`
//! before launching an engine. This module performs no probing or file I/O.

use crate::{AppError, AppResult, ErrorCategory};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const EXECUTION_PROFILE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePlatform {
    Windows,
    Macos,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Architecture {
    X86_64,
    Arm64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineIdentity {
    pub version: String,
    /// Optional for existing Windows engine packs which did not record commits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    pub binary_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeEngines {
    pub ffmpeg: EngineIdentity,
    pub ffprobe: EngineIdentity,
    pub colmap: EngineIdentity,
    pub brush: EngineIdentity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColmapCliProfile {
    #[serde(rename = "colmap_4_1")]
    Colmap41,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ColmapDatabaseProfile {
    #[serde(rename = "colmap_4_1")]
    Colmap41,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColmapBackend {
    Cpu,
    Cuda,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BundleAdjustmentBackend {
    CeresCpu,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColmapExecution {
    pub cli_profile: ColmapCliProfile,
    pub database_schema_profile: ColmapDatabaseProfile,
    pub feature_backend: ColmapBackend,
    pub matching_backend: ColmapBackend,
    pub global_positioning_backend: ColmapBackend,
    pub ba_backend: BundleAdjustmentBackend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BrushCliProfile {
    #[serde(rename = "legacy_0_3")]
    Legacy03,
    #[serde(rename = "metorigin_1")]
    Metorigin1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrushBackend {
    /// Existing Windows 0.3 selection; does not claim Vulkan or DX12 evidence.
    LegacyDefault,
    Metal,
    Vulkan,
    Dx12,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    #[default]
    Unknown,
    Supported,
    Unsupported,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeKind {
    /// Compatibility evidence for Windows 0.3; not a GPU compute test.
    LegacyNvidiaDriver,
    /// Real device initialization, rendering and backward-pass computation.
    ComputeSmoke,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrainingProbe {
    pub kind: ProbeKind,
    pub status: CapabilityStatus,
    /// Actual observed backend. Absence is unknown, never inferred from the OS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BrushBackend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrushExecution {
    pub cli_profile: BrushCliProfile,
    pub backend: BrushBackend,
    pub probe_result: TrainingProbe,
    /// Omitted capability fields are unknown for conservative negotiation.
    #[serde(default)]
    pub live_preview: CapabilityStatus,
    #[serde(default)]
    pub ply_warm_start: CapabilityStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Dedicated,
    Unified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryBudget {
    pub kind: MemoryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_memory_bytes: Option<u64>,
    /// A resource policy budget, not an OS-enforced process memory limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub training_budget_bytes: Option<u64>,
    /// Detected VRAM or Metal working-set recommendation; absent means unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_working_set_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveTraining {
    pub iterations: u32,
    pub sh_degree: u32,
    /// Old Windows CLI runs may leave these engine defaults unmeasured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_cache_budget_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_splats: Option<u32>,
    pub threads: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lod_levels: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveProtocol {
    /// Checkpoint viewing remains available; no live producer is negotiated.
    Disabled,
    PlyRequestAckV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResumeMode {
    Disabled,
    /// Restore model parameters only. Optimizer/RNG/loader state is not resumed.
    PlyWarmStartOptimizerReset,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "ExecutionProfileWire")]
pub struct ExecutionProfile {
    pub schema_version: u32,
    pub run_id: Uuid,
    pub platform: RuntimePlatform,
    pub architecture: Architecture,
    pub os_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_pack_id: Option<String>,
    pub engines: RuntimeEngines,
    pub colmap: ColmapExecution,
    pub brush: BrushExecution,
    pub memory: MemoryBudget,
    pub effective_training: EffectiveTraining,
    pub live_protocol: LiveProtocol,
    pub resume_mode: ResumeMode,
}

// Keep unchecked data private: all public serde loading goes through validation.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionProfileWire {
    schema_version: u32,
    run_id: String,
    platform: RuntimePlatform,
    architecture: Architecture,
    os_version: String,
    #[serde(default)]
    engine_pack_id: Option<String>,
    engines: RuntimeEngines,
    colmap: ColmapExecution,
    brush: BrushExecution,
    memory: MemoryBudget,
    effective_training: EffectiveTraining,
    live_protocol: LiveProtocol,
    resume_mode: ResumeMode,
}

impl TryFrom<ExecutionProfileWire> for ExecutionProfile {
    type Error = AppError;

    fn try_from(value: ExecutionProfileWire) -> AppResult<Self> {
        let run_id =
            Uuid::parse_str(&value.run_id).map_err(|error| invalid_json(error.to_string()))?;
        ensure(
            run_id.hyphenated().to_string() == value.run_id,
            "run_id must be a canonical lowercase UUID",
        )?;
        let profile = Self {
            schema_version: value.schema_version,
            run_id,
            platform: value.platform,
            architecture: value.architecture,
            os_version: value.os_version,
            engine_pack_id: value.engine_pack_id,
            engines: value.engines,
            colmap: value.colmap,
            brush: value.brush,
            memory: value.memory,
            effective_training: value.effective_training,
            live_protocol: value.live_protocol,
            resume_mode: value.resume_mode,
        };
        profile.validate()?;
        Ok(profile)
    }
}

impl ExecutionProfile {
    /// Load without mutating project data and retain structured validation errors.
    pub fn from_json(bytes: &[u8]) -> AppResult<Self> {
        #[derive(Deserialize)]
        struct VersionEnvelope {
            schema_version: u32,
        }
        let envelope: VersionEnvelope =
            serde_json::from_slice(bytes).map_err(|error| invalid_json(error.to_string()))?;
        if envelope.schema_version != EXECUTION_PROFILE_SCHEMA_VERSION {
            return Err(unsupported_version(envelope.schema_version));
        }
        let wire: ExecutionProfileWire =
            serde_json::from_slice(bytes).map_err(|error| invalid_json(error.to_string()))?;
        wire.try_into()
    }

    /// Check portable data, versions, platform compatibility and resource bounds.
    /// Unknown/failed probe results remain readable for diagnostics and recovery.
    pub fn validate(&self) -> AppResult<()> {
        if self.schema_version != EXECUTION_PROFILE_SCHEMA_VERSION {
            return Err(unsupported_version(self.schema_version));
        }
        ensure(!self.run_id.is_nil(), "run_id must not be nil")?;
        ensure(valid_text(&self.os_version), "os_version must be nonempty")?;
        optional_text(&self.engine_pack_id, "engine_pack_id")?;
        for (name, engine) in [
            ("ffmpeg", &self.engines.ffmpeg),
            ("ffprobe", &self.engines.ffprobe),
            ("colmap", &self.engines.colmap),
            ("brush", &self.engines.brush),
        ] {
            ensure(
                valid_text(&engine.version),
                &format!("{name} version must be nonempty"),
            )?;
            ensure(
                hex_digest(&engine.binary_sha256, 64),
                &format!("{name} binary_sha256 must contain 64 hex digits"),
            )?;
            if let Some(commit) = &engine.source_commit {
                ensure(
                    hex_digest(commit, 40),
                    &format!("{name} source_commit must contain 40 hex digits"),
                )?;
            }
        }
        ensure(
            version_has_base(&self.engines.colmap.version, "4.1.0"),
            "COLMAP profile requires version 4.1.0",
        )?;
        let brush_version = match self.brush.cli_profile {
            BrushCliProfile::Legacy03 => "0.3.0",
            BrushCliProfile::Metorigin1 => "1.0.0",
        };
        ensure(
            version_has_base(&self.engines.brush.version, brush_version),
            "Brush version and CLI profile disagree",
        )?;
        let probe = &self.brush.probe_result;
        optional_text(&probe.device_name, "probe device_name")?;
        optional_text(&probe.device_id, "probe device_id")?;
        if let Some(backend) = probe.backend {
            ensure(
                backend == self.brush.backend,
                "observed and selected Brush backends disagree",
            )?;
        }
        match self.platform {
            RuntimePlatform::Macos => {
                ensure(
                    self.architecture == Architecture::Arm64,
                    "macOS requires arm64",
                )?;
                ensure(
                    macos_version_supported(&self.os_version),
                    "macOS profile requires version 15.0 or later",
                )?;
                ensure(
                    self.colmap.feature_backend == ColmapBackend::Cpu
                        && self.colmap.matching_backend == ColmapBackend::Cpu
                        && self.colmap.global_positioning_backend == ColmapBackend::Cpu,
                    "macOS requires CPU feature extraction, matching and global positioning",
                )?;
                ensure(
                    self.brush.cli_profile == BrushCliProfile::Metorigin1
                        && self.brush.backend == BrushBackend::Metal,
                    "macOS requires Brush 1.0 with Metal",
                )?;
                ensure(
                    probe.kind == ProbeKind::ComputeSmoke,
                    "macOS requires compute-smoke evidence",
                )?;
                ensure(
                    self.memory.kind == MemoryKind::Unified,
                    "macOS requires unified memory accounting",
                )?;
                ensure(
                    self.memory.training_budget_bytes.is_some(),
                    "macOS requires an explicit training memory budget",
                )?;
                ensure(
                    self.effective_training.resolution.is_some()
                        && self.effective_training.image_cache_budget_bytes.is_some()
                        && self.effective_training.max_splats.is_some(),
                    "macOS requires explicit training resource limits",
                )?;
                ensure(
                    self.effective_training.lod_levels == Some(0),
                    "macOS MVP requires lod_levels=0",
                )?;
            }
            RuntimePlatform::Windows => {
                ensure(
                    self.architecture == Architecture::X86_64,
                    "Windows requires x86_64",
                )?;
                ensure(
                    self.memory.kind == MemoryKind::Dedicated,
                    "Windows requires dedicated memory accounting",
                )?;
                if self.brush.cli_profile == BrushCliProfile::Metorigin1 {
                    ensure(
                        matches!(
                            self.brush.backend,
                            BrushBackend::Dx12 | BrushBackend::Vulkan
                        ),
                        "Windows Brush 1 requires an explicitly selected DX12 or Vulkan backend",
                    )?;
                    ensure(
                        self.engines.brush.version == "1.0.0+metorigin-windows.1"
                            && self.engines.brush.source_commit.as_deref()
                                == Some("1388f74c6fe0236f68ee4915564bf00e9d2e3747"),
                        "Windows Brush 1 requires the pinned MetOrigin build identity",
                    )?;
                    ensure(
                        probe.kind == ProbeKind::ComputeSmoke,
                        "Windows Brush 1 requires compute-smoke evidence",
                    )?;
                    ensure(
                        self.colmap.feature_backend == ColmapBackend::Cuda
                            && self.colmap.matching_backend == ColmapBackend::Cuda
                            && self.colmap.global_positioning_backend == ColmapBackend::Cpu,
                        "Windows Brush 1 requires CUDA SIFT and explicit CPU global positioning",
                    )?;
                    ensure(
                        self.memory.training_budget_bytes.is_some()
                            && self.effective_training.resolution.is_some()
                            && self.effective_training.image_cache_budget_bytes.is_some()
                            && self.effective_training.max_splats.is_some()
                            && self.effective_training.lod_levels == Some(0),
                        "Windows Brush 1 requires explicit resource limits and lod_levels=0",
                    )?;
                } else {
                    ensure(
                        self.brush.backend != BrushBackend::Metal
                            && self.effective_training.lod_levels.is_none(),
                        "legacy Windows Brush requires a Windows backend and has no LOD parameter",
                    )?;
                }
                if self.brush.backend == BrushBackend::LegacyDefault {
                    ensure(probe.kind == ProbeKind::LegacyNvidiaDriver && probe.backend.is_none(),
                           "legacy-default backend uses driver evidence without an inferred WGPU backend")?;
                } else {
                    ensure(
                        probe.kind == ProbeKind::ComputeSmoke,
                        "an explicit Windows backend requires compute evidence",
                    )?;
                }
            }
        }
        self.validate_budgets()
    }

    /// Enforce readiness separately from profile readability. Windows retains
    /// its legacy driver-check contract; macOS needs an actual Metal smoke.
    pub fn validate_for_execution(&self) -> AppResult<()> {
        self.validate()?;
        let probe = &self.brush.probe_result;
        let compute_verified = probe.kind != ProbeKind::ComputeSmoke
            || (probe.backend == Some(self.brush.backend) && probe.device_name.is_some());
        if probe.status != CapabilityStatus::Supported || !compute_verified {
            return Err(not_ready(
                "training device has no successful compatible probe evidence",
            ));
        }
        if self.platform == RuntimePlatform::Windows
            && self.brush.cli_profile == BrushCliProfile::Metorigin1
            && probe.device_id.is_none()
        {
            return Err(not_ready(
                "Windows Brush 1 requires a reproducible device selection identity",
            ));
        }
        if self.live_protocol == LiveProtocol::PlyRequestAckV1
            && self.brush.live_preview != CapabilityStatus::Supported
        {
            return Err(not_ready(
                "PLY request/ACK live protocol has not been verified",
            ));
        }
        if self.resume_mode == ResumeMode::PlyWarmStartOptimizerReset
            && self.brush.ply_warm_start != CapabilityStatus::Supported
        {
            return Err(not_ready("PLY warm start has not been verified"));
        }
        Ok(())
    }

    fn validate_budgets(&self) -> AppResult<()> {
        let memory = &self.memory;
        let training = &self.effective_training;
        for (name, value) in [
            ("physical_memory_bytes", memory.physical_memory_bytes),
            ("training_budget_bytes", memory.training_budget_bytes),
            (
                "available_working_set_bytes",
                memory.available_working_set_bytes,
            ),
            (
                "image_cache_budget_bytes",
                training.image_cache_budget_bytes,
            ),
        ] {
            ensure(
                value.is_none_or(|bytes| bytes > 0),
                &format!("{name} must be positive when known"),
            )?;
        }
        if let Some(budget) = memory.training_budget_bytes {
            if memory.kind == MemoryKind::Unified {
                ensure(
                    memory
                        .physical_memory_bytes
                        .is_none_or(|total| budget <= total),
                    "unified training budget exceeds physical memory",
                )?;
            }
            ensure(
                memory
                    .available_working_set_bytes
                    .is_none_or(|available| budget <= available),
                "training budget exceeds detected working set",
            )?;
            ensure(
                training
                    .image_cache_budget_bytes
                    .is_none_or(|cache| cache <= budget),
                "image cache exceeds training budget",
            )?;
        } else {
            ensure(
                training.image_cache_budget_bytes.is_none(),
                "an image cache limit requires a training budget",
            )?;
        }
        ensure(
            training.iterations > 0 && training.threads > 0,
            "iterations and threads must be positive",
        )?;
        ensure(training.sh_degree <= 3, "SH degree must be between 0 and 3")?;
        ensure(
            training.resolution.is_none_or(|value| value > 0),
            "resolution must be positive when known",
        )?;
        ensure(
            training.max_splats.is_none_or(|value| value > 0),
            "max_splats must be positive when known",
        )?;
        Ok(())
    }
}

fn ensure(condition: bool, technical: &str) -> AppResult<()> {
    if condition {
        Ok(())
    } else {
        Err(AppError::new(
            "E-1402",
            ErrorCategory::User,
            "Invalid Execution Profile",
            "The execution profile contains incompatible or invalid settings.",
        )
        .with_technical(technical)
        .with_suggestions(vec![
            "Run the engine checks again to create a compatible execution profile.",
        ]))
    }
}

fn not_ready(technical: &str) -> AppError {
    AppError::new(
        "E-1403",
        ErrorCategory::Environment,
        "Execution Profile Not Ready",
        "The required engine capabilities have not been verified.",
    )
    .with_technical(technical)
    .with_suggestions(vec![
        "Run the engine capability checks before starting or resuming training.",
    ])
}

fn invalid_json(technical: String) -> AppError {
    AppError::new(
        "E-1402",
        ErrorCategory::User,
        "Invalid Execution Profile",
        "The execution profile is not valid for this application.",
    )
    .with_technical(technical)
    .with_suggestions(vec![
        "Run the engine checks again to create a compatible execution profile.",
    ])
}

fn unsupported_version(version: u32) -> AppError {
    AppError::new(
        "E-1401",
        ErrorCategory::User,
        "Unsupported Execution Profile",
        "This execution profile uses an unsupported schema version.",
    )
    .with_technical(format!("execution profile schema_version={version}"))
    .with_suggestions(vec![
        "Open the project with a compatible application version.",
    ])
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

fn optional_text(value: &Option<String>, name: &str) -> AppResult<()> {
    ensure(
        value.as_ref().is_none_or(|text| valid_text(text)),
        &format!("{name} must be nonempty when present"),
    )
}

fn hex_digest(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn version_has_base(value: &str, expected: &str) -> bool {
    if let Some((base, build)) = value.split_once('+') {
        base == expected
            && build.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    } else {
        value == expected
    }
}

fn macos_version_supported(value: &str) -> bool {
    let components: Vec<_> = value.split('.').collect();
    (2..=3).contains(&components.len())
        && !components[0].starts_with('0')
        && components
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && components[0].parse::<u32>().is_ok_and(|major| major >= 15)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const MAC: &str = include_str!("../../../schemas/examples/execution-profile/macos.valid.json");
    const UNKNOWN: &str =
        include_str!("../../../schemas/examples/execution-profile/macos-unknown.valid.json");
    const WINDOWS: &str =
        include_str!("../../../schemas/examples/execution-profile/windows-legacy.valid.json");
    const MAC_PATCHED: &str =
        include_str!("../../../schemas/examples/execution-profile/macos-patched.valid.json");

    fn mac() -> ExecutionProfile {
        ExecutionProfile::from_json(MAC.as_bytes()).unwrap()
    }

    #[test]
    fn accepted_json_fixtures_round_trip_without_changing_project_schema() {
        for fixture in [
            MAC,
            UNKNOWN,
            WINDOWS,
            MAC_PATCHED,
            include_str!("../../../schemas/examples/execution-profile/windows1-dx12.valid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-vulkan.valid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-unknown.valid.json"),
        ] {
            let profile: ExecutionProfile = serde_json::from_str(fixture).unwrap();
            profile.validate().unwrap();
            let serialized = serde_json::to_vec(&profile).unwrap();
            assert_eq!(ExecutionProfile::from_json(&serialized).unwrap(), profile);
            assert_eq!(profile.schema_version, EXECUTION_PROFILE_SCHEMA_VERSION);
        }
        let project: crate::Project =
            serde_json::from_str(include_str!("../../../schemas/examples/project.valid.json"))
                .unwrap();
        assert_eq!(project.schema_version, 1);
    }

    #[test]
    fn schema_rejected_fixtures_are_also_rejected_by_rust_loading() {
        let fixtures = [
            include_str!("../../../schemas/examples/execution-profile/windows1-metal.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-wrong-architecture.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-stock.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-wrong-source.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-driver-evidence.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-mismatched-backend.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-missing-resource.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-lod.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-unknown-capability.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-cpu-colmap.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/windows1-gpu-positioning.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/future-version.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/macos-cuda.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/macos-gpu-positioning.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/macos-legacy-probe.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/bad-sha256.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/zero-budget.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/wrong-architecture.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/wrong-brush-version.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/missing-mac-resource-limit.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/unknown-capability-value.invalid.json"),
            include_str!("../../../schemas/examples/execution-profile/wrong-observed-backend.invalid.json"),
        ];
        for fixture in fixtures {
            assert!(serde_json::from_str::<ExecutionProfile>(fixture).is_err());
            assert!(ExecutionProfile::from_json(fixture.as_bytes()).is_err());
        }
    }

    #[test]
    fn future_schema_is_rejected_without_mutating_input() {
        let mut input: Value = serde_json::from_str(MAC).unwrap();
        input["schema_version"] = json!(2);
        let bytes = serde_json::to_vec(&input).unwrap();
        let before = bytes.clone();
        assert_eq!(
            ExecutionProfile::from_json(&bytes).unwrap_err().code,
            "E-1401"
        );
        assert_eq!(before, bytes);
        // Future versions may replace all v1 fields; reject the version first.
        assert_eq!(
            ExecutionProfile::from_json(br#"{"schema_version":2,"future_contract":true}"#)
                .unwrap_err()
                .code,
            "E-1401"
        );
    }

    #[test]
    fn absent_features_and_probe_device_are_unknown_not_success() {
        let profile = ExecutionProfile::from_json(UNKNOWN.as_bytes()).unwrap();
        assert_eq!(profile.brush.live_preview, CapabilityStatus::Unknown);
        assert_eq!(profile.brush.ply_warm_start, CapabilityStatus::Unknown);
        assert!(profile.brush.probe_result.device_name.is_none());
        assert!(profile.memory.available_working_set_bytes.is_none());
        assert_eq!(profile.validate_for_execution().unwrap_err().code, "E-1403");
    }

    #[test]
    fn driver_probe_preserves_windows_legacy_without_inventing_wgpu_backend() {
        let profile = ExecutionProfile::from_json(WINDOWS.as_bytes()).unwrap();
        assert!(profile.engines.brush.source_commit.is_none());
        assert_eq!(profile.brush.backend, BrushBackend::LegacyDefault);
        assert!(profile.brush.probe_result.backend.is_none());
        assert!(profile.effective_training.max_splats.is_none());
        assert!(profile
            .effective_training
            .image_cache_budget_bytes
            .is_none());
        // Dedicated VRAM may exceed system RAM; they are separate resource pools.
        profile.validate_for_execution().unwrap();
    }

    #[test]
    fn mac_execution_requires_successful_actual_metal_device_evidence() {
        mac().validate_for_execution().unwrap();
        for status in [
            CapabilityStatus::Unknown,
            CapabilityStatus::Unsupported,
            CapabilityStatus::Failed,
        ] {
            let mut profile = mac();
            profile.brush.probe_result.status = status;
            profile.validate().unwrap();
            assert_eq!(profile.validate_for_execution().unwrap_err().code, "E-1403");
        }
        let mut profile = mac();
        profile.brush.probe_result.device_name = None;
        profile.validate().unwrap();
        assert!(profile.validate_for_execution().is_err());
        profile.brush.probe_result.device_name = Some("fixture device".into());
        profile.brush.probe_result.backend = None;
        assert!(profile.validate_for_execution().is_err());
    }

    #[test]
    fn explicitly_selected_windows_backend_requires_real_compute_evidence() {
        let mut profile = ExecutionProfile::from_json(WINDOWS.as_bytes()).unwrap();
        profile.brush.backend = BrushBackend::Dx12;
        assert!(profile.validate().is_err());
        profile.brush.probe_result.kind = ProbeKind::ComputeSmoke;
        profile.validate().unwrap();
        assert!(profile.validate_for_execution().is_err());
        profile.brush.probe_result.backend = Some(BrushBackend::Dx12);
        profile.brush.probe_result.device_name = Some("fixture GPU".into());
        profile.validate_for_execution().unwrap();
    }

    #[test]
    fn live_and_model_only_resume_require_separate_capabilities() {
        let mut profile = mac();
        profile.live_protocol = LiveProtocol::PlyRequestAckV1;
        profile.validate().unwrap();
        assert!(profile.validate_for_execution().is_err());
        profile.brush.live_preview = CapabilityStatus::Supported;
        profile.validate_for_execution().unwrap();
        profile.resume_mode = ResumeMode::PlyWarmStartOptimizerReset;
        assert!(profile.validate_for_execution().is_err());
        profile.brush.ply_warm_start = CapabilityStatus::Supported;
        profile.validate_for_execution().unwrap();
    }

    #[test]
    fn rejects_resource_overcommit_and_zero_or_invalid_parameters() {
        let mut profile = mac();
        profile.effective_training.image_cache_budget_bytes = Some(9 * 1024 * 1024 * 1024);
        assert!(profile.validate().is_err());
        profile = mac();
        profile.memory.training_budget_bytes = Some(12 * 1024 * 1024 * 1024);
        assert!(profile.validate().is_err());
        profile.memory.available_working_set_bytes = None;
        profile.memory.training_budget_bytes = Some(20 * 1024 * 1024 * 1024);
        assert!(profile.validate().is_err());
        for (key, value) in [
            ("iterations", 0),
            ("threads", 0),
            ("resolution", 0),
            ("max_splats", 0),
            ("sh_degree", 4),
            ("lod_levels", 1),
        ] {
            let mut input: Value = serde_json::from_str(MAC).unwrap();
            input["effective_training"][key] = json!(value);
            assert!(
                serde_json::from_value::<ExecutionProfile>(input).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn rejects_invalid_identity_and_incompatible_platform_data() {
        let mut input: Value = serde_json::from_str(MAC).unwrap();
        for (field, value) in [
            ("source_commit", "short"),
            ("binary_sha256", "a"),
            ("version", " "),
        ] {
            input["engines"]["brush"][field] = json!(value);
            assert!(serde_json::from_value::<ExecutionProfile>(input.clone()).is_err());
            input = serde_json::from_str(MAC).unwrap();
        }
        input["run_id"] = json!("00000000-0000-0000-0000-000000000000");
        assert!(serde_json::from_value::<ExecutionProfile>(input).is_err());
        let mut profile = mac();
        profile.os_version = "14.7".into();
        assert!(profile.validate().is_err());
        profile = mac();
        profile.memory.kind = MemoryKind::Dedicated;
        assert!(profile.validate().is_err());
    }

    #[test]
    fn engine_build_metadata_preserves_the_pinned_cli_base_version() {
        ExecutionProfile::from_json(MAC_PATCHED.as_bytes())
            .unwrap()
            .validate_for_execution()
            .unwrap();
        for version in [
            "1.0.1",
            "1.0.0-dev",
            "1.0.0+",
            "1.0.0+bad..metadata",
            "1.0.0+has space",
        ] {
            let mut profile = mac();
            profile.engines.brush.version = version.into();
            assert!(profile.validate().is_err(), "{version}");
        }
    }
}

#[cfg(test)]
mod windows1_tests {
    use super::*;
    #[test]
    fn windows1_requires_successful_compute_and_device_identity() {
        for bytes in [
            include_bytes!("../../../schemas/examples/execution-profile/windows1-dx12.valid.json")
                .as_slice(),
            include_bytes!(
                "../../../schemas/examples/execution-profile/windows1-vulkan.valid.json"
            )
            .as_slice(),
        ] {
            let mut profile = ExecutionProfile::from_json(bytes).unwrap();
            profile.validate_for_execution().unwrap();
            profile.brush.probe_result.device_id = None;
            profile.validate().unwrap();
            assert!(profile.validate_for_execution().is_err());
        }
        let profile = ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/windows1-unknown.valid.json"
        ))
        .unwrap();
        assert!(profile.validate_for_execution().is_err());
    }
}
