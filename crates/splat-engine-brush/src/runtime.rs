//! Machine-readable training capability checks. Backend support is established
//! only by the engine's real Gaussian forward/backward test, never OS branding.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use splat_domain::runtime::{
    BrushBackend, BrushCliProfile, CapabilityStatus, LiveProtocol, ProbeKind, ResumeMode,
    RuntimePlatform, TrainingProbe,
};
use splat_domain::{AppError, AppResult, ErrorCategory};
use splat_process::{CapturedProcessResult, CommandSpec, ProcessRunner};
use tokio_util::sync::CancellationToken;

const SOURCE_COMMIT: &str = "1388f74c6fe0236f68ee4915564bf00e9d2e3747";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrushMachineIdentity {
    pub schema_version: u32,
    pub engine: String,
    pub engine_version: String,
    pub source_commit: String,
    pub build_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushCapabilities {
    #[serde(flatten)]
    pub identity: BrushMachineIdentity,
    pub cli_profile: BrushCliProfile,
    pub target: String,
    pub supported_features: Vec<String>,
    pub live_protocol: LiveProtocol,
    pub resume_mode: ResumeMode,
}

impl BrushCapabilities {
    pub fn supports(&self, feature: &str) -> bool {
        self.supported_features.iter().any(|value| value == feature)
    }

    pub fn from_json(bytes: &[u8]) -> AppResult<Self> {
        let capabilities: Self =
            serde_json::from_slice(bytes).map_err(|_| probe_error("invalid capabilities JSON"))?;
        validate_identity(&capabilities.identity)?;
        if capabilities.cli_profile != BrushCliProfile::Metorigin1
            || !matches!(
                capabilities.target.as_str(),
                "aarch64-apple-darwin" | "x86_64-pc-windows-msvc"
            )
            || !capabilities.supports("compute_probe")
            || !capabilities.supports("capabilities_json")
            || !capabilities.supports("ply_checkpoint")
        {
            return Err(probe_error(
                "unsupported target, CLI profile or capability set",
            ));
        }
        if capabilities.target == "x86_64-pc-windows-msvc"
            && (capabilities.identity.build_id != "metorigin-windows.1"
                || !capabilities.supports("backend_device_selection"))
        {
            return Err(probe_error(
                "Windows requires the pinned build and explicit backend/device selection",
            ));
        }
        Ok(capabilities)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushComputeEvidence {
    pub gaussian_count: u32,
    pub width: u32,
    pub height: u32,
    pub forward_finite: bool,
    pub gradient_finite: bool,
    pub loss: f64,
    pub gradient_l1: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrushComputeProbe {
    #[serde(flatten)]
    pub identity: BrushMachineIdentity,
    pub probe_kind: ProbeKind,
    pub status: CapabilityStatus,
    pub backend: Option<BrushBackend>,
    pub device_name: Option<String>,
    pub device_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub compute: Option<BrushComputeEvidence>,
}

impl BrushComputeProbe {
    pub fn from_json(bytes: &[u8], capabilities: &BrushCapabilities) -> AppResult<Self> {
        let probe: Self =
            serde_json::from_slice(bytes).map_err(|_| probe_error("invalid compute probe JSON"))?;
        validate_identity(&probe.identity)?;
        let valid_compute = probe.compute.as_ref().is_some_and(|compute| {
            compute.gaussian_count == 8
                && compute.width == 32
                && compute.height == 32
                && compute.forward_finite
                && compute.gradient_finite
                && compute.loss.is_finite()
                && compute.loss >= 0.0
                && compute.gradient_l1.is_finite()
                && compute.gradient_l1 > 0.0
        });
        let valid_device = probe.device_name.as_deref().is_some_and(|name| {
            !name.trim().is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
        });
        let windows = capabilities.target == "x86_64-pc-windows-msvc";
        let backend_matches = if windows {
            matches!(
                probe.backend,
                Some(BrushBackend::Dx12 | BrushBackend::Vulkan)
            ) && probe.device_type.as_deref() == Some("DiscreteGpu")
                && probe
                    .device_id
                    .as_deref()
                    .is_some_and(|id| valid_device_id(id, probe.backend))
        } else {
            probe.backend == Some(BrushBackend::Metal)
        };
        if probe.identity != capabilities.identity
            || probe.probe_kind != ProbeKind::ComputeSmoke
            || probe.status != CapabilityStatus::Supported
            || !backend_matches
            || !valid_device
            || !valid_compute
        {
            return Err(probe_error(
                "Gaussian compute evidence or engine identity did not match",
            ));
        }
        Ok(probe)
    }

    pub fn training_probe(&self) -> TrainingProbe {
        TrainingProbe {
            kind: self.probe_kind,
            status: self.status,
            backend: self.backend,
            device_name: self.device_name.clone(),
            device_id: self.device_id.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct VerifiedBrushRuntime {
    pub capabilities: BrushCapabilities,
    pub probe: BrushComputeProbe,
    pub binary_sha256: String,
    pub dependency_sha256: std::collections::BTreeMap<String, String>,
}

impl VerifiedBrushRuntime {
    /// Evidence is never a cache: each launch probes again, and these checks
    /// close the window between that probe and constructing the training command.
    pub fn verify_files_unchanged(&self, brush: &Path) -> AppResult<()> {
        if hash_binary(brush)? != self.binary_sha256
            || dependency_snapshot(brush)? != self.dependency_sha256
        {
            return Err(probe_error(
                "Brush executable or dependencies changed after compute verification",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrushBackendPreference {
    #[default]
    Auto,
    Dx12,
    Vulkan,
}

#[derive(Debug, Clone)]
pub enum TrainingRuntimeEvidence {
    LegacyNvidia(crate::NvidiaSmiInfo),
    Metal(Box<VerifiedBrushRuntime>),
    WindowsWgpu(Box<VerifiedBrushRuntime>),
}

impl TrainingRuntimeEvidence {
    pub fn summary(&self) -> String {
        match self {
            Self::LegacyNvidia(info) => {
                format!("{} · 旧版引擎：仅驱动检查，未验证 GPU 计算", info.summary())
            }
            Self::WindowsWgpu(runtime) => format!(
                "{} · {:?} · Gaussian 渲染与反向传播检查通过",
                runtime.probe.device_name.as_deref().unwrap_or("GPU"),
                runtime.probe.backend.unwrap_or(BrushBackend::LegacyDefault)
            ),
            Self::Metal(runtime) => format!(
                "{} · Metal · Gaussian 渲染与反向传播检查通过",
                runtime.probe.device_name.as_deref().unwrap_or("GPU")
            ),
        }
    }

    pub fn training_probe(&self) -> TrainingProbe {
        match self {
            Self::LegacyNvidia(info) => TrainingProbe {
                kind: ProbeKind::LegacyNvidiaDriver,
                status: CapabilityStatus::Supported,
                backend: None,
                device_name: Some(info.gpu_name.clone()),
                device_id: None,
            },
            Self::Metal(runtime) | Self::WindowsWgpu(runtime) => runtime.probe.training_probe(),
        }
    }
}

pub fn current_runtime_platform() -> AppResult<RuntimePlatform> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok(RuntimePlatform::Macos),
        ("windows", "x86_64") => Ok(RuntimePlatform::Windows),
        _ => Err(probe_error("unsupported training platform or architecture")),
    }
}

/// Selection recorded by the Windows probe and passed unchanged to training.
/// The initial probe may omit device_id; training and repeat probes may not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrushDeviceSelection {
    pub backend: BrushBackend,
    pub device_id: Option<String>,
}

impl BrushDeviceSelection {
    pub fn for_profile(profile: &splat_domain::ExecutionProfile) -> AppResult<Option<Self>> {
        if profile.platform != RuntimePlatform::Windows
            || profile.brush.cli_profile != BrushCliProfile::Metorigin1
        {
            return Ok(None);
        }
        profile.validate_for_execution()?;
        Ok(Some(Self {
            backend: profile.brush.backend,
            device_id: profile.brush.probe_result.device_id.clone(),
        }))
    }

    pub(crate) fn arguments(&self) -> AppResult<Vec<String>> {
        let backend = match self.backend {
            BrushBackend::Dx12 => "dx12",
            BrushBackend::Vulkan => "vulkan",
            _ => return Err(probe_error("unsupported Windows graphics backend")),
        };
        let mut args = vec!["--graphics-backend".into(), backend.into()];
        if let Some(id) = &self.device_id {
            if !valid_device_id(id, Some(self.backend)) {
                return Err(probe_error("invalid Windows adapter identity"));
            }
            args.extend(["--graphics-device".into(), id.clone()]);
        }
        Ok(args)
    }
}

fn windows_selection(
    backend: Result<String, std::env::VarError>,
    device_id: Result<String, std::env::VarError>,
) -> AppResult<BrushDeviceSelection> {
    let backend = match backend.as_deref() {
        Ok("dx12") | Err(std::env::VarError::NotPresent) => BrushBackend::Dx12,
        Ok("vulkan") => BrushBackend::Vulkan,
        Ok(_) => return Err(selection_error("unsupported Windows graphics backend")),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(selection_error(
                "Windows graphics backend must be valid Unicode",
            ))
        }
    };
    let device_id = match device_id {
        Ok(id) => Some(id),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(selection_error(
                "Windows adapter identity must be valid Unicode",
            ))
        }
    };
    let selection = BrushDeviceSelection { backend, device_id };
    selection
        .arguments()
        .map_err(|_| selection_error("invalid Windows adapter identity"))?;
    Ok(selection)
}

fn windows_candidates(
    backend: Result<String, std::env::VarError>,
    device: Result<String, std::env::VarError>,
    preference: BrushBackendPreference,
) -> AppResult<Vec<BrushDeviceSelection>> {
    let backend = match backend {
        Err(std::env::VarError::NotPresent) => Ok(match preference {
            BrushBackendPreference::Auto => "auto",
            BrushBackendPreference::Dx12 => "dx12",
            BrushBackendPreference::Vulkan => "vulkan",
        }
        .to_string()),
        value => value,
    };
    if backend.as_deref() == Ok("auto") {
        if !matches!(device, Err(std::env::VarError::NotPresent)) {
            return Err(selection_error(
                "An explicit adapter requires an explicit graphics backend",
            ));
        }
        Ok(vec![
            BrushDeviceSelection {
                backend: BrushBackend::Dx12,
                device_id: None,
            },
            BrushDeviceSelection {
                backend: BrushBackend::Vulkan,
                device_id: None,
            },
        ])
    } else {
        Ok(vec![windows_selection(backend, device)?])
    }
}

fn selection_error(detail: &str) -> AppError {
    AppError::new(
        "E-5005",
        ErrorCategory::Environment,
        "训练后端配置无效",
        "应用的高级训练配置无效。请移除自定义启动配置后重新检查。",
    )
    .with_technical(detail)
    .retryable(true)
}

fn validate_legacy_selection(
    backend: Result<String, std::env::VarError>,
    device: Result<String, std::env::VarError>,
    preference: BrushBackendPreference,
) -> AppResult<()> {
    // Driver-only compatibility cannot satisfy an explicit graphics API or
    // adapter request. Validate overrides even when no machine probe is run.
    if windows_candidates(backend, device, preference)?.len() != 2 {
        return Err(AppError::new(
            "E-5005", ErrorCategory::Environment,
            "旧版引擎不支持后端选择",
            "当前旧版 Brush 不支持指定图形后端或设备。请改用支持真实计算预检的配套引擎；如需旧版兼容模式，请选择“自动”并移除后端和设备启动覆盖。",
        ).with_technical("Legacy Brush does not support explicit Windows graphics backend/device selection").retryable(true));
    }
    Ok(())
}

fn validate_frozen_override(
    frozen: &BrushDeviceSelection,
    backend: Result<String, std::env::VarError>,
    device: Result<String, std::env::VarError>,
) -> AppResult<()> {
    if matches!(backend, Err(std::env::VarError::NotPresent))
        && matches!(device, Err(std::env::VarError::NotPresent))
    {
        return Ok(());
    }
    let candidates = windows_candidates(backend, device, BrushBackendPreference::Auto)?;
    if candidates.len() == 1
        && (candidates[0].backend != frozen.backend
            || candidates[0]
                .device_id
                .as_ref()
                .is_some_and(|id| Some(id) != frozen.device_id.as_ref()))
    {
        return Err(selection_error(
            "Explicit backend/device override conflicts with the frozen project selection",
        ));
    }
    Ok(())
}

fn valid_device_id(id: &str, backend: Option<BrushBackend>) -> bool {
    let expected = match backend {
        Some(BrushBackend::Dx12) => "dx12",
        Some(BrushBackend::Vulkan) => "vulkan",
        _ => return false,
    };
    let parts: Vec<_> = id.split(':').collect();
    parts.len() == 4
        && parts[0] == expected
        && parts[1].len() == 8
        && parts[2].len() == 8
        && !parts[3].is_empty()
        && parts[3].len() <= 512
        && parts[3].len().is_multiple_of(2)
        && parts[1..]
            .iter()
            .all(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Shared preflight. Windows 0.3 retains its driver-only compatibility evidence;
/// Windows 1 tries DX12 then Vulkan, each with an independent real compute check.
/// Explicit and frozen selections never allow a backend switch.
pub async fn probe_training_runtime(
    platform: RuntimePlatform,
    brush: &Path,
    log_dir: &Path,
    cancellation: CancellationToken,
) -> AppResult<TrainingRuntimeEvidence> {
    probe_training_runtime_with_selection(platform, brush, log_dir, cancellation, None).await
}

pub async fn probe_training_runtime_with_selection(
    platform: RuntimePlatform,
    brush: &Path,
    log_dir: &Path,
    cancellation: CancellationToken,
    selection: Option<&BrushDeviceSelection>,
) -> AppResult<TrainingRuntimeEvidence> {
    probe_runtime(
        platform,
        brush,
        log_dir,
        cancellation,
        selection,
        BrushBackendPreference::Auto,
    )
    .await
}

pub async fn probe_training_runtime_with_preference(
    platform: RuntimePlatform,
    brush: &Path,
    log_dir: &Path,
    cancellation: CancellationToken,
    preference: BrushBackendPreference,
) -> AppResult<TrainingRuntimeEvidence> {
    probe_runtime(platform, brush, log_dir, cancellation, None, preference).await
}

async fn probe_runtime(
    platform: RuntimePlatform,
    brush: &Path,
    log_dir: &Path,
    cancellation: CancellationToken,
    selection: Option<&BrushDeviceSelection>,
    preference: BrushBackendPreference,
) -> AppResult<TrainingRuntimeEvidence> {
    std::fs::create_dir_all(log_dir)
        .map_err(|_| probe_error("could not create probe log directory"))?;
    let before = hash_binary(brush)?;
    let dependencies = dependency_snapshot(brush)?;
    let file_diagnostic = serde_json::json!({
        "schema_version": 1, "stage": "file_integrity", "executable": brush,
        "executable_sha256": before, "dependencies_sha256": dependencies,
        "os": std::env::consts::OS, "architecture": std::env::consts::ARCH,
    });
    std::fs::write(
        log_dir.join(format!("runtime-files-{}.json", uuid::Uuid::now_v7())),
        serde_json::to_vec_pretty(&file_diagnostic).unwrap(),
    )
    .map_err(|_| probe_error("Could not save runtime file diagnostics"))?;
    let mut reported_version = None;
    if platform == RuntimePlatform::Windows {
        // A broken 1.x machine command must never fall back to driver evidence.
        let version =
            machine_command(brush, "--version", &[], log_dir, cancellation.clone()).await?;
        let version = std::str::from_utf8(&version)
            .map_err(|_| probe_error("invalid Brush version output"))?;
        reported_version = version
            .split_whitespace()
            .find(|token| {
                token
                    .trim_start_matches('v')
                    .starts_with(|c: char| c.is_ascii_digit())
            })
            .map(|token| token.trim_start_matches('v').to_string());
        match crate::adapter::cli_profile_from_version(version)? {
            BrushCliProfile::Legacy03 => {
                validate_legacy_selection(
                    std::env::var("METORIGIN_BRUSH_BACKEND"),
                    std::env::var("METORIGIN_BRUSH_DEVICE_ID"),
                    preference,
                )?;
                if selection.is_some() {
                    return Err(probe_error(
                        "A frozen Windows Brush 1 selection cannot use a legacy engine",
                    ));
                }
                if cancellation.is_cancelled() {
                    return Err(probe_error("GPU compute verification was cancelled"));
                }
                let info = tokio::task::spawn_blocking(crate::require_nvidia_smi)
                    .await
                    .map_err(|_| probe_error("NVIDIA driver check task failed"))??;
                if before != hash_binary(brush)? {
                    return Err(probe_error("Brush executable changed during preflight"));
                }
                if cancellation.is_cancelled() {
                    return Err(probe_error("GPU compute verification was cancelled"));
                }
                return Ok(TrainingRuntimeEvidence::LegacyNvidia(info));
            }
            BrushCliProfile::Metorigin1 => {}
        }
    }
    let capabilities_json = machine_command(
        brush,
        "--capabilities-json",
        &[],
        log_dir,
        cancellation.clone(),
    )
    .await?;
    let capabilities = BrushCapabilities::from_json(&capabilities_json)?;
    if platform == RuntimePlatform::Windows
        && reported_version.as_deref() != Some(capabilities.identity.engine_version.as_str())
    {
        return Err(probe_error(
            "Brush version and machine capability identities disagree",
        ));
    }
    let expected_target = match platform {
        RuntimePlatform::Macos => "aarch64-apple-darwin",
        RuntimePlatform::Windows => "x86_64-pc-windows-msvc",
    };
    if capabilities.target != expected_target {
        return Err(probe_error(
            "Brush target does not match the training platform",
        ));
    }
    if platform == RuntimePlatform::Windows
        && !(cfg!(test)
            && brush
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd")))
    {
        verify_windows_dependencies(&dependencies)?;
        verify_build_receipt(brush, &before, &dependencies)?;
    }
    let candidates = if platform == RuntimePlatform::Windows {
        if let Some(selection) = selection {
            validate_frozen_override(
                selection,
                std::env::var("METORIGIN_BRUSH_BACKEND"),
                std::env::var("METORIGIN_BRUSH_DEVICE_ID"),
            )?;
            vec![Some(selection.clone())]
        } else {
            windows_candidates(
                std::env::var("METORIGIN_BRUSH_BACKEND"),
                std::env::var("METORIGIN_BRUSH_DEVICE_ID"),
                preference,
            )?
            .into_iter()
            .map(Some)
            .collect()
        }
    } else {
        vec![None]
    };
    let mut failures = Vec::new();
    let mut verified_probe = None;
    for (index, selection) in candidates.iter().enumerate() {
        if cancellation.is_cancelled() {
            return Err(probe_error("GPU compute verification was cancelled"));
        }
        let arguments = selection
            .as_ref()
            .map(BrushDeviceSelection::arguments)
            .transpose()?
            .unwrap_or_default();
        let captured = capture_machine_command(
            brush,
            "--probe-json",
            &arguments,
            log_dir,
            cancellation.clone(),
        )
        .await?;
        // ProcessRunner has awaited its lifecycle receipt (including timeout
        // termination). Cleanup failure is an Err and cannot reach fallback.
        let outcome = classify_probe(&captured, &capabilities, selection.as_ref());
        let report_path = log_dir.join(format!("compute-attempt-{}.json", uuid::Uuid::now_v7()));
        let report = serde_json::json!({
            "schema_version": 1, "executable": brush, "executable_sha256": before,
            "dependencies_sha256": dependencies, "requested_arguments": arguments,
            "exit_code": captured.process.exit_code, "timed_out": captured.process.timed_out,
            "cancelled": captured.process.cancelled, "process_log": captured.process.log_path,
            "stdout": String::from_utf8_lossy(&captured.stdout),
            "stderr": String::from_utf8_lossy(&captured.stderr),
            "os": std::env::consts::OS, "architecture": std::env::consts::ARCH,
            "previous_failed_attempts": failures,
        });
        std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap())
            .map_err(|_| probe_error("Could not save compute attempt diagnostics"))?;
        if before != hash_binary(brush)? || dependencies != dependency_snapshot(brush)? {
            return Err(probe_error(
                "Brush executable or dependencies changed during preflight",
            ));
        }
        match outcome {
            Ok(probe) => {
                verified_probe = Some(probe);
                break;
            }
            Err((error, retry_backend)) => {
                failures.push(format!(
                    "{:?}: {}; diagnostic={}",
                    selection.as_ref().map(|s| s.backend),
                    error.technical_message.as_deref().unwrap_or(&error.code),
                    report_path.display()
                ));
                if !retry_backend || index + 1 == candidates.len() || cancellation.is_cancelled() {
                    return Err(probe_error(&failures.join("\n")));
                }
            }
        }
    }
    let probe = verified_probe.ok_or_else(|| probe_error("No compute probe succeeded"))?;
    let after = hash_binary(brush)?;
    if before != after {
        return Err(probe_error("Brush executable changed during preflight"));
    }
    let runtime = Box::new(VerifiedBrushRuntime {
        capabilities,
        probe,
        binary_sha256: after,
        dependency_sha256: dependencies,
    });
    Ok(match platform {
        RuntimePlatform::Macos => TrainingRuntimeEvidence::Metal(runtime),
        RuntimePlatform::Windows => TrainingRuntimeEvidence::WindowsWgpu(runtime),
    })
}

async fn machine_command(
    brush: &Path,
    argument: &str,
    extra_args: &[String],
    log_dir: &Path,
    cancellation: CancellationToken,
) -> AppResult<Vec<u8>> {
    let captured =
        capture_machine_command(brush, argument, extra_args, log_dir, cancellation).await?;
    if !captured.process.is_success() {
        return Err(probe_error(&format!(
            "{argument}: exit={:?}, timed_out={}, cancelled={}, log={:?}",
            captured.process.exit_code,
            captured.process.timed_out,
            captured.process.cancelled,
            captured.process.log_path
        )));
    }
    Ok(captured.stdout)
}

async fn capture_machine_command(
    brush: &Path,
    argument: &str,
    extra_args: &[String],
    log_dir: &Path,
    cancellation: CancellationToken,
) -> AppResult<CapturedProcessResult> {
    if cancellation.is_cancelled() {
        return Err(probe_error("GPU compute verification was cancelled"));
    }
    let mut args = vec![argument.to_string()];
    args.extend_from_slice(extra_args);
    let spec = CommandSpec::new(
        brush,
        args,
        log_dir.join(format!(
            "{}-{}.log",
            argument.trim_start_matches('-'),
            uuid::Uuid::now_v7()
        )),
    )
    .with_timeout(Duration::from_secs(if argument == "--probe-json" {
        120
    } else {
        15
    }));
    ProcessRunner::new()
        .run_to_completion_capture(spec, cancellation, 256 * 1024)
        .await
}

pub(crate) fn hash_binary(path: &Path) -> AppResult<String> {
    let mut file =
        std::fs::File::open(path).map_err(|_| probe_error("Brush binary could not be read"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| probe_error("Brush binary hashing failed"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn dependency_snapshot(brush: &Path) -> AppResult<std::collections::BTreeMap<String, String>> {
    let mut snapshot = std::collections::BTreeMap::new();
    let directory = brush
        .parent()
        .ok_or_else(|| probe_error("Brush directory is unavailable"))?;
    for name in ["dxcompiler.dll", "dxil.dll"] {
        let path = directory.join(name);
        if path.exists() {
            snapshot.insert(name.to_string(), hash_binary(&path)?);
        }
    }
    // The macOS packer flattens all non-system Mach-O dependencies into the
    // engine's lib directory. Bind those bytes too; system Metal/driver updates
    // are validated by each fresh compute probe, not a cached success receipt.
    for relative in ["", "../lib/"] {
        let folder = directory.join(relative);
        let entries = match std::fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                return Err(probe_error(
                    "Could not inventory packaged runtime dependencies",
                ))
            }
        };
        for entry in entries {
            let entry =
                entry.map_err(|_| probe_error("Could not read packaged dependency entry"))?;
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("dylib"))
            {
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| probe_error("Packaged dependency filename is invalid"))?;
                snapshot.insert(format!("{relative}{name}"), hash_binary(&entry.path())?);
            }
        }
    }
    let receipt = directory.join("../BUILD-INFO.json");
    if receipt.is_file() {
        snapshot.insert("../BUILD-INFO.json".into(), hash_binary(&receipt)?);
    }
    Ok(snapshot)
}

fn verify_build_receipt(
    brush: &Path,
    binary_sha256: &str,
    dependencies: &std::collections::BTreeMap<String, String>,
) -> AppResult<()> {
    let receipt = brush.parent().unwrap().join("../BUILD-INFO.json");
    if !receipt.is_file() {
        return Err(probe_error("Windows Brush 1 requires its paired BUILD-INFO.json source identity and checksum receipt"));
    }
    let bytes =
        std::fs::read(receipt).map_err(|_| probe_error("Brush build receipt could not be read"))?;
    let receipt: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| probe_error("Brush build receipt is invalid"))?;
    validate_build_receipt(&receipt, binary_sha256, dependencies)
}

fn validate_build_receipt(
    receipt: &serde_json::Value,
    binary_sha256: &str,
    dependencies: &std::collections::BTreeMap<String, String>,
) -> AppResult<()> {
    let lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../integrations/brush-windows/source-lock.json"
    )))
    .unwrap();
    // Compatibility is limited to the exact previously shipped source recipe,
    // not arbitrary recipes that happen to claim the same upstream commit.
    let legacy_lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../integrations/brush-windows/source-lock.windows1-legacy.json"
    )))
    .unwrap();
    if receipt["schema_version"] != 1
        || (receipt["inputs"]["lock"] != lock && receipt["inputs"]["lock"] != legacy_lock)
        || receipt["binary_sha256"].as_str() != Some(binary_sha256)
        || receipt["files"]["bin/brush-cli.exe"].as_str() != Some(binary_sha256)
        || ["dxcompiler.dll", "dxil.dll"].into_iter().any(|name| {
            receipt["files"][format!("bin/{name}")].as_str()
                != dependencies.get(name).map(String::as_str)
        })
    {
        return Err(probe_error(
            "Brush EXE/DXC build receipt checksum or source identity did not match",
        ));
    }
    Ok(())
}

fn verify_windows_dependencies(
    snapshot: &std::collections::BTreeMap<String, String>,
) -> AppResult<()> {
    let lock: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../integrations/brush-windows/source-lock.json"
    )))
    .map_err(|_| probe_error("Bundled Windows dependency source lock is invalid"))?;
    for name in ["dxcompiler.dll", "dxil.dll"] {
        let expected = lock["dxc"]["files"][format!("bin/{name}")]["sha256"]
            .as_str()
            .ok_or_else(|| probe_error("Bundled DXC checksum is unavailable"))?;
        if snapshot.get(name).map(String::as_str) != Some(expected) {
            return Err(probe_error(&format!(
                "DXC dependency {name} is missing or differs from its pinned source checksum"
            )));
        }
    }
    Ok(())
}

/// The second flag permits only backend computation failures to try another API.
/// Protocol, identity, configuration and process ownership errors fail closed.
fn classify_probe(
    captured: &CapturedProcessResult,
    capabilities: &BrushCapabilities,
    selection: Option<&BrushDeviceSelection>,
) -> Result<BrushComputeProbe, (AppError, bool)> {
    let reject = |detail: &str| (probe_error(detail), false);
    if captured.process.cancelled {
        return Err(reject("GPU compute verification was cancelled"));
    }
    if captured.process.timed_out {
        if !captured.stdout.is_empty() {
            return Err(reject(
                "Timed out probe emitted an incomplete terminal machine protocol",
            ));
        }
        return Err((
            probe_error("GPU compute verification timed out; process cleanup completed"),
            true,
        ));
    }
    if captured.process.is_success() {
        let probe =
            BrushComputeProbe::from_json(&captured.stdout, capabilities).map_err(|e| (e, false))?;
        if let Some(selection) = selection {
            if probe.backend != Some(selection.backend)
                || selection
                    .device_id
                    .as_ref()
                    .is_some_and(|id| Some(id) != probe.device_id.as_ref())
            {
                return Err(reject(
                    "Probe did not use the requested Windows backend/device",
                ));
            }
        }
        return Ok(probe);
    }
    // A nonzero exit alone is not evidence of a backend failure. Require the
    // exact failed machine contract from the same validated engine identity.
    let report: serde_json::Value = serde_json::from_slice(&captured.stdout)
        .map_err(|_| reject("Failed probe did not return valid machine JSON"))?;
    let identity: BrushMachineIdentity = serde_json::from_value(report.clone())
        .map_err(|_| reject("Failed probe omitted its engine identity"))?;
    validate_identity(&identity).map_err(|e| (e, false))?;
    let diagnostics = capabilities.supports("probe_diagnostics_v1");
    let valid_kind = match report["error"].get("kind") {
        None => !diagnostics,
        Some(kind) => kind.as_str() == Some("backend_compute"),
    };
    let valid_stage = !diagnostics
        || report["failure_stage"].as_str().is_some_and(|stage| {
            !stage.is_empty()
                && stage.len() <= 64
                && stage
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        });
    if identity != capabilities.identity
        || captured.process.exit_code != Some(1)
        || report["probe_kind"] != "compute_smoke"
        || report["status"] != "failed"
        || report["error"]["code"] != "BRUSH_GPU_PROBE_FAILED"
        || !valid_kind
        || !valid_stage
        || (!report["backend"].is_null() && !report["backend"].is_string())
        || report["backend"].as_str().is_some_and(|backend| {
            selection.is_some_and(|s| {
                backend
                    != match s.backend {
                        BrushBackend::Dx12 => "dx12",
                        BrushBackend::Vulkan => "vulkan",
                        _ => "metal",
                    }
            })
        })
    {
        return Err(reject(
            "Failed probe identity, selection or failure protocol did not match",
        ));
    }
    Err((probe_error("The selected backend failed the real Gaussian compute check; see the attempt diagnostic and process log"), true))
}

fn validate_identity(identity: &BrushMachineIdentity) -> AppResult<()> {
    if identity.schema_version != 1
        || identity.engine != "brush"
        || identity.source_commit != SOURCE_COMMIT
        || identity.build_id.is_empty()
        || identity.build_id.len() > 128
        || !identity
            .build_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        || identity.engine_version != format!("1.0.0+{}", identity.build_id)
    {
        return Err(probe_error("unsupported Brush machine identity"));
    }
    Ok(())
}

fn probe_error(detail: &str) -> AppError {
    AppError::new(
        "E-5004",
        ErrorCategory::Environment,
        "训练环境检查未通过",
        "无法确认当前引擎和 GPU 可完成训练计算。请检查引擎配置，并在诊断日志中查看详情。",
    )
    .with_technical(detail)
    .retryable(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn capabilities_json() -> Value {
        json!({
            "schema_version": 1, "engine": "brush",
            "engine_version": "1.0.0+metorigin-macos.2", "build_id": "metorigin-macos.2",
            "source_commit": SOURCE_COMMIT, "cli_profile": "metorigin_1",
            "target": "aarch64-apple-darwin",
            "supported_features": ["capabilities_json", "compute_probe", "ply_checkpoint", "ply_warm_start"],
            "live_protocol": "disabled", "resume_mode": "ply_warm_start_optimizer_reset"
        })
    }

    fn probe_json() -> Value {
        json!({
            "schema_version": 1, "engine": "brush",
            "engine_version": "1.0.0+metorigin-macos.2", "build_id": "metorigin-macos.2",
            "source_commit": SOURCE_COMMIT, "probe_kind": "compute_smoke", "status": "supported",
            "backend": "metal", "device_name": "Fixture GPU", "device_type": "IntegratedGpu",
            "compute": {"gaussian_count":8,"width":32,"height":32,
                "forward_finite":true,"gradient_finite":true,"loss":0.1,"gradient_l1":0.03}
        })
    }

    fn parse_probe(value: &Value) -> AppResult<BrushComputeProbe> {
        let caps = BrushCapabilities::from_json(&serde_json::to_vec(&capabilities_json()).unwrap())
            .unwrap();
        BrushComputeProbe::from_json(&serde_json::to_vec(value).unwrap(), &caps)
    }

    fn windows_capabilities() -> Value {
        let mut caps = capabilities_json();
        caps["engine_version"] = json!("1.0.0+metorigin-windows.1");
        caps["build_id"] = json!("metorigin-windows.1");
        caps["target"] = json!("x86_64-pc-windows-msvc");
        caps["supported_features"]
            .as_array_mut()
            .unwrap()
            .push(json!("backend_device_selection"));
        caps
    }

    fn windows_probe() -> Value {
        let mut probe = probe_json();
        probe["engine_version"] = json!("1.0.0+metorigin-windows.1");
        probe["build_id"] = json!("metorigin-windows.1");
        probe["backend"] = json!("dx12");
        probe["device_type"] = json!("DiscreteGpu");
        probe["device_id"] = json!("dx12:000010de:00001234:46697874757265");
        probe
    }

    fn failed_windows_probe() -> Value {
        let mut report = windows_probe();
        report["status"] = json!("failed");
        report["backend"] = Value::Null;
        report["device_name"] = Value::Null;
        report["compute"] = Value::Null;
        report["error"] = json!({"code":"BRUSH_GPU_PROBE_FAILED", "kind":"backend_compute"});
        report
    }

    fn captured(report: &Value, exit_code: i32) -> CapturedProcessResult {
        CapturedProcessResult {
            process: splat_process::ProcessResult {
                exit_code: Some(exit_code),
                cancelled: false,
                timed_out: false,
                duration_ms: 1,
                log_path: None,
            },
            stdout: serde_json::to_vec(report).unwrap(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn auto_is_distinct_from_explicit_backend_and_adapter() {
        let missing = || Err(std::env::VarError::NotPresent);
        let auto = windows_candidates(missing(), missing(), BrushBackendPreference::Auto).unwrap();
        assert_eq!(
            auto.iter().map(|s| s.backend).collect::<Vec<_>>(),
            [BrushBackend::Dx12, BrushBackend::Vulkan]
        );
        for (value, expected) in [
            ("dx12", BrushBackend::Dx12),
            ("vulkan", BrushBackend::Vulkan),
        ] {
            let candidates =
                windows_candidates(Ok(value.into()), missing(), BrushBackendPreference::Auto)
                    .unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].backend, expected);
        }
        assert_eq!(
            windows_candidates(missing(), missing(), BrushBackendPreference::Vulkan).unwrap()[0]
                .backend,
            BrushBackend::Vulkan
        );
        assert!(windows_candidates(
            Ok("auto".into()),
            Ok("dx12:000010de:00001234:46697874757265".into()),
            BrushBackendPreference::Auto
        )
        .is_err());
        let frozen = BrushDeviceSelection {
            backend: BrushBackend::Vulkan,
            device_id: Some("vulkan:000010de:00001234:46697874757265".into()),
        };
        assert!(validate_frozen_override(&frozen, Ok("dx12".into()), missing()).is_err());
        assert!(validate_frozen_override(&frozen, Ok("vulkan".into()), missing()).is_ok());
        assert!(validate_frozen_override(&frozen, Ok("auto".into()), missing()).is_ok());
    }

    #[test]
    fn legacy_driver_check_never_ignores_explicit_or_invalid_backend_configuration() {
        let evidence = TrainingRuntimeEvidence::LegacyNvidia(crate::NvidiaSmiInfo {
            gpu_name: "Fixture GPU".into(),
            driver_version: "fixture".into(),
            memory_total_bytes: 1,
        });
        assert!(evidence.summary().contains("仅驱动检查，未验证 GPU 计算"));
        assert_eq!(
            evidence.training_probe().kind,
            ProbeKind::LegacyNvidiaDriver
        );
        let missing = || Err(std::env::VarError::NotPresent);
        validate_legacy_selection(missing(), missing(), BrushBackendPreference::Auto).unwrap();
        // An explicit Auto environment override remains higher priority than
        // the new-project preference, including with the legacy engine.
        validate_legacy_selection(Ok("auto".into()), missing(), BrushBackendPreference::Vulkan)
            .unwrap();
        for preference in [BrushBackendPreference::Dx12, BrushBackendPreference::Vulkan] {
            let error = validate_legacy_selection(missing(), missing(), preference).unwrap_err();
            assert_eq!(error.code, "E-5005");
            assert_eq!(error.title, "旧版引擎不支持后端选择");
            assert!(error.user_message_zh().contains("配套引擎"));
            assert!(error.user_message_zh().contains("自动"));
        }
        assert_eq!(
            validate_legacy_selection(
                Ok("invalid".into()),
                missing(),
                BrushBackendPreference::Auto
            )
            .unwrap_err()
            .title,
            "训练后端配置无效"
        );
        for (backend, device) in [
            (Ok("dx12".into()), missing()),
            (Ok("vulkan".into()), missing()),
            (Ok("private-invalid".into()), missing()),
            (
                Err(std::env::VarError::NotUnicode("private-value".into())),
                missing(),
            ),
            (
                missing(),
                Ok("dx12:000010de:00001234:46697874757265".into()),
            ),
            (
                Ok("dx12".into()),
                Ok("dx12:000010de:00001234:46697874757265".into()),
            ),
            (
                missing(),
                Err(std::env::VarError::NotUnicode("private-value".into())),
            ),
        ] {
            let error = validate_legacy_selection(backend, device, BrushBackendPreference::Auto)
                .unwrap_err();
            assert_eq!(error.code, "E-5005");
            assert!(!error.user_message_zh().contains("private"));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn legacy_probe_rejects_explicit_api_before_driver_evidence_and_honors_precancellation() {
        let root = tempfile::tempdir().unwrap();
        let binary = root.path().join("legacy.cmd");
        std::fs::write(&binary, "@echo off\r\necho brush 0.3.0\r\nexit /b 0\r\n").unwrap();
        for preference in [BrushBackendPreference::Dx12, BrushBackendPreference::Vulkan] {
            let error = probe_runtime(
                RuntimePlatform::Windows,
                &binary,
                &root.path().join("logs"),
                CancellationToken::new(),
                None,
                preference,
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "E-5005");
        }
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = probe_runtime(
            RuntimePlatform::Windows,
            &binary,
            &root.path().join("logs"),
            cancellation,
            None,
            BrushBackendPreference::Auto,
        )
        .await
        .unwrap_err();
        assert!(error
            .technical_message
            .as_deref()
            .unwrap()
            .contains("cancelled"));
    }

    #[test]
    fn fallback_requires_backend_failure_and_matching_identity_protocol() {
        let caps =
            BrushCapabilities::from_json(&serde_json::to_vec(&windows_capabilities()).unwrap())
                .unwrap();
        let failed = failed_windows_probe();
        assert!(
            classify_probe(&captured(&failed, 1), &caps, None)
                .unwrap_err()
                .1
        );
        for (pointer, value) in [
            ("/engine_version", json!("1.0.0+other")),
            ("/schema_version", json!(2)),
            ("/source_commit", json!("wrong")),
            ("/probe_kind", json!("unknown")),
            ("/status", json!("supported")),
            ("/error/code", json!("BAD_CONFIGURATION")),
            ("/error/kind", json!("invalid_selection")),
        ] {
            let mut report = failed.clone();
            *report.pointer_mut(pointer).unwrap() = value;
            assert!(
                !classify_probe(&captured(&report, 1), &caps, None)
                    .unwrap_err()
                    .1,
                "accepted {pointer}"
            );
        }
        assert!(
            !classify_probe(&captured(&failed, 2), &caps, None)
                .unwrap_err()
                .1
        );
        let mut result = captured(&failed, 1);
        result.stdout = b"log noise\n{}".to_vec();
        assert!(!classify_probe(&result, &caps, None).unwrap_err().1);
        result.process.cancelled = true;
        result.process.timed_out = true;
        assert!(!classify_probe(&result, &caps, None).unwrap_err().1);
        result.process.cancelled = false;
        assert!(!classify_probe(&result, &caps, None).unwrap_err().1);
        result.stdout.clear();
        assert!(classify_probe(&result, &caps, None).unwrap_err().1);
        let mut caps = caps;
        caps.supported_features.push("probe_diagnostics_v1".into());
        assert!(
            !classify_probe(&captured(&failed, 1), &caps, None)
                .unwrap_err()
                .1
        );
        let mut report = failed;
        report["failure_stage"] = json!("forward");
        assert!(
            classify_probe(&captured(&report, 1), &caps, None)
                .unwrap_err()
                .1
        );
        for value in [Value::Null, json!(42), json!("invalid_selection")] {
            report["error"]["kind"] = value;
            assert!(
                !classify_probe(&captured(&report, 1), &caps, None)
                    .unwrap_err()
                    .1
            );
        }
    }

    #[test]
    fn dependency_drift_invalidates_previous_compute_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("brush");
        std::fs::write(&binary, b"fixture").unwrap();
        let caps =
            BrushCapabilities::from_json(&serde_json::to_vec(&windows_capabilities()).unwrap())
                .unwrap();
        let probe =
            BrushComputeProbe::from_json(&serde_json::to_vec(&windows_probe()).unwrap(), &caps)
                .unwrap();
        let runtime = VerifiedBrushRuntime {
            capabilities: caps,
            probe,
            binary_sha256: hash_binary(&binary).unwrap(),
            dependency_sha256: dependency_snapshot(&binary).unwrap(),
        };
        runtime.verify_files_unchanged(&binary).unwrap();
        std::fs::write(directory.path().join("dxcompiler.dll"), b"changed").unwrap();
        assert!(runtime.verify_files_unchanged(&binary).is_err());
        assert!(verify_windows_dependencies(&dependency_snapshot(&binary).unwrap()).is_err());
    }

    #[test]
    fn packaged_macos_library_bytes_are_bound_across_probe_and_training() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("brush/bin");
        let libs = directory.path().join("brush/lib");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&libs).unwrap();
        let binary = bin.join("brush");
        std::fs::write(&binary, b"fixture").unwrap();
        let library = libs.join("libfixture.dylib");
        std::fs::write(&library, b"dependency-v1").unwrap();
        let snapshot = dependency_snapshot(&binary).unwrap();
        assert_eq!(
            snapshot["../lib/libfixture.dylib"],
            hash_binary(&library).unwrap()
        );
        std::fs::write(&library, b"dependency-v2").unwrap();
        assert_ne!(snapshot, dependency_snapshot(&binary).unwrap());
        std::fs::remove_file(&library).unwrap();
        assert_ne!(snapshot, dependency_snapshot(&binary).unwrap());
    }

    #[test]
    fn receipt_requires_complete_current_or_shipped_source_recipe_and_matching_binary_hashes() {
        let binary = "a".repeat(64);
        for source in [
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../integrations/brush-windows/source-lock.json"
            )),
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../integrations/brush-windows/source-lock.windows1-legacy.json"
            )),
        ] {
            let lock: Value = serde_json::from_str(source).unwrap();
            let dependencies = ["dxcompiler.dll", "dxil.dll"]
                .into_iter()
                .map(|name| {
                    (
                        name.to_string(),
                        lock["dxc"]["files"][format!("bin/{name}")]["sha256"]
                            .as_str()
                            .unwrap()
                            .to_string(),
                    )
                })
                .collect::<std::collections::BTreeMap<_, _>>();
            let receipt = json!({
                "schema_version": 1, "binary_sha256": binary, "inputs": {"lock": lock},
                "files": {"bin/brush-cli.exe": binary, "bin/dxcompiler.dll": dependencies["dxcompiler.dll"], "bin/dxil.dll": dependencies["dxil.dll"]},
            });
            validate_build_receipt(&receipt, &binary, &dependencies).unwrap();
            for (pointer, value) in [
                ("/schema_version", json!(2)),
                ("/binary_sha256", json!("0".repeat(64))),
                ("/inputs/lock/patches", json!([])),
                ("/inputs/lock/target", json!("aarch64-apple-darwin")),
                ("/inputs/lock/cargo_lock_sha256", json!("0".repeat(64))),
                (
                    "/inputs/lock/combined_source_diff_sha256",
                    json!("0".repeat(64)),
                ),
                ("/files/bin~1brush-cli.exe", json!("0".repeat(64))),
                ("/files/bin~1dxil.dll", json!("0".repeat(64))),
            ] {
                let mut damaged = receipt.clone();
                *damaged.pointer_mut(pointer).unwrap() = value;
                assert!(
                    validate_build_receipt(&damaged, &binary, &dependencies).is_err(),
                    "accepted corrupt {pointer}"
                );
            }
        }
    }

    #[test]
    fn standalone_windows_executable_without_a_receipt_is_not_a_verified_pack() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("bin/brush-cli.exe");
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, b"standalone binary").unwrap();
        let error =
            verify_build_receipt(&binary, &hash_binary(&binary).unwrap(), &Default::default())
                .unwrap_err();
        assert_eq!(error.code, "E-5004");
        assert!(error
            .technical_message
            .as_deref()
            .unwrap()
            .contains("BUILD-INFO.json"));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn auto_probe_independently_verifies_vulkan_and_retains_both_attempts() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("brush.cmd");
        let mut vulkan = windows_probe();
        vulkan["backend"] = json!("vulkan");
        vulkan["device_id"] = json!("vulkan:000010de:00001234:46697874757265");
        let script = format!("@echo off\r\necho %*>>\"%~dp0calls.txt\"\r\nif \"%1\"==\"--version\" goto version\r\nif \"%1\"==\"--capabilities-json\" goto caps\r\nif \"%3\"==\"vulkan\" goto vulkan\r\necho DX12 detailed failure 1>&2\r\necho {}\r\nexit /b 1\r\n:vulkan\r\necho {}\r\nexit /b 0\r\n:version\r\necho brush-cli 1.0.0+metorigin-windows.1\r\nexit /b 0\r\n:caps\r\necho {}\r\nexit /b 0\r\n", failed_windows_probe(), vulkan, windows_capabilities());
        std::fs::write(&binary, &script).unwrap();
        let logs = directory.path().join("logs");
        let runtime = probe_runtime(
            RuntimePlatform::Windows,
            &binary,
            &logs,
            CancellationToken::new(),
            None,
            BrushBackendPreference::Auto,
        )
        .await
        .unwrap();
        assert_eq!(runtime.training_probe().backend, Some(BrushBackend::Vulkan));
        let reports = std::fs::read_dir(&logs)
            .unwrap()
            .filter_map(|e| {
                let p = e.unwrap().path();
                (p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("compute-attempt-"))
                .then(|| std::fs::read_to_string(p).unwrap())
            })
            .collect::<Vec<_>>();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().any(|s| s.contains("DX12 detailed failure")));
        let before = std::fs::read_to_string(directory.path().join("calls.txt")).unwrap();
        let frozen = BrushDeviceSelection {
            backend: BrushBackend::Dx12,
            device_id: Some("dx12:000010de:00001234:46697874757265".into()),
        };
        assert!(probe_runtime(
            RuntimePlatform::Windows,
            &binary,
            &logs,
            CancellationToken::new(),
            Some(&frozen),
            BrushBackendPreference::Auto
        )
        .await
        .is_err());
        let calls = std::fs::read_to_string(directory.path().join("calls.txt")).unwrap();
        assert!(
            !calls[before.len()..].contains("vulkan"),
            "frozen project must never change API"
        );
        std::fs::write(
            &binary,
            script
                .replace(&vulkan.to_string(), &failed_windows_probe().to_string())
                .replace("exit /b 0\r\n:version", "exit /b 1\r\n:version"),
        )
        .unwrap();
        let error = probe_runtime(
            RuntimePlatform::Windows,
            &binary,
            &logs,
            CancellationToken::new(),
            None,
            BrushBackendPreference::Auto,
        )
        .await
        .unwrap_err();
        let detail = error.technical_message.as_deref().unwrap();
        assert!(detail.contains("Dx12") && detail.contains("Vulkan"));
    }

    #[test]
    fn windows_normal_launch_selects_dx12_without_environment_configuration() {
        let selection = windows_selection(
            Err(std::env::VarError::NotPresent),
            Err(std::env::VarError::NotPresent),
        )
        .unwrap();
        assert_eq!(selection.backend, BrushBackend::Dx12);
        assert_eq!(selection.device_id, None);
        assert_eq!(
            selection.arguments().unwrap(),
            ["--graphics-backend", "dx12"]
        );
    }

    #[test]
    fn windows_advanced_backend_and_device_remain_explicit() {
        let id = "vulkan:000010de:00001234:46697874757265";
        let selection = windows_selection(Ok("vulkan".into()), Ok(id.into())).unwrap();
        assert_eq!(selection.backend, BrushBackend::Vulkan);
        assert_eq!(
            selection.arguments().unwrap(),
            ["--graphics-backend", "vulkan", "--graphics-device", id]
        );
        assert_eq!(
            windows_selection(Ok("dx12".into()), Err(std::env::VarError::NotPresent))
                .unwrap()
                .backend,
            BrushBackend::Dx12
        );
    }

    #[test]
    fn invalid_advanced_configuration_fails_without_silent_fallback_or_value_disclosure() {
        let missing = || Err(std::env::VarError::NotPresent);
        for (backend, device) in [
            (Ok("private-invalid-backend".into()), missing()),
            (Ok(String::new()), missing()),
            (
                Err(std::env::VarError::NotUnicode("private-value".into())),
                missing(),
            ),
            (
                missing(),
                Err(std::env::VarError::NotUnicode("private-value".into())),
            ),
            (missing(), Ok(String::new())),
            (
                missing(),
                Ok("vulkan:000010de:00001234:46697874757265".into()),
            ),
        ] {
            let error = windows_selection(backend, device).unwrap_err();
            assert_eq!(error.code, "E-5005");
            assert!(!error.user_message_zh().contains("private"));
            assert!(!error
                .technical_message
                .as_deref()
                .unwrap()
                .contains("private"));
        }
    }

    #[test]
    fn windows_compute_requires_pinned_target_backend_and_reproducible_device() {
        let caps =
            BrushCapabilities::from_json(&serde_json::to_vec(&windows_capabilities()).unwrap())
                .unwrap();
        let probe =
            BrushComputeProbe::from_json(&serde_json::to_vec(&windows_probe()).unwrap(), &caps)
                .unwrap();
        assert_eq!(
            probe.training_probe().device_id,
            Some("dx12:000010de:00001234:46697874757265".into())
        );
        for (key, value) in [
            ("device_type", json!("Cpu")),
            ("device_type", json!("IntegratedGpu")),
            ("device_id", json!("dx12:0")),
            ("device_id", Value::Null),
            (
                "device_id",
                json!("vulkan:000010de:00001234:46697874757265"),
            ),
            ("backend", json!("metal")),
            ("backend", json!("legacy_default")),
        ] {
            let mut modified = windows_probe();
            modified[key] = value;
            assert!(
                BrushComputeProbe::from_json(&serde_json::to_vec(&modified).unwrap(), &caps)
                    .is_err()
            );
        }
        for (key, value) in [
            ("target", json!("aarch64-pc-windows-msvc")),
            ("build_id", json!("stock")),
        ] {
            let mut modified = windows_capabilities();
            modified[key] = value;
            assert!(BrushCapabilities::from_json(&serde_json::to_vec(&modified).unwrap()).is_err());
        }
        let mut caps = windows_capabilities();
        caps["supported_features"] =
            json!(["capabilities_json", "compute_probe", "ply_checkpoint"]);
        assert!(BrushCapabilities::from_json(&serde_json::to_vec(&caps).unwrap()).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_probe_passes_explicit_selection_and_rejects_engine_switch() {
        let root = tempfile::Builder::new()
            .prefix("probe 中文 空格 ")
            .tempdir()
            .unwrap();
        let binary = root.path().join("brush-cli.cmd");
        std::fs::write(&binary, format!(
            "@echo off\r\necho %*>>\"%~dp0calls.txt\"\r\nif \"%1\"==\"--version\" goto version\r\nif \"%1\"==\"--capabilities-json\" goto caps\r\necho {}\r\nexit /b 0\r\n:version\r\necho brush-cli 1.0.0+metorigin-windows.1\r\nexit /b 0\r\n:caps\r\necho {}\r\nexit /b 0\r\n",
            windows_probe(), windows_capabilities()
        )).unwrap();
        let selection = BrushDeviceSelection {
            backend: BrushBackend::Dx12,
            device_id: Some("dx12:000010de:00001234:46697874757265".into()),
        };
        let runtime = probe_training_runtime_with_selection(
            RuntimePlatform::Windows,
            &binary,
            &root.path().join("logs"),
            CancellationToken::new(),
            Some(&selection),
        )
        .await
        .unwrap();
        assert!(matches!(runtime, TrainingRuntimeEvidence::WindowsWgpu(_)));
        let calls = std::fs::read_to_string(root.path().join("calls.txt")).unwrap();
        assert!(calls.contains("--probe-json --graphics-backend dx12 --graphics-device dx12:000010de:00001234:46697874757265"));
        let other = BrushDeviceSelection {
            backend: BrushBackend::Vulkan,
            device_id: None,
        };
        assert!(probe_training_runtime_with_selection(
            RuntimePlatform::Windows,
            &binary,
            &root.path().join("logs"),
            CancellationToken::new(),
            Some(&other)
        )
        .await
        .is_err());
        let script = std::fs::read_to_string(&binary).unwrap().replace(
            "echo brush-cli 1.0.0+metorigin-windows.1",
            "echo brush-cli 1.0.0+stock",
        );
        std::fs::write(&binary, script).unwrap();
        assert!(
            probe_training_runtime_with_selection(
                RuntimePlatform::Windows,
                &binary,
                &root.path().join("logs"),
                CancellationToken::new(),
                Some(&selection),
            )
            .await
            .is_err(),
            "version stdout and machine identity must match"
        );
    }

    #[test]
    fn compute_evidence_requires_actual_metal_finite_nonzero_backward_result() {
        let probe = parse_probe(&probe_json()).unwrap();
        assert_eq!(probe.training_probe().backend, Some(BrushBackend::Metal));
        for (pointer, value) in [
            ("/backend", json!("legacy_default")),
            ("/backend", Value::Null),
            ("/status", json!("unknown")),
            ("/status", json!("failed")),
            ("/compute/forward_finite", json!(false)),
            ("/compute/gradient_finite", json!(false)),
            ("/compute/gradient_l1", json!(0.0)),
            ("/compute/gradient_l1", json!(-0.01)),
            ("/compute/loss", Value::Null),
            ("/compute/width", json!(1)),
            ("/compute/gaussian_count", json!(0)),
            ("/compute", Value::Null),
            ("/device_name", json!("")),
            ("/schema_version", json!(2)),
            ("/engine_version", json!("1.0.1+metorigin-macos.2")),
        ] {
            let mut modified = probe_json();
            *modified.pointer_mut(pointer).unwrap() = value;
            assert!(
                parse_probe(&modified).is_err(),
                "accepted {pointer}: {modified}"
            );
        }
    }

    #[test]
    fn rejects_identity_drift_and_stdout_noise() {
        let mut drift = probe_json();
        drift["build_id"] = json!("metorigin-macos.3");
        drift["engine_version"] = json!("1.0.0+metorigin-macos.3");
        assert!(parse_probe(&drift).is_err());
        let caps = serde_json::to_vec(&capabilities_json()).unwrap();
        assert!(BrushCapabilities::from_json(&[b"log line\n".as_slice(), &caps].concat()).is_err());
        let mut missing = capabilities_json();
        missing["supported_features"] = json!(["capabilities_json"]);
        assert!(BrushCapabilities::from_json(&serde_json::to_vec(&missing).unwrap()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn nonzero_exit_cannot_be_overridden_by_supported_json() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::Builder::new()
            .prefix("probe 中文 空格 ")
            .tempdir()
            .unwrap();
        let binary = root.path().join("brush-cli");
        std::fs::write(&binary, format!(
            "#!/bin/sh\nif [ \"$1\" = --capabilities-json ]; then\n  printf '%s\\n' '{}'\nelse\n  printf '%s\\n' '{}'\n  exit 7\nfi\n",
            capabilities_json(), probe_json()
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = probe_training_runtime(
            RuntimePlatform::Macos,
            &binary,
            &root.path().join("logs"),
            CancellationToken::new(),
        )
        .await;
        assert!(result.is_err());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires a real patched arm64 Brush at METORIGIN_TEST_BRUSH"]
    async fn real_metal_gaussian_compute_probe() {
        let binary =
            std::env::var_os("METORIGIN_TEST_BRUSH").expect("METORIGIN_TEST_BRUSH required");
        let root = tempfile::tempdir().unwrap();
        let logs = std::env::var_os("METORIGIN_TEST_PROBE_LOG_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.path().to_path_buf());
        let result = probe_training_runtime(
            RuntimePlatform::Macos,
            Path::new(&binary),
            &logs,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let TrainingRuntimeEvidence::Metal(runtime) = result else {
            panic!("Metal evidence required")
        };
        assert_eq!(
            runtime.probe.training_probe().backend,
            Some(BrushBackend::Metal)
        );
        assert!(runtime.probe.compute.unwrap().gradient_l1 > 0.0);
        assert_eq!(runtime.binary_sha256.len(), 64);
    }
}
