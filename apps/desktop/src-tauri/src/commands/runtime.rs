//! Shared desktop training preflight; stage execution repeats the same probe.

use crate::state::AppState;
use splat_domain::{AppError, AppResult, EnginePaths, ErrorCategory, ExecutionProfile};
use splat_engine_brush::{
    current_runtime_platform, probe_training_runtime, TrainingRuntimeEvidence,
};
use splat_pipeline::runtime::{
    freeze_macos_execution_profile, freeze_windows_execution_profile, MacosProfileRequest,
    WindowsProfileRequest, WindowsTrainingPolicy,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

const FAILURE_RECORD_LIMIT: usize = 8;
const TECHNICAL_DETAIL_LIMIT: usize = 8192;
static FAILURE_RECORD_WRITER: Mutex<()> = Mutex::new(());

pub async fn check_training_runtime(
    app: &tauri::AppHandle,
    paths: &EnginePaths,
) -> AppResult<TrainingRuntimeEvidence> {
    let pending = crate::lifecycle::PendingWork::begin(app.state::<AppState>().inner())
        .map_err(pending_error)?;
    let probe_app = app.clone();
    let paths = paths.clone();
    // Dropping an IPC await must not drop the shutdown receipt while a probe's
    // process or blocking identity check is still running.
    tokio::spawn(async move {
        let _pending = pending;
        let result = check_training_runtime_inner(&probe_app, &paths).await;
        result.map_err(|error| report_runtime_failure(&probe_app, error))
    })
    .await
    .map_err(|_| {
        report_runtime_failure(app, pending_error("训练环境检查后台任务异常终止。".into()))
    })?
}

fn report_runtime_failure(app: &tauri::AppHandle, error: AppError) -> AppError {
    let directory = app
        .path()
        .app_cache_dir()
        .map(|path| path.join("runtime-probes"));
    match directory {
        Ok(directory) => report_runtime_failure_in(Some(&directory), error),
        Err(cause) => {
            tracing::warn!(%cause, "Could not locate training runtime diagnostics");
            report_runtime_failure_in(None, error)
        }
    }
}

fn report_runtime_failure_in(directory: Option<&Path>, mut error: AppError) -> AppError {
    // The local receipt retains the original cause, including errors before a
    // machine command starts. Never copy raw engine output into the UI summary.
    let diagnostic = directory
        .ok_or_else(|| std::io::Error::other("runtime diagnostic directory unavailable"))
        .and_then(|directory| save_runtime_failure(directory, &error));
    tracing::warn!(
        code = %error.code,
        technical = %bounded_detail(error.technical_message.as_deref().unwrap_or(""), TECHNICAL_DETAIL_LIMIT),
        "Training runtime preflight failed"
    );
    let message = training_runtime_user_message(&error);
    match diagnostic {
        Ok(path) => {
            tracing::warn!(code = %error.code, diagnostic = %path.display(), "Training runtime diagnostic saved");
            error.log_path = Some(path);
            error.user_message = message;
        }
        Err(cause) => {
            tracing::warn!(code = %error.code, %cause, "Could not save training runtime diagnostic");
            error.user_message =
                format!("{message} 本地诊断记录写入失败，请检查应用缓存目录的访问权限。");
        }
    }
    error
}

/// User-safe summaries are selected from known failure stages, never raw detail.
fn training_runtime_user_message(error: &AppError) -> String {
    let detail = error.technical_message.as_deref().unwrap_or("");
    let message = match error.code.as_str() {
        // The adapter owns the actionable, value-free advanced-config message.
        "E-5005" => return error.user_message_zh(),
        "E-2101" => "训练引擎未能启动。请在设置中确认配套引擎可用，必要时修复应用安装后重新检查。",
        "E-2104" => "训练检查的引擎进程未能确认全部退出。请关闭应用并检查残留进程后重试。",
        "E-2103" | "E-2106" => "训练检查未能完整读取引擎响应。请重新检查；若仍失败，请修复应用配套引擎。",
        "E-5004" if detail.contains("could not create probe log directory") =>
            "无法写入训练检查诊断目录。请检查应用缓存目录的访问权限后重试。",
        "E-5004" if detail.starts_with("--probe-json:") && detail.contains("timed_out=true") =>
            "训练 GPU 计算验证超时。请关闭占用显卡的其他任务后重新检查；若仍失败，请查看本地训练诊断。",
        "E-5004" if detail.contains("timed_out=true") =>
            "训练引擎响应超时，尚未完成计算验证。请重新检查；若仍失败，请修复应用配套引擎。",
        "E-5004" if detail.contains("cancelled=true") =>
            "训练运行检查已取消，尚未确认计算能力。请重新检查。",
        "E-5004" if detail.starts_with("--probe-json:") =>
            "训练 GPU 计算验证未通过。请检查显卡驱动和配套引擎是否完整，再重新检查；具体原因见本地训练诊断。",
        "E-5004" if detail.starts_with("--version:") || detail.starts_with("--capabilities-json:") =>
            "训练引擎的版本或能力检查未通过，尚未开始计算验证。请修复应用配套引擎后重新检查。",
        "E-5004" if detail.contains("Gaussian compute evidence") =>
            "训练计算结果或引擎身份未通过校验。请修复应用配套引擎后重新检查，具体原因见本地训练诊断。",
        "E-5004" if detail.contains("requested Windows backend/device") =>
            "实际训练后端或显卡与指定配置不一致。请检查自定义启动配置或修复配套引擎后重新检查。",
        "E-5004" if detail.contains("Brush binary") =>
            "无法完整读取训练引擎。请在设置中检查引擎位置和访问权限，必要时修复应用安装。",
        "E-5004" if detail.contains("unsupported training platform or architecture") =>
            "当前系统或处理器架构不受此训练引擎支持。请安装适用于本机的应用版本。",
        "E-5004" if detail.contains("identity") || detail.contains("capabilit")
            || detail.contains("target") || detail.contains("version")
            || detail.contains("JSON") || detail.contains("executable changed") =>
            "训练引擎身份、版本或能力响应未通过校验。请在设置中使用应用配套引擎，修复安装后重新检查。",
        "E-5004" => "训练运行检查未完成，尚未确认训练计算能力。请重新检查；若仍失败，请查看本地训练诊断。",
        // Existing localized missing-engine, legacy NVIDIA, and Mac capability
        // errors retain their own recovery advice and error codes.
        _ => return error.user_message_zh(),
    };
    message.into()
}

fn bounded_detail(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.into();
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn save_runtime_failure(directory: &Path, error: &AppError) -> std::io::Result<PathBuf> {
    // Serialize this small, derived cache independently of project persistence.
    // Rotation only removes our own UUID-named receipts, never engine logs.
    let _writer = FAILURE_RECORD_WRITER
        .lock()
        .map_err(|_| std::io::Error::other("runtime diagnostic writer unavailable"))?;
    std::fs::create_dir_all(directory)?;
    let mut records = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let owned = name
            .to_str()
            .and_then(|name| name.strip_prefix("runtime-failure-")?.strip_suffix(".json"))
            .is_some_and(|id| uuid::Uuid::try_parse(id).is_ok());
        if owned && entry.file_type()?.is_file() {
            records.push(entry.path());
        }
    }
    records.sort();
    for path in records
        .iter()
        .take(records.len().saturating_sub(FAILURE_RECORD_LIMIT - 1))
    {
        std::fs::remove_file(path)?;
    }
    let technical = error.technical_message.as_deref();
    let record = serde_json::json!({
        "schema_version": 1,
        "checked_at": chrono::Utc::now().to_rfc3339(),
        "code": bounded_detail(&error.code, 128),
        "category": error.category,
        "title": bounded_detail(&error.title, 512),
        "user_message": bounded_detail(&error.user_message, 2048),
        "technical_message": technical.map(|value| bounded_detail(value, TECHNICAL_DETAIL_LIMIT)),
        "technical_truncated": technical.is_some_and(|value| value.len() > TECHNICAL_DETAIL_LIMIT),
        "source_log": error.log_path.as_ref().map(|path| bounded_detail(&path.to_string_lossy(), 1024)),
    });
    let bytes = serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?;
    let path = directory.join(format!("runtime-failure-{}.json", uuid::Uuid::now_v7()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(path)
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
    if let TrainingRuntimeEvidence::Metal(verified)
    | TrainingRuntimeEvidence::WindowsWgpu(verified) = &runtime
    {
        if !verified.capabilities.supports("loader_thread_limit") {
            return Err(AppError::new(
                "E-1403",
                ErrorCategory::Environment,
                "Brush 引擎版本不兼容",
                if matches!(&runtime, TrainingRuntimeEvidence::WindowsWgpu(_)) {
                    "当前 Brush 未提供图像加载线程限制，请使用应用配套的 Windows 引擎。"
                } else {
                    "当前 Brush 未提供图像加载线程限制，请使用应用配套的 macOS 引擎。"
                },
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
    let (brush, windows) = match runtime {
        TrainingRuntimeEvidence::Metal(brush) => (brush, false),
        TrainingRuntimeEvidence::WindowsWgpu(brush) => (brush, true),
        // Keep the existing Windows 0.3 CLI/live-companion behavior intact.
        TrainingRuntimeEvidence::LegacyNvidia(_) => return Ok(None),
    };
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let os_version = sysinfo::System::os_version().unwrap_or_default();
    let physical_memory_bytes = system.total_memory();
    let available_threads = std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(0);
    let pending = crate::lifecycle::PendingWork::begin(state).map_err(pending_error)?;
    let brush = brush.clone();
    tokio::spawn(async move {
        let _pending = pending;
        if windows {
            freeze_windows_execution_profile(
                WindowsProfileRequest {
                    os_version,
                    physical_memory_bytes,
                    available_threads,
                    preset,
                    requested_resolution: resolution,
                    engine_paths: paths,
                    engine_pack_id: None,
                    // Dynamic WGPU adapter budget has not been measured. Never
                    // substitute an unrelated nvidia-smi device's total VRAM.
                    available_adapter_budget_bytes: None,
                    policy: WindowsTrainingPolicy::candidate(),
                },
                &brush,
            )
            .await
            .map(Some)
        } else {
            freeze_macos_execution_profile(
                MacosProfileRequest {
                    os_version,
                    physical_memory_bytes,
                    available_threads,
                    preset,
                    requested_resolution: resolution,
                    engine_paths: paths,
                    engine_pack_id: None,
                },
                &brush,
            )
            .await
            .map(Some)
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn error(code: &str, detail: &str) -> AppError {
        AppError::new(
            code,
            ErrorCategory::Environment,
            "训练检查失败",
            "原始通用提示",
        )
        .with_technical(detail)
        .retryable(true)
    }

    fn test_directory() -> PathBuf {
        std::env::temp_dir().join(format!(
            "metorigin-runtime-failure-{}",
            uuid::Uuid::now_v7()
        ))
    }

    #[test]
    fn runtime_failures_distinguish_configuration_compute_timeout_and_identity() {
        for (code, detail, expected) in [
            (
                "E-5004",
                "--probe-json: exit=Some(1), timed_out=false, cancelled=false",
                "计算验证未通过",
            ),
            (
                "E-5004",
                "--probe-json: exit=None, timed_out=true, cancelled=false",
                "计算验证超时",
            ),
            (
                "E-5004",
                "--capabilities-json: exit=None, timed_out=true, cancelled=false",
                "引擎响应超时",
            ),
            (
                "E-5004",
                "--probe-json: exit=None, timed_out=false, cancelled=true",
                "已取消",
            ),
            (
                "E-5004",
                "--capabilities-json: exit=Some(1), timed_out=false, cancelled=false",
                "尚未开始计算验证",
            ),
            (
                "E-5004",
                "Gaussian compute evidence or engine identity did not match",
                "计算结果或引擎身份",
            ),
            (
                "E-5004",
                "unsupported Brush machine identity",
                "身份、版本或能力响应",
            ),
            (
                "E-5004",
                "Probe did not use the requested Windows backend/device",
                "与指定配置不一致",
            ),
            ("E-5004", "could not create probe log directory", "诊断目录"),
            ("E-5004", "Brush binary could not be read", "无法完整读取"),
            (
                "E-2101",
                "program: C:\\PRIVATE_FIXTURE\\brush.exe, error: denied",
                "引擎未能启动",
            ),
            ("E-5004", "unknown PRIVATE_FIXTURE", "尚未确认"),
        ] {
            let message = training_runtime_user_message(&error(code, detail));
            assert!(message.contains(expected), "{detail}: {message}");
            assert!(!message.contains("PRIVATE_FIXTURE"));
            assert!(!message.contains(detail));
        }
        let config = AppError::new(
            "E-5005",
            ErrorCategory::Environment,
            "训练后端配置无效",
            "应用的高级训练配置无效。请移除自定义启动配置后重新检查。",
        )
        .with_technical("unsupported Windows graphics backend");
        assert_eq!(training_runtime_user_message(&config), config.user_message);
        for code in ["E-5001", "E-5002", "E-5003", "E-1403", "E-4001"] {
            let existing = error(code, "existing legacy/Mac diagnostic");
            assert_eq!(
                training_runtime_user_message(&existing),
                existing.user_message
            );
        }
    }

    #[test]
    fn runtime_failure_receipt_preserves_cause_without_exposing_it_to_ui() {
        let directory = test_directory();
        let cause = "program: C:\\PRIVATE_FIXTURE\\brush.exe, error: denied";
        let original = error("E-2101", cause).with_log_path(PathBuf::from("private-source.log"));
        let reported = report_runtime_failure_in(Some(&directory), original);
        assert_eq!(reported.code, "E-2101");
        assert!(reported.retryable);
        assert_eq!(reported.technical_message.as_deref(), Some(cause));
        assert!(reported.user_message.contains("引擎未能启动"));
        assert!(!reported.user_message.contains("PRIVATE_FIXTURE"));
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(reported.log_path.as_ref().unwrap()).unwrap())
                .unwrap();
        assert_eq!(receipt["schema_version"], 1);
        assert_eq!(receipt["code"], "E-2101");
        assert_eq!(receipt["technical_message"], cause);
        assert_eq!(receipt["source_log"], "private-source.log");
        assert_eq!(receipt["technical_truncated"], false);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_failure_receipts_bound_unicode_and_rotate_only_owned_records() {
        let directory = test_directory();
        std::fs::create_dir_all(&directory).unwrap();
        let probe_log = directory.join("probe-json-previous.log");
        let unrelated = directory.join("runtime-failure-user-note.json");
        std::fs::write(&probe_log, "retained engine output").unwrap();
        std::fs::write(&unrelated, "user note").unwrap();
        let technical = "中".repeat(TECHNICAL_DETAIL_LIMIT);
        let mut written = Vec::new();
        for _ in 0..FAILURE_RECORD_LIMIT + 2 {
            written.push(save_runtime_failure(&directory, &error("E-5004", &technical)).unwrap());
        }
        assert!(!written[0].exists());
        assert!(!written[1].exists());
        assert!(written[2..].iter().all(|path| path.is_file()));
        assert_eq!(
            std::fs::read_dir(&directory).unwrap().count(),
            FAILURE_RECORD_LIMIT + 2
        );
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(written.last().unwrap()).unwrap()).unwrap();
        assert_eq!(receipt["technical_truncated"], true);
        let saved = receipt["technical_message"].as_str().unwrap();
        assert!(saved.len() <= TECHNICAL_DETAIL_LIMIT + "…".len());
        assert!(saved.ends_with('…'));
        assert_eq!(
            std::fs::read_to_string(probe_log).unwrap(),
            "retained engine output"
        );
        assert_eq!(std::fs::read_to_string(unrelated).unwrap(), "user note");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_diagnostic_write_failure_retains_primary_error_and_recovery_advice() {
        let directory = test_directory();
        std::fs::write(&directory, "a file cannot be a diagnostic directory").unwrap();
        for target in [Some(directory.as_path()), None] {
            let reported =
                report_runtime_failure_in(target, error("E-5004", "invalid compute probe JSON"));
            assert_eq!(reported.code, "E-5004");
            assert_eq!(
                reported.technical_message.as_deref(),
                Some("invalid compute probe JSON")
            );
            assert!(reported.log_path.is_none());
            assert!(reported.user_message.contains("未通过校验"));
            assert!(reported.user_message.contains("诊断记录写入失败"));
            assert!(!reported.user_message.contains("invalid compute"));
        }
        std::fs::remove_file(directory).unwrap();
    }
}
