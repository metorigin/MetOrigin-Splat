//! Shared desktop training preflight; stage execution repeats the same probe.

use crate::state::AppState;
use splat_domain::{AppError, AppResult, EnginePaths, ErrorCategory, ExecutionProfile};
use splat_engine_brush::{
    current_runtime_platform, probe_training_runtime, TrainingRuntimeEvidence,
};
use splat_pipeline::runtime::{freeze_macos_execution_profile, MacosProfileRequest};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

pub async fn check_training_runtime(
    app: &tauri::AppHandle,
    paths: &EnginePaths,
) -> AppResult<TrainingRuntimeEvidence> {
    let pending = crate::lifecycle::PendingWork::begin(app.state::<AppState>().inner())
        .map_err(pending_error)?;
    let app = app.clone();
    let paths = paths.clone();
    // Dropping an IPC await must not drop the shutdown receipt while a probe's
    // process or blocking identity check is still running.
    tokio::spawn(async move {
        let _pending = pending;
        check_training_runtime_inner(&app, &paths).await
    })
    .await
    .map_err(|_| pending_error("训练环境检查后台任务异常终止。".into()))?
}

async fn check_training_runtime_inner(
    app: &tauri::AppHandle,
    paths: &EnginePaths,
) -> AppResult<TrainingRuntimeEvidence> {
    let platform = current_runtime_platform()?;
    let brush = paths.brush.as_deref().ok_or_else(|| {
        AppError::new(
            "E-4001",
            ErrorCategory::Engine,
            "Brush 未定位",
            "请先配置可用的 Brush 引擎。",
        )
    })?;
    let logs = app
        .path()
        .app_cache_dir()
        .map_err(|error| {
            AppError::new(
                "E-1404",
                ErrorCategory::Filesystem,
                "无法创建训练诊断",
                "无法定位应用诊断目录。",
            )
            .with_technical(error.to_string())
        })?
        .join("runtime-probes");
    let runtime = probe_training_runtime(platform, brush, &logs, CancellationToken::new()).await?;
    if let TrainingRuntimeEvidence::Metal(verified) = &runtime {
        if !verified.capabilities.supports("loader_thread_limit") {
            return Err(AppError::new(
                "E-1403",
                ErrorCategory::Environment,
                "Brush 引擎版本不兼容",
                "当前 Brush 未提供图像加载线程限制，请使用应用配套的 macOS 引擎。",
            ));
        }
    }
    Ok(runtime)
}

pub async fn execution_profile(
    state: &AppState,
    paths: EnginePaths,
    preset: String,
    resolution: u32,
    runtime: &TrainingRuntimeEvidence,
) -> AppResult<Option<ExecutionProfile>> {
    let TrainingRuntimeEvidence::Metal(brush) = runtime else {
        // Keep the existing Windows 0.3 CLI/live-companion behavior intact.
        return Ok(None);
    };
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let request = MacosProfileRequest {
        os_version: sysinfo::System::os_version().unwrap_or_default(),
        physical_memory_bytes: system.total_memory(),
        available_threads: std::thread::available_parallelism()
            .map(|value| value.get() as u32)
            .unwrap_or(0),
        preset,
        requested_resolution: resolution,
        engine_paths: paths,
        engine_pack_id: None,
    };
    let pending = crate::lifecycle::PendingWork::begin(state).map_err(pending_error)?;
    let brush = brush.clone();
    tokio::spawn(async move {
        let _pending = pending;
        freeze_macos_execution_profile(request, &brush)
            .await
            .map(Some)
    })
    .await
    .map_err(|_| pending_error("运行配置检查后台任务异常终止。".into()))?
}

fn pending_error(detail: String) -> AppError {
    AppError::new(
        "E-1406",
        ErrorCategory::Environment,
        "运行环境检查未完成",
        detail,
    )
}
