use std::collections::BTreeMap;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, GrayImage, ImageBuffer, ImageReader, Rgb, RgbImage};
use jpeg_decoder::{Decoder as FastJpegDecoder, PixelFormat};
use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_engine_ffmpeg::FrameEntry;
use walkdir::WalkDir;

#[derive(Debug, Clone)]
pub struct ImageCandidate {
    pub path: PathBuf,
    pub relative_path: String,
    pub format: String,
    pub size_bytes: u64,
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub camera: CameraMetadata,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CameraMetadata {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_model: Option<String>,
    pub focal_length_mm: Option<f64>,
    pub focal_length_35mm: Option<u32>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct ImageFrameSource {
    pub filename: String,
    pub source_relative_path: String,
    pub original_width: u32,
    pub original_height: u32,
    pub camera: CameraMetadata,
    pub camera_group_id: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct CameraGroup {
    pub id: String,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens_model: Option<String>,
    pub focal_key: Option<String>,
    pub width: u32,
    pub height: u32,
    pub image_count: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageIssue {
    pub relative_path: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct ImageScan {
    pub images: Vec<ImageCandidate>,
    pub ignored_count: usize,
    pub invalid_items: Vec<ImageIssue>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageFrameManifest {
    pub schema_version: u32,
    pub source_kind: String,
    pub source_image_count: u32,
    pub selected_image_count: u32,
    pub target_long_edge: u32,
    #[serde(default)]
    pub reconstruction_long_edge: u32,
    #[serde(default)]
    pub training_long_edge: u32,
    pub frames: Vec<FrameEntry>,
    #[serde(default)]
    pub frame_sources: Vec<ImageFrameSource>,
    #[serde(default)]
    pub camera_groups: Vec<CameraGroup>,
    pub total_size_bytes: u64,
    pub skipped_items: Vec<ImageIssue>,
}

#[derive(Debug, Clone)]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn scan_image_directory(root: &Path) -> AppResult<ImageScan> {
    if !root.is_dir() {
        return Err(media_error(
            "Image Directory Not Found",
            format!("图片目录 '{}' 不存在或不可访问。", root.display()),
        ));
    }
    let mut images = Vec::new();
    let mut ignored_count = 0;
    let mut invalid_items = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                invalid_items.push(ImageIssue {
                    relative_path: error
                        .path()
                        .and_then(|path| path.strip_prefix(root).ok())
                        .map(normalized_relative)
                        .unwrap_or_else(|| "<无法读取的目录项>".into()),
                    reason: "无法读取文件或目录。".into(),
                });
                continue;
            }
        };
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
            ignored_count += 1;
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map(normalized_relative)
            .unwrap_or_else(|_| entry.file_name().to_string_lossy().to_string());
        let dimensions = ImageReader::open(path)
            .and_then(|reader| reader.with_guessed_format())
            .map_err(image::ImageError::IoError)
            .and_then(ImageReader::into_dimensions);
        let (width, height) = match dimensions {
            Ok((width, height)) if width > 0 && height > 0 => (width, height),
            Ok(_) => {
                invalid_items.push(ImageIssue {
                    relative_path,
                    reason: "图片尺寸无效。".into(),
                });
                continue;
            }
            Err(error) => {
                invalid_items.push(ImageIssue {
                    relative_path,
                    reason: format!("无法读取图片头：{error}"),
                });
                continue;
            }
        };
        let (orientation, camera) = read_exif_metadata(path);
        images.push(ImageCandidate {
            path: path.to_path_buf(),
            relative_path,
            format: extension,
            size_bytes: entry.metadata().map(|metadata| metadata.len()).unwrap_or(0),
            width,
            height,
            orientation,
            camera,
        });
    }
    images.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(ImageScan {
        images,
        ignored_count,
        invalid_items,
    })
}

pub fn uniform_sample_indices(total: usize, limit: usize) -> Vec<usize> {
    if total == 0 || limit == 0 {
        return Vec::new();
    }
    if total <= limit {
        return (0..total).collect();
    }
    if limit == 1 {
        return vec![0];
    }
    (0..limit)
        .map(|index| index * (total - 1) / (limit - 1))
        .collect()
}

pub fn encode_preview(path: &Path, target_long_edge: u32, quality: u8) -> AppResult<EncodedImage> {
    encode_jpeg(path, target_long_edge, quality, None)
}

pub fn normalize_image_to_jpeg(
    source: &Path,
    destination: &Path,
    target_long_edge: u32,
    quality: u8,
) -> AppResult<FrameEntry> {
    let encoded = encode_jpeg(source, target_long_edge, quality, None)?;
    write_normalized_frame(destination, encoded)
}

pub fn normalize_image_to_jpeg_with_orientation(
    source: &Path,
    destination: &Path,
    target_long_edge: u32,
    quality: u8,
    orientation: u32,
) -> AppResult<FrameEntry> {
    let encoded = encode_jpeg(source, target_long_edge, quality, Some(orientation))?;
    write_normalized_frame(destination, encoded)
}

fn write_normalized_frame(destination: &Path, encoded: EncodedImage) -> AppResult<FrameEntry> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            filesystem_error("Failed to Create Frames Directory", error.to_string())
        })?;
    }
    std::fs::write(destination, &encoded.bytes).map_err(|error| {
        filesystem_error(
            "Failed to Write Normalized Image",
            format!("无法写入 '{}': {error}", destination.display()),
        )
    })?;
    Ok(FrameEntry {
        filename: destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string(),
        index: 0,
        width: encoded.width,
        height: encoded.height,
        size_bytes: encoded.bytes.len() as u64,
    })
}

pub fn read_image_manifest(path: &Path) -> AppResult<Option<ImageFrameManifest>> {
    let content = std::fs::read_to_string(path)
        .map_err(|error| filesystem_error("Failed to Read Frame Manifest", error.to_string()))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| media_error("Invalid Frame Manifest", error.to_string()))?;
    if value.get("source_kind").and_then(|value| value.as_str()) != Some("images") {
        return Ok(None);
    }
    let mut manifest: ImageFrameManifest = serde_json::from_value(value)
        .map_err(|error| media_error("Invalid Image Frame Manifest", error.to_string()))?;
    upgrade_legacy_image_manifest(&mut manifest);
    Ok(Some(manifest))
}

fn upgrade_legacy_image_manifest(manifest: &mut ImageFrameManifest) {
    if manifest.reconstruction_long_edge == 0 {
        manifest.reconstruction_long_edge = manifest.target_long_edge;
    }
    if manifest.training_long_edge == 0 {
        manifest.training_long_edge = manifest.target_long_edge;
    }
    if manifest.frame_sources.len() != manifest.frames.len() {
        manifest.frame_sources = manifest
            .frames
            .iter()
            .map(|frame| ImageFrameSource {
                filename: frame.filename.clone(),
                source_relative_path: frame.filename.clone(),
                original_width: frame.width,
                original_height: frame.height,
                ..ImageFrameSource::default()
            })
            .collect();
    }
    if manifest.camera_groups.is_empty()
        || manifest
            .frame_sources
            .iter()
            .any(|source| source.camera_group_id.is_empty())
    {
        manifest.camera_groups =
            assign_camera_groups(&manifest.frames, &mut manifest.frame_sources);
    }
}

/// Assign a deterministic shared camera ID to every prepared image. EXIF
/// identity and focal length are used when available; images without EXIF are
/// grouped by their source and prepared dimensions instead of falling back to
/// one camera per image.
pub fn assign_camera_groups(
    frames: &[FrameEntry],
    sources: &mut [ImageFrameSource],
) -> Vec<CameraGroup> {
    let frame_dimensions = frames
        .iter()
        .map(|frame| (frame.filename.as_str(), (frame.width, frame.height)))
        .collect::<BTreeMap<_, _>>();
    let keys = sources
        .iter()
        .map(|source| {
            let (width, height) = frame_dimensions
                .get(source.filename.as_str())
                .copied()
                .unwrap_or((source.original_width, source.original_height));
            camera_group_key(source, width, height)
        })
        .collect::<Vec<_>>();
    let mut unique = keys.clone();
    unique.sort();
    unique.dedup();
    let ids = unique
        .iter()
        .enumerate()
        .map(|(index, key)| (key.clone(), format!("camera-group-{:03}", index + 1)))
        .collect::<BTreeMap<_, _>>();

    for (source, key) in sources.iter_mut().zip(keys.iter()) {
        source.camera_group_id = ids.get(key).cloned().unwrap_or_default();
    }

    unique
        .into_iter()
        .map(|key| {
            let id = ids.get(&key).cloned().unwrap_or_default();
            let members = sources
                .iter()
                .filter(|source| source.camera_group_id == id)
                .collect::<Vec<_>>();
            let first = members.first().copied();
            let (width, height) = first
                .and_then(|source| frame_dimensions.get(source.filename.as_str()).copied())
                .unwrap_or_default();
            CameraGroup {
                id,
                make: first.and_then(|source| source.camera.make.clone()),
                model: first.and_then(|source| source.camera.model.clone()),
                lens_model: first.and_then(|source| source.camera.lens_model.clone()),
                focal_key: first.and_then(|source| focal_key(&source.camera)),
                width,
                height,
                image_count: members.len() as u32,
            }
        })
        .collect()
}

fn camera_group_key(source: &ImageFrameSource, width: u32, height: u32) -> String {
    let make = normalize_camera_text(source.camera.make.as_deref());
    let model = normalize_camera_text(source.camera.model.as_deref());
    let lens = normalize_camera_text(source.camera.lens_model.as_deref());
    let focal = focal_key(&source.camera).unwrap_or_default();
    let has_exif_identity =
        !make.is_empty() || !model.is_empty() || !lens.is_empty() || !focal.is_empty();
    let fallback = if has_exif_identity {
        String::new()
    } else {
        format!(
            "|source={}x{}",
            source.original_width, source.original_height
        )
    };
    format!("{make}|{model}|{lens}|{focal}|prepared={width}x{height}{fallback}")
}

fn normalize_camera_text(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(char::from(0))
        .to_lowercase()
}

fn focal_key(camera: &CameraMetadata) -> Option<String> {
    if let Some(equivalent) = camera.focal_length_35mm.filter(|value| *value > 0) {
        return Some(format!("35mm:{equivalent}"));
    }
    camera
        .focal_length_mm
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| format!("mm:{:.1}", (value * 2.0).round() / 2.0))
}

pub fn write_image_manifest_atomic(
    manifest: &ImageFrameManifest,
    destination: &Path,
) -> AppResult<()> {
    let temporary = destination.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(manifest)
        .map_err(|error| media_error("Failed to Serialize Image Manifest", error.to_string()))?;
    std::fs::write(&temporary, json)
        .map_err(|error| filesystem_error("Failed to Write Image Manifest", error.to_string()))?;
    if destination.exists() {
        std::fs::remove_file(destination).map_err(|error| {
            filesystem_error("Failed to Replace Image Manifest", error.to_string())
        })?;
    }
    std::fs::rename(temporary, destination)
        .map_err(|error| filesystem_error("Failed to Publish Image Manifest", error.to_string()))
}

pub fn validate_image_manifest(frames_dir: &Path, manifest: &ImageFrameManifest) -> AppResult<()> {
    if manifest.source_kind != "images"
        || !matches!(manifest.schema_version, 2 | 3)
        || manifest.frames.len() < 3
        || manifest.frames.len() != manifest.selected_image_count as usize
    {
        return Err(media_error(
            "Invalid Image Frame Manifest",
            "图片帧清单数量或版本无效。",
        ));
    }
    if manifest.schema_version >= 3 {
        if manifest.frame_sources.len() != manifest.frames.len()
            || manifest.camera_groups.is_empty()
            || manifest
                .frame_sources
                .iter()
                .any(|source| source.camera_group_id.is_empty())
        {
            return Err(media_error(
                "Invalid Image Camera Manifest",
                "图片帧清单缺少相机分组或原始路径映射。",
            ));
        }
    }
    for frame in &manifest.frames {
        if Path::new(&frame.filename).components().count() != 1 {
            return Err(media_error(
                "Invalid Image Frame Path",
                format!("图片帧路径 '{}' 无效。", frame.filename),
            ));
        }
        let path = frames_dir.join(&frame.filename);
        let (width, height) = image::image_dimensions(&path).map_err(|error| {
            media_error(
                "Invalid Normalized Image",
                format!("无法读取 '{}': {error}", path.display()),
            )
        })?;
        if width != frame.width || height != frame.height {
            return Err(media_error(
                "Image Frame Dimension Mismatch",
                format!("图片帧 '{}' 尺寸与清单不一致。", frame.filename),
            ));
        }
    }
    Ok(())
}

fn encode_jpeg(
    path: &Path,
    target_long_edge: u32,
    quality: u8,
    orientation: Option<u32>,
) -> AppResult<EncodedImage> {
    let decoded = decode_image(path, target_long_edge)?;
    let oriented = apply_exif_orientation(
        decoded,
        orientation.unwrap_or_else(|| exif_orientation(path)),
    );
    let rgb = composite_on_white(oriented);
    let (width, height) = rgb.dimensions();
    let resized = if target_long_edge > 0 && width.max(height) > target_long_edge {
        DynamicImage::ImageRgb8(rgb).resize(
            if width >= height {
                target_long_edge
            } else {
                u32::MAX
            },
            if height > width {
                target_long_edge
            } else {
                u32::MAX
            },
            FilterType::Lanczos3,
        )
    } else {
        DynamicImage::ImageRgb8(rgb)
    };
    let (width, height) = resized.dimensions();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, quality)
        .encode_image(&resized)
        .map_err(|error| media_error("Failed to Encode JPEG", error.to_string()))?;
    Ok(EncodedImage {
        bytes,
        width,
        height,
    })
}

fn decode_image(path: &Path, target_long_edge: u32) -> AppResult<DynamicImage> {
    let is_jpeg = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
        });
    if is_jpeg && target_long_edge > 0 {
        return decode_scaled_jpeg(path, target_long_edge);
    }
    image::open(path).map_err(|error| {
        media_error(
            "Failed to Decode Image",
            format!("无法解码 '{}': {error}", path.display()),
        )
    })
}

/// JPEG supports native 1/8, 1/4 and 1/2 IDCT scaling. Decoding close to the
/// requested size avoids allocating hundreds of megabytes for a thumbnail.
fn decode_scaled_jpeg(path: &Path, target_long_edge: u32) -> AppResult<DynamicImage> {
    let file = File::open(path).map_err(|error| {
        filesystem_error(
            "Failed to Open JPEG",
            format!("{}: {error}", path.display()),
        )
    })?;
    let mut decoder = FastJpegDecoder::new(BufReader::new(file));
    decoder.read_info().map_err(|error| {
        media_error(
            "Failed to Read JPEG",
            format!("无法读取 '{}': {error}", path.display()),
        )
    })?;
    let original = decoder.info().ok_or_else(|| {
        media_error(
            "Invalid JPEG Metadata",
            format!("'{}' 没有尺寸信息。", path.display()),
        )
    })?;
    let (requested_width, requested_height) = fit_dimensions(
        original.width as u32,
        original.height as u32,
        target_long_edge,
    );
    decoder
        .scale(requested_width as u16, requested_height as u16)
        .map_err(|error| media_error("Failed to Scale JPEG Decode", error.to_string()))?;
    let pixels = decoder.decode().map_err(|error| {
        media_error(
            "Failed to Decode JPEG",
            format!("无法解码 '{}': {error}", path.display()),
        )
    })?;
    let info = decoder.info().ok_or_else(|| {
        media_error(
            "Invalid JPEG Output",
            format!("'{}' 解码后没有尺寸信息。", path.display()),
        )
    })?;
    let width = info.width as u32;
    let height = info.height as u32;
    match info.pixel_format {
        PixelFormat::RGB24 => RgbImage::from_raw(width, height, pixels)
            .map(DynamicImage::ImageRgb8)
            .ok_or_else(|| media_error("Invalid JPEG Buffer", "JPEG RGB 缓冲区长度无效。")),
        PixelFormat::L8 => GrayImage::from_raw(width, height, pixels)
            .map(DynamicImage::ImageLuma8)
            .ok_or_else(|| media_error("Invalid JPEG Buffer", "JPEG 灰度缓冲区长度无效。")),
        PixelFormat::CMYK32 => {
            let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
            for cmyk in pixels.chunks_exact(4) {
                let c = cmyk[0] as u16;
                let m = cmyk[1] as u16;
                let y = cmyk[2] as u16;
                let k = cmyk[3] as u16;
                rgb.extend_from_slice(&[
                    255_u16.saturating_sub((c + k).min(255)) as u8,
                    255_u16.saturating_sub((m + k).min(255)) as u8,
                    255_u16.saturating_sub((y + k).min(255)) as u8,
                ]);
            }
            RgbImage::from_raw(width, height, rgb)
                .map(DynamicImage::ImageRgb8)
                .ok_or_else(|| media_error("Invalid JPEG Buffer", "JPEG CMYK 缓冲区长度无效。"))
        }
        PixelFormat::L16 => Err(media_error(
            "Unsupported JPEG Precision",
            "暂不支持 16 位灰度 JPEG。",
        )),
    }
}

fn fit_dimensions(width: u32, height: u32, target_long_edge: u32) -> (u32, u32) {
    if target_long_edge == 0 || width.max(height) <= target_long_edge {
        return (width, height);
    }
    if width >= height {
        (
            target_long_edge,
            (height as u64 * target_long_edge as u64 / width as u64).max(1) as u32,
        )
    } else {
        (
            (width as u64 * target_long_edge as u64 / height as u64).max(1) as u32,
            target_long_edge,
        )
    }
}

fn composite_on_white(image: DynamicImage) -> ImageBuffer<Rgb<u8>, Vec<u8>> {
    let rgba = image.to_rgba8();
    ImageBuffer::from_fn(rgba.width(), rgba.height(), |x, y| {
        let pixel = rgba.get_pixel(x, y).0;
        let alpha = pixel[3] as u16;
        let blend = |channel: u8| ((channel as u16 * alpha + 255 * (255 - alpha)) / 255) as u8;
        Rgb([blend(pixel[0]), blend(pixel[1]), blend(pixel[2])])
    })
}

fn exif_orientation(path: &Path) -> u32 {
    let Ok(file) = File::open(path) else {
        return 1;
    };
    let mut reader = BufReader::new(file);
    exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()
        .and_then(|exif| {
            exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|field| field.value.get_uint(0))
        })
        .unwrap_or(1)
}

fn read_exif_metadata(path: &Path) -> (u32, CameraMetadata) {
    let Ok(file) = File::open(path) else {
        return (1, CameraMetadata::default());
    };
    let mut reader = BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return (1, CameraMetadata::default());
    };
    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))
        .unwrap_or(1);
    let focal_length_mm = exif
        .get_field(exif::Tag::FocalLength, exif::In::PRIMARY)
        .and_then(|field| match &field.value {
            exif::Value::Rational(values) => values.first().map(|value| value.to_f64()),
            exif::Value::SRational(values) => values.first().map(|value| value.to_f64()),
            _ => None,
        });
    let focal_length_35mm = exif
        .get_field(exif::Tag::FocalLengthIn35mmFilm, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0));
    (
        orientation,
        CameraMetadata {
            make: exif_ascii(&exif, exif::Tag::Make),
            model: exif_ascii(&exif, exif::Tag::Model),
            lens_model: exif_ascii(&exif, exif::Tag::LensModel),
            focal_length_mm,
            focal_length_35mm,
        },
    )
}

fn exif_ascii(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Ascii(values) = &field.value else {
        return None;
    };
    let value = values.first()?;
    let value = String::from_utf8_lossy(value)
        .trim_matches(char::from(0))
        .trim()
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn apply_exif_orientation(image: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    }
}

fn normalized_relative(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn media_error(title: impl Into<String>, message: impl Into<String>) -> AppError {
    AppError::new("E-1103", ErrorCategory::Media, title, message)
}

fn filesystem_error(title: impl Into<String>, message: impl Into<String>) -> AppError {
    AppError::new("E-1201", ErrorCategory::Filesystem, title, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn uniform_sampling_is_stable_and_keeps_endpoints() {
        assert_eq!(uniform_sample_indices(10, 4), vec![0, 3, 6, 9]);
        assert_eq!(uniform_sample_indices(3, 10), vec![0, 1, 2]);
    }

    #[test]
    fn recursively_scans_chinese_paths_uppercase_and_classifies_files() {
        let root = tempfile::tempdir().unwrap();
        let nested = root.path().join("自行车").join("子目录");
        std::fs::create_dir_all(&nested).unwrap();
        image::RgbImage::from_pixel(8, 6, image::Rgb([1, 2, 3]))
            .save_with_format(nested.join("照片.JPG"), image::ImageFormat::Jpeg)
            .unwrap();
        RgbaImage::from_pixel(4, 5, Rgba([1, 2, 3, 200]))
            .save_with_format(root.path().join("透明.PNG"), image::ImageFormat::Png)
            .unwrap();
        std::fs::write(root.path().join("损坏.jpeg"), b"not an image").unwrap();
        std::fs::write(root.path().join("notes.txt"), b"ignored").unwrap();

        let scan = scan_image_directory(root.path()).unwrap();
        assert_eq!(scan.images.len(), 2);
        assert_eq!(scan.ignored_count, 1);
        assert_eq!(scan.invalid_items.len(), 1);
        assert_eq!(scan.images[0].relative_path, "自行车/子目录/照片.JPG");
        assert_eq!((scan.images[0].width, scan.images[0].height), (8, 6));
    }

    #[test]
    fn normalization_downscales_and_composites_transparency_on_white() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("alpha.png");
        let destination = root.path().join("000001.jpg");
        RgbaImage::from_pixel(20, 10, Rgba([255, 0, 0, 0]))
            .save(&source)
            .unwrap();
        let frame = normalize_image_to_jpeg(&source, &destination, 10, 95).unwrap();
        assert_eq!((frame.width, frame.height), (10, 5));
        let pixel = image::open(destination)
            .unwrap()
            .to_rgb8()
            .get_pixel(5, 2)
            .0;
        assert!(pixel.iter().all(|channel| *channel > 245));
    }

    #[test]
    fn exif_orientation_transform_swaps_dimensions() {
        let image = DynamicImage::new_rgb8(7, 3);
        assert_eq!(apply_exif_orientation(image, 6).dimensions(), (3, 7));
    }

    #[test]
    fn scans_configured_real_image_directory() {
        let Ok(directory) = std::env::var("METORIGIN_TEST_IMAGE_DIR") else {
            return;
        };
        let scan = scan_image_directory(Path::new(&directory)).unwrap();
        assert!(scan.images.len() >= 3);
        if let Ok(expected) = std::env::var("METORIGIN_TEST_IMAGE_COUNT") {
            assert_eq!(scan.images.len(), expected.parse::<usize>().unwrap());
        }
        let indices = uniform_sample_indices(scan.images.len(), 6);
        assert_eq!(indices.first().copied(), Some(0));
        assert_eq!(indices.last().copied(), Some(scan.images.len() - 1));
        for index in indices {
            let preview = encode_preview(&scan.images[index].path, 360, 82).unwrap();
            assert!(preview.width.max(preview.height) <= 360);
            assert!(!preview.bytes.is_empty());
        }
    }

    #[test]
    fn normalizes_configured_real_image_directory_when_enabled() {
        let Ok(directory) = std::env::var("METORIGIN_TEST_IMAGE_NORMALIZE") else {
            return;
        };
        let scan = scan_image_directory(Path::new(&directory)).unwrap();
        let output = tempfile::tempdir().unwrap();
        let selected = uniform_sample_indices(scan.images.len(), 300);
        for (position, source_index) in selected.iter().copied().enumerate() {
            let frame = normalize_image_to_jpeg(
                &scan.images[source_index].path,
                &output.path().join(format!("{:06}.jpg", position + 1)),
                1280,
                92,
            )
            .unwrap();
            assert!(frame.width.max(frame.height) <= 1280);
        }
        assert_eq!(selected.len(), scan.images.len().min(300));
    }
}
