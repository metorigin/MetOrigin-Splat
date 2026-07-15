use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_engine_colmap::{read_colmap_result, QualityDecision, ValidationReport};

use crate::stage::StagePaths;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct QualityRiskAcceptance {
    pub model_sha256: String,
    pub accepted_at: String,
}

pub fn model_sha256(model_dir: &Path) -> AppResult<String> {
    let mut files = Vec::new();
    for stem in ["cameras", "images", "points3D"] {
        let path = ["bin", "txt"]
            .into_iter()
            .map(|extension| model_dir.join(format!("{stem}.{extension}")))
            .find(|path| path.is_file())
            .ok_or_else(|| {
                AppError::new(
                    "E-3030",
                    ErrorCategory::Engine,
                    "Incomplete COLMAP Model",
                    format!("The sparse model is missing {stem}.bin/.txt."),
                )
            })?;
        files.push(path);
    }
    let mut hasher = Sha256::new();
    for path in files {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy())
            .unwrap_or_default();
        hasher.update(name.as_bytes());
        let mut file = std::fs::File::open(&path).map_err(quality_filesystem_error)?;
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(quality_filesystem_error)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn acceptance_path(project_dir: &Path) -> PathBuf {
    project_dir.join("colmap/quality-acceptance.json")
}

pub fn acceptance_matches(project_dir: &Path, expected_hash: &str) -> bool {
    std::fs::read_to_string(acceptance_path(project_dir))
        .ok()
        .and_then(|json| serde_json::from_str::<QualityRiskAcceptance>(&json).ok())
        .map(|acceptance| acceptance.model_sha256 == expected_hash)
        .unwrap_or(false)
}

pub fn accept_colmap_quality_risk(project_dir: &Path) -> AppResult<QualityRiskAcceptance> {
    let paths = StagePaths::new(project_dir);
    let result = read_colmap_result(&paths.colmap_result)?;
    let model_dir = if result.model_path.is_absolute() {
        result.model_path
    } else {
        project_dir.join(result.model_path)
    };
    let hash = model_sha256(&model_dir)?;
    let report: ValidationReport = serde_json::from_slice(
        &std::fs::read(&paths.colmap_validation).map_err(quality_filesystem_error)?,
    )
    .map_err(|error| {
        AppError::new(
            "E-3034",
            ErrorCategory::Engine,
            "Invalid COLMAP Validation Report",
            "The quality risk cannot be accepted because validation.json is malformed.",
        )
        .with_technical(error.to_string())
    })?;
    if report.decision != QualityDecision::RequiresConfirmation {
        return Err(AppError::new(
            "E-1002",
            ErrorCategory::User,
            "COLMAP Quality Confirmation Not Available",
            "Only a trainable model with quality warnings can be accepted.",
        ));
    }
    if report.model_hash.as_deref() != Some(hash.as_str()) {
        return Err(AppError::new(
            "E-3034",
            ErrorCategory::Engine,
            "COLMAP Model Changed",
            "The sparse model changed after validation. Run COLMAP validation again.",
        ));
    }
    let acceptance = QualityRiskAcceptance {
        model_sha256: hash,
        accepted_at: Utc::now().to_rfc3339(),
    };
    crate::stages::colmap_support::write_json_atomic(&acceptance, &acceptance_path(project_dir))?;
    Ok(acceptance)
}

fn quality_filesystem_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-1201",
        ErrorCategory::Filesystem,
        "Failed to Read COLMAP Quality Artifact",
        "A COLMAP model or quality report could not be read.",
    )
    .with_technical(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_hash_changes_when_sparse_model_changes() {
        let root = tempfile::tempdir().unwrap();
        for name in ["cameras.bin", "images.bin", "points3D.bin"] {
            std::fs::write(root.path().join(name), name.as_bytes()).unwrap();
        }
        let first = model_sha256(root.path()).unwrap();
        std::fs::write(root.path().join("images.bin"), b"changed").unwrap();
        let second = model_sha256(root.path()).unwrap();
        assert_ne!(first, second);
    }
}
