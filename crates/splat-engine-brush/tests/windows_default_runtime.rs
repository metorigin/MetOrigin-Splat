//! Opt-in native acceptance for the ordinary Windows1 application preflight.
//! It creates no project and runs only the engine's tiny compute probe.
#![cfg(all(target_os = "windows", target_arch = "x86_64"))]

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::json;
use sha2::{Digest, Sha256};
use splat_domain::runtime::{BrushBackend, RuntimePlatform};
use splat_engine_brush::{probe_training_runtime, TrainingRuntimeEvidence};
use tokio_util::sync::CancellationToken;

fn hash_file(path: &Path) -> String {
    let mut input = std::fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let size = input.read(&mut buffer).unwrap();
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    format!("{:x}", hash.finalize())
}

#[tokio::test]
#[ignore = "requires the paired native Windows1 engine and a real discrete DX12 GPU; no backend/device environment overrides"]
async fn windows_default_runtime_without_backend_or_device_environment() {
    assert!(std::env::var_os("METORIGIN_BRUSH_BACKEND").is_none());
    assert!(std::env::var_os("METORIGIN_BRUSH_DEVICE_ID").is_none());
    let brush = PathBuf::from(std::env::var_os("METORIGIN_TEST_BRUSH").expect("test engine path"));
    let output = PathBuf::from(
        std::env::var_os("METORIGIN_TEST_DEFAULT_PROBE_OUTPUT").expect("fresh probe evidence path"),
    );
    std::fs::create_dir(&output).expect("existing evidence must not be overwritten");
    let receipt = output.join("evidence.json");
    let binary_before = hash_file(&brush);
    let test_binary = std::env::current_exe().unwrap();
    let mut evidence = json!({
        "schema_version": 1,
        "status": "running",
        "backend_environment_present": false,
        "device_environment_present": false,
        "brush_path": brush,
        "brush_sha256_before": binary_before,
        "test_binary_sha256": hash_file(&test_binary),
        "scope": "Production application preflight with both override variables absent; only eight-Gaussian 32x32 forward/backward; no dataset, training, project or UI"
    });
    std::fs::write(&receipt, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    let result = probe_training_runtime(
        RuntimePlatform::Windows,
        &brush,
        &output.join("logs"),
        CancellationToken::new(),
    )
    .await;
    evidence["brush_sha256_after"] = json!(hash_file(&brush));
    match &result {
        Ok(TrainingRuntimeEvidence::WindowsWgpu(runtime)) => {
            let expected_device = runtime.probe.backend == Some(BrushBackend::Dx12)
                && runtime
                    .probe
                    .device_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with("dx12:"));
            evidence["status"] = json!(if expected_device && binary_before == hash_file(&brush) {
                "passed"
            } else {
                "failed"
            });
            evidence["capabilities"] = json!(runtime.capabilities);
            evidence["probe"] = json!(runtime.probe);
        }
        Ok(_) => {
            evidence["status"] = json!("failed");
            evidence["error"] = json!("Windows1 preflight returned a different runtime family");
        }
        Err(error) => {
            evidence["status"] = json!("failed");
            evidence["error"] = json!(format!("{error:?}"));
        }
    }
    std::fs::write(&receipt, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    let runtime = match result.expect("ordinary no-environment preflight must succeed") {
        TrainingRuntimeEvidence::WindowsWgpu(runtime) => runtime,
        other => panic!("expected Windows1 WGPU, got {other:?}"),
    };
    assert_eq!(runtime.probe.backend, Some(BrushBackend::Dx12));
    assert!(runtime
        .probe
        .device_id
        .as_deref()
        .is_some_and(|id| id.starts_with("dx12:")));
    let compute = runtime.probe.compute.as_ref().unwrap();
    assert_eq!(
        (compute.gaussian_count, compute.width, compute.height),
        (8, 32, 32)
    );
    assert!(compute.forward_finite && compute.gradient_finite && compute.gradient_l1 > 0.0);
    assert_eq!(binary_before, hash_file(&brush));
    assert!(std::env::var_os("METORIGIN_BRUSH_BACKEND").is_none());
    assert!(std::env::var_os("METORIGIN_BRUSH_DEVICE_ID").is_none());
}
