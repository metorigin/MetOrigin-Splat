use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_engine_colmap::ColmapAdapter;
use splat_process::ProcessResult;

use crate::stage::StageContext;

pub(crate) fn adapter(ctx: &StageContext) -> AppResult<ColmapAdapter> {
    let path = ctx.engine_paths.colmap.clone().ok_or_else(|| {
        AppError::new(
            "E-3001",
            ErrorCategory::Engine,
            "COLMAP Not Found",
            "COLMAP is required but was not found in the configured engine directory, application resources, or PATH.",
        )
    })?;
    ColmapAdapter::from_path(path)
}

pub(crate) fn image_dir(ctx: &StageContext) -> AppResult<PathBuf> {
    let processed_count = count_images(&ctx.paths.processed_dir);
    let (path, count) = if processed_count > 0 {
        (ctx.paths.processed_dir.clone(), processed_count)
    } else {
        let frames_count = count_images(&ctx.paths.frames_dir);
        (ctx.paths.frames_dir.clone(), frames_count)
    };
    if count == 0 {
        return Err(AppError::new(
            "E-1103",
            ErrorCategory::Media,
            "No Images for COLMAP",
            "Neither processed/ nor frames/ contains supported images for reconstruction.",
        ));
    }
    Ok(path)
}

pub(crate) fn count_images(path: &Path) -> usize {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_file())
                .filter(|path| {
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| {
                            matches!(
                                extension.to_ascii_lowercase().as_str(),
                                "jpg" | "jpeg" | "png"
                            )
                        })
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0)
}

pub(crate) fn ensure_success(result: &ProcessResult, operation: &str) -> AppResult<()> {
    if result.cancelled {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Cancelled"),
            format!("COLMAP {operation} was cancelled by the user."),
        ));
    }
    if result.timed_out {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Timed Out"),
            format!("COLMAP {operation} exceeded its safety timeout."),
        )
        .retryable(true));
    }
    if !result.is_success() {
        return Err(AppError::new(
            "E-3004",
            ErrorCategory::Engine,
            format!("COLMAP {operation} Failed"),
            format!("COLMAP {operation} returned an error. Check the stage log for details."),
        )
        .with_technical(format!(
            "exit_code={:?}, log_path={:?}",
            result.exit_code, result.log_path
        ))
        .retryable(true));
    }
    Ok(())
}

pub(crate) fn write_json_atomic<T: Serialize>(value: &T, path: &Path) -> AppResult<()> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        AppError::new(
            "E-9001",
            ErrorCategory::Internal,
            "Failed to Serialize Stage Result",
            "A pipeline stage result could not be serialized.",
        )
        .with_technical(error.to_string())
    })?;
    let mut file = std::fs::File::create(&temporary).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write Stage Result",
            "Could not create a temporary stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    file.write_all(&bytes).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Write Stage Result",
            "Could not write a stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    file.sync_all().map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Flush Stage Result",
            "Could not finish writing a stage result file.",
        )
        .with_technical(error.to_string())
    })?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Save Stage Result",
            "Could not move a stage result file into place.",
        )
        .with_technical(error.to_string())
    })
}

pub(crate) fn model_path(project_dir: &Path, stored_path: &Path) -> PathBuf {
    if stored_path.is_absolute() {
        stored_path.to_path_buf()
    } else {
        project_dir.join(stored_path)
    }
}

pub(crate) fn has_complete_model(path: &Path) -> bool {
    ["cameras", "images", "points3D"].iter().all(|name| {
        path.join(format!("{name}.bin")).is_file() || path.join(format!("{name}.txt")).is_file()
    })
}
