//! Machine-readable training capability checks. Metal support is established
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
            || capabilities.target != "aarch64-apple-darwin"
            || !capabilities.supports("compute_probe")
            || !capabilities.supports("capabilities_json")
            || !capabilities.supports("ply_checkpoint")
        {
            return Err(probe_error(
                "unsupported target, CLI profile or capability set",
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
        if probe.identity != capabilities.identity
            || probe.probe_kind != ProbeKind::ComputeSmoke
            || probe.status != CapabilityStatus::Supported
            || probe.backend != Some(BrushBackend::Metal)
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
            device_id: None,
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
}

impl TrainingRuntimeEvidence {
    pub fn summary(&self) -> String {
        match self {
            Self::LegacyNvidia(info) => info.summary(),
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
            Self::Metal(runtime) => runtime.probe.training_probe(),
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

/// Shared preflight for project creation, pipeline startup and training. The
/// Windows path retains driver evidence and makes no claim of a compute test.
pub async fn probe_training_runtime(
    platform: RuntimePlatform,
    brush: &Path,
    log_dir: &Path,
    cancellation: CancellationToken,
) -> AppResult<TrainingRuntimeEvidence> {
    if platform == RuntimePlatform::Windows {
        let info = tokio::task::spawn_blocking(crate::require_nvidia_smi)
            .await
            .map_err(|_| probe_error("NVIDIA driver check task failed"))??;
        return Ok(TrainingRuntimeEvidence::LegacyNvidia(info));
    }
    std::fs::create_dir_all(log_dir)
        .map_err(|_| probe_error("could not create probe log directory"))?;
    let before = hash_binary(brush)?;
    let capabilities_json =
        machine_command(brush, "--capabilities-json", log_dir, cancellation.clone()).await?;
    let capabilities = BrushCapabilities::from_json(&capabilities_json)?;
    let probe_json = machine_command(brush, "--probe-json", log_dir, cancellation).await?;
    let probe = BrushComputeProbe::from_json(&probe_json, &capabilities)?;
    let after = hash_binary(brush)?;
    if before != after {
        return Err(probe_error("Brush executable changed during preflight"));
    }
    Ok(TrainingRuntimeEvidence::Metal(Box::new(
        VerifiedBrushRuntime {
            capabilities,
            probe,
            binary_sha256: after,
        },
    )))
}

async fn machine_command(
    brush: &Path,
    argument: &str,
    log_dir: &Path,
    cancellation: CancellationToken,
) -> AppResult<Vec<u8>> {
    let spec = CommandSpec::new(
        brush,
        vec![argument],
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
