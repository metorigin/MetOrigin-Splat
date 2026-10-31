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
use splat_process::{CommandSpec, ProcessRunner};
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
            Self::LegacyNvidia(info) => info.summary(),
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
/// Windows 1 uses DX12 by default and verifies it with the machine protocol.
/// Optional advanced overrides never cause a silent backend switch.
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
    std::fs::create_dir_all(log_dir)
        .map_err(|_| probe_error("could not create probe log directory"))?;
    let before = hash_binary(brush)?;
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
                if selection.is_some() {
                    return Err(probe_error(
                        "A frozen Windows Brush 1 selection cannot use a legacy engine",
                    ));
                }
                let info = tokio::task::spawn_blocking(crate::require_nvidia_smi)
                    .await
                    .map_err(|_| probe_error("NVIDIA driver check task failed"))??;
                if before != hash_binary(brush)? {
                    return Err(probe_error("Brush executable changed during preflight"));
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
    let candidate;
    let selection = if platform == RuntimePlatform::Windows {
        if let Some(selection) = selection {
            Some(selection)
        } else {
            // The packaged Windows1 application must work from its normal
            // shortcut. Choosing its tested API is separate from promoting the
            // candidate engine pack to the formal release default. A successful
            // compute probe is still required before any training can start.
            candidate = windows_selection(
                std::env::var("METORIGIN_BRUSH_BACKEND"),
                std::env::var("METORIGIN_BRUSH_DEVICE_ID"),
            )?;
            Some(&candidate)
        }
    } else {
        None
    };
    let arguments = selection
        .map(BrushDeviceSelection::arguments)
        .transpose()?
        .unwrap_or_default();
    let probe_json =
        machine_command(brush, "--probe-json", &arguments, log_dir, cancellation).await?;
    let probe = BrushComputeProbe::from_json(&probe_json, &capabilities)?;
    if let Some(selection) = selection {
        if probe.backend != Some(selection.backend)
            || selection
                .device_id
                .as_ref()
                .is_some_and(|id| Some(id) != probe.device_id.as_ref())
        {
            return Err(probe_error(
                "Probe did not use the requested Windows backend/device",
            ));
        }
    }
    let after = hash_binary(brush)?;
    if before != after {
        return Err(probe_error("Brush executable changed during preflight"));
    }
    let runtime = Box::new(VerifiedBrushRuntime {
        capabilities,
        probe,
        binary_sha256: after,
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
    let captured = ProcessRunner::new()
        .run_to_completion_capture(spec, cancellation, 256 * 1024)
        .await?;
    if !captured.process.is_success() {
        return Err(probe_error(&format!(
            "{argument}: exit={:?}, timed_out={}, cancelled={}",
            captured.process.exit_code, captured.process.timed_out, captured.process.cancelled
        )));
    }
    Ok(captured.stdout)
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
