use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::CommandSpec;

use crate::result::ColmapResult;
use crate::runtime;
use crate::types::{MapperKind, ModelInfo};

/// Executes and analyzes COLMAP sparse reconstruction (mapper).
///
/// Responsibilities:
/// - Building `colmap mapper` commands
/// - Running `colmap model_analyzer` on output models
/// - Selecting the best model when multiple disconnected reconstructions exist
/// - Parsing model statistics into structured `ColmapResult`
pub struct ColmapMapper {
    colmap_path: PathBuf,
}

impl ColmapMapper {
    /// Create a new mapper with the path to the COLMAP executable.
    pub fn new(colmap_path: PathBuf) -> Self {
        Self { colmap_path }
    }

    /// Build a `CommandSpec` for `colmap mapper`.
    ///
    /// Equivalent CLI:
    /// ```bash
    /// colmap mapper \
    ///     --database_path <database_path> \
    ///     --image_path <image_path> \
    ///     --output_path <output_path>
    /// ```
    pub fn build_command(
        &self,
        database_path: &Path,
        image_path: &Path,
        output_path: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        self.build_command_with_kind(
            MapperKind::Incremental,
            database_path,
            image_path,
            output_path,
            log_path,
        )
    }

    pub fn build_command_with_kind(
        &self,
        kind: MapperKind,
        database_path: &Path,
        image_path: &Path,
        output_path: &Path,
        log_path: &Path,
    ) -> CommandSpec {
        runtime::command_spec(
            &self.colmap_path,
            vec![
                match kind {
                    MapperKind::Global => "global_mapper",
                    MapperKind::Incremental => "mapper",
                }
                .into(),
                "--log_target".into(),
                "stderr".into(),
                "--database_path".into(),
                database_path.as_os_str().to_owned(),
                "--image_path".into(),
                image_path.as_os_str().to_owned(),
                "--output_path".into(),
                output_path.as_os_str().to_owned(),
            ],
            log_path,
        )
    }

    /// Analyze the sparse reconstruction output directory.
    ///
    /// Scans for model subdirectories (`0/`, `1/`, ...), runs
    /// `colmap model_analyzer` on each, and selects the one with
    /// the most registered images.
    ///
    /// # Errors
    ///
    /// Returns:
    /// - `E-3030` if no valid models found in the sparse directory
    /// - `E-3031` if the sparse directory does not exist
    pub fn analyze_result(
        &self,
        sparse_dir: &Path,
        total_input_images: usize,
    ) -> AppResult<ColmapResult> {
        if !sparse_dir.exists() {
            return Err(AppError::new(
                "E-3031",
                ErrorCategory::Filesystem,
                "Sparse Directory Not Found",
                format!(
                    "The COLMAP sparse output directory '{}' does not exist. \
                     Mapping may not have been executed.",
                    sparse_dir.display()
                ),
            ));
        }

        // 1. Find all model subdirectories
        let model_dirs = find_model_directories(sparse_dir)?;

        if model_dirs.is_empty() {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "No Sparse Model Generated",
                "COLMAP mapper did not produce any valid sparse reconstruction. \
                 The reconstruction may have failed completely.",
            )
            .with_suggestions(vec![
                "Check that images have sufficient quality and overlap",
                "Examine the COLMAP mapper log for specific errors",
                "Try with a smaller subset of images to isolate the issue",
            ]));
        }

        // 2. Run model_analyzer on each model
        let mut models: Vec<(PathBuf, ModelInfo)> = Vec::new();
        for dir in &model_dirs {
            match self.analyze_model(dir) {
                Ok(info) => models.push((dir.clone(), info)),
                Err(e) => {
                    tracing::warn!("Failed to analyze model '{}': {}", dir.display(), e);
                }
            }
        }

        if models.is_empty() {
            return Err(AppError::new(
                "E-3030",
                ErrorCategory::Engine,
                "No Analyzable Sparse Model",
                "COLMAP produced model directories but none could be analyzed. \
                 The model files may be corrupted or in an unexpected format.",
            ));
        }

        // 3. Sort by registered images (descending) — pick the best
        models.sort_by_key(|model| std::cmp::Reverse(model.1.registered_images));
        let (best_dir, best_info) = &models[0];

        // 4. Warn about disconnected models
        if models.len() > 1 {
            tracing::warn!(
                "COLMAP produced {} disconnected models. Selected '{}' with {} images.",
                models.len(),
                best_dir.file_name().unwrap_or_default().to_string_lossy(),
                best_info.registered_images,
            );
        }

        tracing::info!(
            "Sparse reconstruction: {} registered images, {} 3D points, {:.3}px reprojection error",
            best_info.registered_images,
            best_info.point_count,
            best_info.mean_reprojection_error,
        );

        Ok(ColmapResult {
            registered_images: best_info.registered_images,
            total_images: total_input_images,
            point_count: best_info.point_count,
            model_path: best_dir.clone(),
            observations: Some(best_info.observations),
            mean_reprojection_error: Some(best_info.mean_reprojection_error),
            mean_track_length: Some(best_info.mean_track_length),
            strategy_version: 0,
            source_kind: None,
            selected_attempt_id: None,
            selection_reason: None,
            attempts: Vec::new(),
            automatic_fallbacks_exhausted: false,
        })
    }

    /// Analyze one sparse model with this adapter's resolved COLMAP binary.
    pub fn analyze_model(&self, model_dir: &Path) -> AppResult<ModelInfo> {
        analyze_model(&self.colmap_path, model_dir)
    }
}

/// Run `colmap model_analyzer` on a model directory and parse the output.
fn analyze_model(colmap_path: &Path, model_dir: &Path) -> AppResult<ModelInfo> {
    let output = runtime::command(colmap_path)
        .args(["model_analyzer", "--path"])
        .arg(model_dir.as_os_str())
        .output()
        .map_err(|e| {
            AppError::new(
                "E-3032",
                ErrorCategory::Engine,
                "Model Analyzer Failed",
                format!("Could not run colmap model_analyzer: {}", e),
            )
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::new(
            "E-3032",
            ErrorCategory::Engine,
            "Model Analyzer Error",
            format!(
                "colmap model_analyzer returned an error for '{}': {}",
                model_dir.display(),
                stderr.trim()
            ),
        ));
    }

    let analyzer_output = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(ModelInfo {
        cameras: parse_int_field(&analyzer_output, "Cameras:"),
        images: parse_int_field(&analyzer_output, "Images:"),
        registered_images: parse_int_field(&analyzer_output, "Registered images:"),
        point_count: parse_int_field(&analyzer_output, "Points:"),
        observations: parse_int_field(&analyzer_output, "Observations:"),
        mean_track_length: parse_float_field(&analyzer_output, "Mean track length:"),
        mean_reprojection_error: parse_float_field(&analyzer_output, "Mean reprojection error:"),
    })
}

/// Find all valid model subdirectories within a sparse directory.
///
/// A valid model directory contains `cameras.bin` or `cameras.txt`.
fn find_model_directories(sparse_dir: &Path) -> AppResult<Vec<PathBuf>> {
    let reader = std::fs::read_dir(sparse_dir).map_err(|e| {
        AppError::new(
            "E-3031",
            ErrorCategory::Filesystem,
            "Failed to Read Sparse Directory",
            format!(
                "Could not read sparse directory '{}': {}",
                sparse_dir.display(),
                e
            ),
        )
    })?;

    let mut dirs: Vec<PathBuf> = reader
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let has_bin = p.join("cameras.bin").exists()
                || p.join("images.bin").exists()
                || p.join("points3D.bin").exists();
            let has_txt = p.join("cameras.txt").exists();
            has_bin || has_txt
        })
        .collect();

    // Sort by name (0, 1, 2, ...) for consistent ordering
    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    Ok(dirs)
}

/// Read the registered image names from a binary or text COLMAP model without
/// requiring a second model conversion process.
pub fn read_registered_image_names(model_dir: &Path) -> AppResult<Vec<String>> {
    let binary = model_dir.join("images.bin");
    let text = model_dir.join("images.txt");
    let mut names = if binary.is_file() {
        read_binary_image_names(&binary)?
    } else if text.is_file() {
        read_text_image_names(&text)?
    } else {
        return Err(AppError::new(
            "E-3031",
            ErrorCategory::Filesystem,
            "COLMAP Image Model Missing",
            "The selected sparse model has neither images.bin nor images.txt.",
        ));
    };
    names.sort();
    names.dedup();
    Ok(names)
}

fn read_binary_image_names(path: &Path) -> AppResult<Vec<String>> {
    Ok(read_binary_image_camera_pairs(path)?
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

fn read_binary_image_camera_pairs(path: &Path) -> AppResult<Vec<(String, u32)>> {
    let mut reader = BufReader::new(std::fs::File::open(path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read COLMAP Images",
            "Could not open images.bin.",
        )
        .with_technical(error.to_string())
    })?);
    let count = read_u64(&mut reader)? as usize;
    let mut names = Vec::with_capacity(count);
    for _ in 0..count {
        let mut fixed = [0_u8; 64];
        reader.read_exact(&mut fixed).map_err(binary_model_error)?;
        let camera_id = u32::from_le_bytes(fixed[60..64].try_into().expect("fixed slice"));
        let mut name = Vec::new();
        loop {
            let mut byte = [0_u8; 1];
            reader.read_exact(&mut byte).map_err(binary_model_error)?;
            if byte[0] == 0 {
                break;
            }
            name.push(byte[0]);
        }
        let points = read_u64(&mut reader)?;
        let offset = points.checked_mul(24).ok_or_else(|| {
            AppError::new(
                "E-3032",
                ErrorCategory::Engine,
                "Invalid COLMAP Image Observations",
                "An images.bin observation count exceeds the supported size.",
            )
        })?;
        reader
            .seek(SeekFrom::Current(offset as i64))
            .map_err(binary_model_error)?;
        names.push((String::from_utf8_lossy(&name).to_string(), camera_id));
    }
    Ok(names)
}

fn read_text_image_names(path: &Path) -> AppResult<Vec<String>> {
    Ok(read_text_image_camera_pairs(path)?
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

fn read_text_image_camera_pairs(path: &Path) -> AppResult<Vec<(String, u32)>> {
    let reader = BufReader::new(std::fs::File::open(path).map_err(|error| {
        AppError::new(
            "E-1201",
            ErrorCategory::Filesystem,
            "Failed to Read COLMAP Images",
            "Could not open images.txt.",
        )
        .with_technical(error.to_string())
    })?);
    let mut names = Vec::new();
    let mut expect_image = true;
    for line in reader.lines() {
        let line = line.map_err(binary_model_error)?;
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if expect_image {
            if trimmed.is_empty() {
                continue;
            }
            let fields = trimmed.split_whitespace().collect::<Vec<_>>();
            if fields.len() >= 10 {
                let camera_id = fields[8].parse::<u32>().map_err(|error| {
                    AppError::new(
                        "E-3032",
                        ErrorCategory::Engine,
                        "Invalid COLMAP Text Model",
                        "An images.txt camera ID is invalid.",
                    )
                    .with_technical(error.to_string())
                })?;
                names.push((fields[9..].join(" "), camera_id));
            }
            expect_image = false;
        } else {
            // The POINTS2D line is allowed to be empty when an image has no
            // observations. It still terminates the preceding image record.
            expect_image = true;
        }
    }
    Ok(names)
}

/// Validate that every registered model image exists and that its decoded
/// dimensions exactly match the camera produced by image_undistorter.
pub fn validate_model_image_dimensions(model_dir: &Path, image_dir: &Path) -> AppResult<usize> {
    let cameras = read_camera_dimensions(model_dir)?;
    let binary = model_dir.join("images.bin");
    let text = model_dir.join("images.txt");
    let images = if binary.is_file() {
        read_binary_image_camera_pairs(&binary)?
    } else if text.is_file() {
        read_text_image_camera_pairs(&text)?
    } else {
        return Err(AppError::new(
            "E-3031",
            ErrorCategory::Filesystem,
            "COLMAP Image Model Missing",
            "The training model has neither images.bin nor images.txt.",
        ));
    };
    for (name, camera_id) in &images {
        let expected = cameras.get(camera_id).ok_or_else(|| {
            AppError::new(
                "E-3032",
                ErrorCategory::Engine,
                "COLMAP Camera Reference Missing",
                format!("Image '{name}' references missing camera {camera_id}."),
            )
        })?;
        let path = image_dir.join(name);
        let actual = image::image_dimensions(&path).map_err(|error| {
            AppError::new(
                "E-1103",
                ErrorCategory::Media,
                "Training Image Missing or Invalid",
                format!("Could not decode '{}': {error}", path.display()),
            )
        })?;
        if actual != *expected {
            return Err(AppError::new(
                "E-4001",
                ErrorCategory::Engine,
                "Training Camera Dimension Mismatch",
                format!(
                    "Image '{name}' is {}x{} but camera {camera_id} is {}x{}.",
                    actual.0, actual.1, expected.0, expected.1
                ),
            ));
        }
    }
    Ok(images.len())
}

fn read_camera_dimensions(model_dir: &Path) -> AppResult<BTreeMap<u32, (u32, u32)>> {
    let binary = model_dir.join("cameras.bin");
    if binary.is_file() {
        let mut reader = BufReader::new(std::fs::File::open(binary).map_err(binary_model_error)?);
        let count = read_u64(&mut reader)? as usize;
        let mut cameras = BTreeMap::new();
        for _ in 0..count {
            let camera_id = read_u32(&mut reader)?;
            let model_id = read_i32(&mut reader)?;
            let width = read_u64(&mut reader)?;
            let height = read_u64(&mut reader)?;
            let parameter_count = camera_parameter_count(model_id).ok_or_else(|| {
                AppError::new(
                    "E-3032",
                    ErrorCategory::Engine,
                    "Unsupported COLMAP Camera Model",
                    format!("Camera model ID {model_id} is not recognized."),
                )
            })?;
            reader
                .seek(SeekFrom::Current((parameter_count * 8) as i64))
                .map_err(binary_model_error)?;
            let width = u32::try_from(width).map_err(|_| binary_dimension_error(width))?;
            let height = u32::try_from(height).map_err(|_| binary_dimension_error(height))?;
            cameras.insert(camera_id, (width, height));
        }
        return Ok(cameras);
    }
    let text = model_dir.join("cameras.txt");
    let reader = BufReader::new(std::fs::File::open(text).map_err(binary_model_error)?);
    let mut cameras = BTreeMap::new();
    for line in reader.lines() {
        let line = line.map_err(binary_model_error)?;
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.is_empty() || fields[0].starts_with('#') || fields.len() < 4 {
            continue;
        }
        if let (Ok(id), Ok(width), Ok(height)) = (
            fields[0].parse::<u32>(),
            fields[2].parse::<u32>(),
            fields[3].parse::<u32>(),
        ) {
            cameras.insert(id, (width, height));
        }
    }
    Ok(cameras)
}

fn camera_parameter_count(model_id: i32) -> Option<usize> {
    match model_id {
        0 => Some(3),
        1 | 2 | 8 => Some(4),
        3 | 7 | 9 => Some(5),
        4 | 5 => Some(8),
        6 | 10 => Some(12),
        _ => None,
    }
}

fn read_u32(reader: &mut impl Read) -> AppResult<u32> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes).map_err(binary_model_error)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_i32(reader: &mut impl Read) -> AppResult<i32> {
    let mut bytes = [0_u8; 4];
    reader.read_exact(&mut bytes).map_err(binary_model_error)?;
    Ok(i32::from_le_bytes(bytes))
}

fn binary_dimension_error(value: u64) -> AppError {
    AppError::new(
        "E-3032",
        ErrorCategory::Engine,
        "Invalid COLMAP Camera Dimension",
        format!("Camera dimension {value} exceeds the supported range."),
    )
}

fn read_u64(reader: &mut impl Read) -> AppResult<u64> {
    let mut bytes = [0_u8; 8];
    reader.read_exact(&mut bytes).map_err(binary_model_error)?;
    Ok(u64::from_le_bytes(bytes))
}

fn binary_model_error(error: std::io::Error) -> AppError {
    AppError::new(
        "E-3032",
        ErrorCategory::Engine,
        "Invalid COLMAP Binary Model",
        "The selected COLMAP model is truncated or malformed.",
    )
    .with_technical(error.to_string())
}

// ─── Parsing helpers ──────────────────────────────────────────────────────

/// Parse an integer field from model_analyzer output.
///
/// ```text
/// Cameras: 703          → 703
/// Registered images: 0  → 0
/// ```
fn parse_int_field(output: &str, field: &str) -> usize {
    output
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some((_, value)) = trimmed.split_once(field) {
                value.split_whitespace().next().and_then(|v| v.parse().ok())
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// Parse a float field from model_analyzer output.
///
/// Handles:
/// ```text
/// Mean track length: 15.75         → 15.75
/// Mean reprojection error: 0.85px  → 0.85
/// ```
fn parse_float_field(output: &str, field: &str) -> f64 {
    output
        .lines()
        .find_map(|line| {
            let trimmed = line.trim();
            if let Some((_, value)) = trimmed.split_once(field) {
                let raw = value.split_whitespace().next()?;
                // Strip trailing "px" suffix if present
                let cleaned = if let Some(stripped) = raw.strip_suffix("px") {
                    stripped
                } else {
                    raw
                };
                cleaned.parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_binary_camera(file: &mut std::fs::File, camera_id: u32, width: u64, height: u64) {
        file.write_all(&camera_id.to_le_bytes()).unwrap();
        file.write_all(&2_i32.to_le_bytes()).unwrap(); // SIMPLE_RADIAL
        file.write_all(&width.to_le_bytes()).unwrap();
        file.write_all(&height.to_le_bytes()).unwrap();
        for parameter in [8.0_f64, width as f64 / 2.0, height as f64 / 2.0, 0.0] {
            file.write_all(&parameter.to_le_bytes()).unwrap();
        }
    }

    fn write_binary_image(file: &mut std::fs::File, image_id: u32, camera_id: u32, name: &str) {
        file.write_all(&image_id.to_le_bytes()).unwrap();
        for value in [1.0_f64, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] {
            file.write_all(&value.to_le_bytes()).unwrap();
        }
        file.write_all(&camera_id.to_le_bytes()).unwrap();
        file.write_all(name.as_bytes()).unwrap();
        file.write_all(&[0]).unwrap();
        file.write_all(&0_u64.to_le_bytes()).unwrap();
    }

    fn write_binary_dimension_model(model_dir: &Path, images: &[(&str, u32)]) {
        std::fs::create_dir_all(model_dir).unwrap();
        let mut cameras = std::fs::File::create(model_dir.join("cameras.bin")).unwrap();
        cameras.write_all(&1_u64.to_le_bytes()).unwrap();
        write_binary_camera(&mut cameras, 7, 8, 6);
        let mut model_images = std::fs::File::create(model_dir.join("images.bin")).unwrap();
        model_images
            .write_all(&(images.len() as u64).to_le_bytes())
            .unwrap();
        for (index, (name, camera_id)) in images.iter().enumerate() {
            write_binary_image(&mut model_images, index as u32 + 1, *camera_id, name);
        }
    }

    fn sample_output() -> &'static str {
        "Cameras: 703\nImages: 703\nRegistered images: 703\nPoints: 226238\nObservations: 3563506\nMean track length: 15.751138\nMean observations per image: 5068.998578\nMean reprojection error: 0.854211px\n"
    }

    fn colmap_4_output() -> &'static str {
        "I20260713 22:51:29.237229 93340 model.cc:441] Cameras: 1\n\
I20260713 22:51:29.237253 93340 model.cc:445] Images: 197\n\
I20260713 22:51:29.237257 93340 model.cc:446] Registered images: 197\n\
I20260713 22:51:29.237261 93340 model.cc:448] Points: 28456\n\
I20260713 22:51:29.237265 93340 model.cc:449] Observations: 178663\n\
I20260713 22:51:29.237300 93340 model.cc:451] Mean track length: 6.278570\n\
I20260713 22:51:29.237327 93340 model.cc:456] Mean reprojection error: 0.717093px\n"
    }

    // ─── parse_int_field ───────────────────────────────────────────────

    #[test]
    fn test_parse_int_cameras() {
        assert_eq!(parse_int_field(sample_output(), "Cameras:"), 703);
    }

    #[test]
    fn test_parse_int_images() {
        assert_eq!(parse_int_field(sample_output(), "Images:"), 703);
    }

    #[test]
    fn test_parse_int_registered() {
        assert_eq!(parse_int_field(sample_output(), "Registered images:"), 703);
    }

    #[test]
    fn test_parse_int_points() {
        assert_eq!(parse_int_field(sample_output(), "Points:"), 226238);
    }

    #[test]
    fn test_parse_int_observations() {
        assert_eq!(parse_int_field(sample_output(), "Observations:"), 3563506);
    }

    #[test]
    fn test_parse_int_missing_field() {
        assert_eq!(parse_int_field(sample_output(), "Foobar:"), 0);
    }

    #[test]
    fn test_parse_int_empty() {
        assert_eq!(parse_int_field("", "Cameras:"), 0);
    }

    #[test]
    fn test_parse_int_zero() {
        assert_eq!(
            parse_int_field("Registered images: 0", "Registered images:"),
            0
        );
    }

    #[test]
    fn test_parse_colmap_4_prefixed_output() {
        let output = colmap_4_output();
        assert_eq!(parse_int_field(output, "Cameras:"), 1);
        assert_eq!(parse_int_field(output, "Registered images:"), 197);
        assert_eq!(parse_int_field(output, "Points:"), 28_456);
        assert_eq!(parse_int_field(output, "Observations:"), 178_663);
        assert!((parse_float_field(output, "Mean track length:") - 6.278570).abs() < 0.0001);
        assert!((parse_float_field(output, "Mean reprojection error:") - 0.717093).abs() < 0.0001);
    }

    // ─── parse_float_field ─────────────────────────────────────────────

    #[test]
    fn test_parse_float_track_length() {
        let v = parse_float_field(sample_output(), "Mean track length:");
        assert!((v - 15.751138).abs() < 0.0001);
    }

    #[test]
    fn test_parse_float_reprojection_error() {
        let v = parse_float_field(sample_output(), "Mean reprojection error:");
        assert!((v - 0.854211).abs() < 0.0001);
    }

    #[test]
    fn test_parse_float_without_px() {
        let output = "Mean reprojection error: 0.85\n";
        let v = parse_float_field(output, "Mean reprojection error:");
        assert!((v - 0.85).abs() < 0.001);
    }

    #[test]
    fn test_parse_float_missing_field() {
        assert!((parse_float_field(sample_output(), "Foobar:") - 0.0).abs() < 0.001);
    }

    #[test]
    fn test_parse_float_empty() {
        assert!((parse_float_field("", "Mean track length:") - 0.0).abs() < 0.001);
    }

    // ─── find_model_directories ────────────────────────────────────────

    #[test]
    fn test_find_model_directories_empty() {
        let dir = std::env::temp_dir().join("splat-colmap-find-empty");
        let _ = std::fs::create_dir_all(&dir);
        let result = find_model_directories(&dir).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_model_directories_with_cameras_bin() {
        let dir = std::env::temp_dir().join("splat-colmap-find-bin");
        let model_dir = dir.join("0");
        let _ = std::fs::create_dir_all(&model_dir);
        // Create a minimal cameras.bin marker
        std::fs::write(model_dir.join("cameras.bin"), [0u8; 10]).unwrap();

        let result = find_model_directories(&dir).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name().unwrap(), "0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_model_directories_only_valid() {
        let dir = std::env::temp_dir().join("splat-colmap-find-valid");
        let _ = std::fs::create_dir_all(dir.join("0"));
        let _ = std::fs::create_dir_all(dir.join("logs")); // no cameras.bin
        let _ = std::fs::create_dir_all(dir.join("tmp"));

        std::fs::write(dir.join("0").join("cameras.bin"), [0u8; 10]).unwrap();

        let result = find_model_directories(&dir).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].file_name().unwrap(), "0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_binary_training_model_dimensions_and_registered_subset() {
        let temporary = tempfile::tempdir().unwrap();
        let model = temporary.path().join("model");
        let images = temporary.path().join("images");
        write_binary_dimension_model(&model, &[("registered.jpg", 7)]);
        std::fs::create_dir_all(&images).unwrap();
        image::RgbImage::new(8, 6)
            .save(images.join("registered.jpg"))
            .unwrap();
        image::RgbImage::new(8, 6)
            .save(images.join("not-registered.jpg"))
            .unwrap();

        assert_eq!(validate_model_image_dimensions(&model, &images).unwrap(), 1);
    }

    #[test]
    fn rejects_binary_training_image_dimension_mismatch() {
        let temporary = tempfile::tempdir().unwrap();
        let model = temporary.path().join("model");
        let images = temporary.path().join("images");
        write_binary_dimension_model(&model, &[("registered.jpg", 7)]);
        std::fs::create_dir_all(&images).unwrap();
        image::RgbImage::new(7, 6)
            .save(images.join("registered.jpg"))
            .unwrap();

        let error = validate_model_image_dimensions(&model, &images).unwrap_err();
        assert_eq!(error.code, "E-4001");
        assert!(error.user_message.contains("8x6"));
    }

    #[test]
    fn reads_text_model_with_empty_points2d_lines() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("images.txt");
        std::fs::write(
            &path,
            concat!(
                "1 1 0 0 0 0 0 0 1 first.jpg\n",
                "\n",
                "2 1 0 0 0 0 0 0 1 second.jpg\n",
                "\n"
            ),
        )
        .unwrap();

        assert_eq!(
            read_text_image_camera_pairs(&path).unwrap(),
            vec![("first.jpg".into(), 1), ("second.jpg".into(), 1)]
        );
    }
}
