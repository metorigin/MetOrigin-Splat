//! Image export bypasses WKDownload; only a native save dialog supplies a path.

use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::EditorState;
use crate::{lifecycle::PendingWork, state::AppState};

const MAX_IMAGE_BYTES: usize = 256 * 1024 * 1024;
const INVALID_SESSION: &str = "编辑会话已失效，请从项目重新打开编辑器。";
const INVALID_IMAGE: &str = "图像格式无效或文件已截断。";

#[derive(Clone, Copy)]
pub(super) enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "png" => Ok(Self::Png),
            "jpeg" => Ok(Self::Jpeg),
            "webp" => Ok(Self::Webp),
            _ => Err("仅支持 PNG、JPEG 和 WebP 图像。".into()),
        }
    }

    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::Png => &["png"],
            Self::Jpeg => &["jpg", "jpeg"],
            Self::Webp => &["webp"],
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
            Self::Webp => "WebP",
        }
    }

    fn validate(self, bytes: &[u8]) -> Result<(), String> {
        validate_size(bytes.len())?;
        // Inspect container boundaries and required headers without decoding or
        // allocating a pixel buffer. This byte limit is not a pixel-size limit:
        // a large render can still exceed it, regardless of its UI dimensions.
        let valid = match self {
            Self::Png => valid_png(bytes),
            Self::Jpeg => valid_jpeg(bytes),
            Self::Webp => valid_webp(bytes),
        };
        valid.then_some(()).ok_or_else(|| INVALID_IMAGE.into())
    }
}

fn validate_size(length: usize) -> Result<(), String> {
    if length == 0 || length > MAX_IMAGE_BYTES {
        return Err("图像为空或超过 256 MiB 保存上限。".into());
    }
    Ok(())
}

fn be32(bytes: &[u8]) -> u32 {
    u32::from_be_bytes(bytes[..4].try_into().unwrap())
}

fn le32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().unwrap())
}

fn valid_png(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let mut offset = 8;
    let mut header = false;
    let mut data = false;
    while let Some(chunk) = bytes.get(offset..).filter(|chunk| chunk.len() >= 12) {
        let length = be32(chunk) as usize;
        let Some(end) = offset
            .checked_add(length)
            .and_then(|end| end.checked_add(12))
        else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        match &chunk[4..8] {
            b"IHDR" => {
                if header
                    || offset != 8
                    || length != 13
                    || be32(&chunk[8..12]) == 0
                    || be32(&chunk[12..16]) == 0
                {
                    return false;
                }
                header = true;
            }
            b"IDAT" => {
                if !header {
                    return false;
                }
                data |= length > 0;
            }
            b"IEND" => return header && data && length == 0 && end == bytes.len(),
            _ if !header => return false,
            _ => {}
        }
        offset = end;
    }
    false
}

fn valid_jpeg(bytes: &[u8]) -> bool {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return false;
    }
    let mut offset = 2;
    let mut frame = false;
    let mut scan = false;
    let mut in_scan = false;
    let mut entropy = false;
    while offset < bytes.len() {
        if in_scan && bytes[offset] != 0xff {
            entropy = true;
            offset += 1;
            continue;
        }
        if bytes[offset] != 0xff {
            return false;
        }
        while bytes.get(offset) == Some(&0xff) {
            offset += 1;
        }
        let Some(&marker) = bytes.get(offset) else {
            return false;
        };
        offset += 1;
        if in_scan && (marker == 0 || (0xd0..=0xd7).contains(&marker)) {
            entropy |= marker == 0;
            continue;
        }
        in_scan = false;
        if marker == 0xd9 {
            return frame && scan && entropy && offset == bytes.len();
        }
        if marker == 0 || marker == 0xd8 || (0xd0..=0xd7).contains(&marker) {
            return false;
        }
        if marker == 1 {
            continue;
        }
        let Some(segment) = bytes.get(offset..).filter(|segment| segment.len() >= 2) else {
            return false;
        };
        let length = u16::from_be_bytes([segment[0], segment[1]]) as usize;
        if length < 2 || length > segment.len() {
            return false;
        }
        let segment = &segment[..length];
        if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
            if length < 11
                || segment[3..5] == [0, 0]
                || segment[5..7] == [0, 0]
                || segment[7] == 0
                || length != 8 + 3 * segment[7] as usize
            {
                return false;
            }
            frame = true;
        }
        if marker == 0xda {
            if !frame || length < 8 || segment[2] == 0 || length != 6 + 2 * segment[2] as usize {
                return false;
            }
            scan = true;
            in_scan = true;
        }
        offset += length;
    }
    false
}

fn valid_webp(bytes: &[u8]) -> bool {
    if bytes.len() < 12
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
        || le32(&bytes[4..8]) as u64 + 8 != bytes.len() as u64
    {
        return false;
    }
    let mut offset = 12;
    let mut image = false;
    while let Some(chunk) = bytes.get(offset..).filter(|chunk| chunk.len() >= 8) {
        let length = le32(&chunk[4..8]) as usize;
        let Some(end) = offset
            .checked_add(8)
            .and_then(|n| n.checked_add(length))
            .and_then(|n| n.checked_add(length & 1))
        else {
            return false;
        };
        if end > bytes.len() {
            return false;
        }
        match &chunk[..4] {
            b"VP8L" => {
                if image || length < 6 || chunk[8] != 0x2f || chunk[12] & 0xe0 != 0 {
                    return false;
                }
                image = true;
            }
            b"VP8 " => {
                if image
                    || length < 10
                    || chunk[8] & 1 != 0
                    || chunk[11..14] != [0x9d, 0x01, 0x2a]
                    || u16::from_le_bytes([chunk[14], chunk[15]]) & 0x3fff == 0
                    || u16::from_le_bytes([chunk[16], chunk[17]]) & 0x3fff == 0
                {
                    return false;
                }
                image = true;
            }
            b"VP8X" if offset != 12 || length != 10 || chunk[8] & 2 != 0 => return false,
            b"ANIM" | b"ANMF" => return false,
            _ => {}
        }
        offset = end;
    }
    image && offset == bytes.len()
}

pub(super) struct ExportLease {
    active: Arc<Mutex<HashSet<(String, String)>>>,
    key: (String, String),
}

impl Drop for ExportLease {
    fn drop(&mut self) {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

fn check_session(editors: &EditorState, label: &str, session_id: &str) -> Result<(), String> {
    let sessions = editors.0.lock().map_err(|_| INVALID_SESSION)?;
    if !sessions
        .get(label)
        .is_some_and(|session| session.session_id == session_id)
    {
        return Err(INVALID_SESSION.into());
    }
    Ok(())
}

pub(super) fn reserve_export(
    editors: &EditorState,
    label: &str,
    session_id: &str,
) -> Result<ExportLease, String> {
    // The lock order matches write/close: current session first, export lease second.
    let sessions = editors.0.lock().map_err(|_| INVALID_SESSION)?;
    if !sessions
        .get(label)
        .is_some_and(|session| session.session_id == session_id)
    {
        return Err(INVALID_SESSION.into());
    }
    let key = (label.to_string(), session_id.to_string());
    if !editors
        .1
        .lock()
        .map_err(|_| "无法读取图像保存状态。")?
        .insert(key.clone())
    {
        return Err("图像正在保存，请等待当前导出结束。".into());
    }
    Ok(ExportLease {
        active: editors.1.clone(),
        key,
    })
}

fn destination_path(path: &Path, format: ImageFormat) -> Result<PathBuf, String> {
    let filename = path.file_name().ok_or("图像保存路径无效。")?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !path.is_absolute()
        || !format
            .extensions()
            .iter()
            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err(format!(
            "请选择以 .{} 结尾的图像文件。",
            format.extensions()[0]
        ));
    }
    let parent = path
        .parent()
        .ok_or("图像保存目录无效。")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let destination = parent.join(filename);
    if destination.to_str().is_none() {
        return Err("图像保存路径无法表示为文本。".into());
    }
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("请选择普通图像文件，不能覆盖目录或符号链接。".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(destination)
}

struct TemporaryImage(PathBuf);

impl Drop for TemporaryImage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn atomic_write_image(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary_path =
        destination.with_file_name(format!(".metorigin-image-{}.tmp", uuid::Uuid::now_v7()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|e| e.to_string())?;
    // Own cleanup only after exclusive creation; never remove an existing file
    // if a collision or open error prevented us from acquiring this path.
    let temporary = TemporaryImage(temporary_path);
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    // Replace a directory entry rather than following/truncating the old file.
    // Failure preserves the existing target and the guard removes the temporary.
    fs::rename(&temporary.0, destination).map_err(|e| e.to_string())
}

pub(super) fn write_for_session(
    editors: &EditorState,
    label: &str,
    session_id: &str,
    path: &Path,
    bytes: &[u8],
    format: ImageFormat,
) -> Result<String, String> {
    let sessions = editors.0.lock().map_err(|_| INVALID_SESSION)?;
    if !sessions
        .get(label)
        .is_some_and(|session| session.session_id == session_id)
    {
        return Err(INVALID_SESSION.into());
    }
    // Keep close/reopen serialized through the final rename. Once close returns,
    // this session can no longer write, even if its save dialog completed late.
    let destination = destination_path(path, format)?;
    atomic_write_image(&destination, bytes)?;
    Ok(destination.to_str().unwrap().to_string())
}

pub(super) async fn save_editor_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>, String> {
    let pending = PendingWork::begin(app.state::<AppState>().inner())?;
    let session_id = request
        .headers()
        .get("x-editor-session")
        .and_then(|value| value.to_str().ok())
        .ok_or(INVALID_SESSION)?
        .to_string();
    let format = ImageFormat::parse(
        request
            .headers()
            .get("x-image-format")
            .and_then(|value| value.to_str().ok())
            .ok_or("缺少图像格式。")?,
    )?;
    let raw = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        _ => return Err("请以二进制格式保存图像。".into()),
    };
    format.validate(raw)?;
    let label = window.label().to_string();
    let lease = reserve_export(&app.state::<EditorState>(), &label, &session_id)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("保存图像")
        .set_file_name(format!("scene.{}", format.extensions()[0]))
        .add_filter(format.label(), format.extensions())
        .save_file(move |selected| {
            let _ = send.send(selected);
        });
    let Some(selected) = receive.await.map_err(|_| "保存对话框未返回结果。")? else {
        return Ok(None);
    };
    // No file is opened for cancellation, nor for a session closed during the dialog.
    check_session(&app.state::<EditorState>(), &label, &session_id)?;
    let path = selected.into_path().map_err(|e| e.to_string())?;
    let bytes = raw.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // These guards must outlive the worker, even if the IPC caller goes away.
        let _pending = pending;
        let _lease = lease;
        write_for_session(
            &app.state::<EditorState>(),
            &label,
            &session_id,
            &path,
            &bytes,
            format,
        )
        .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Directory(PathBuf);

    impl Directory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("metorigin-image-test-{}", uuid::Uuid::now_v7()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn encoded(format: image::ImageFormat) -> Vec<u8> {
        let image = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            2,
            3,
            image::Rgb([12, 34, 56]),
        ));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, format).unwrap();
        output.into_inner()
    }

    fn lossless_webp_container() -> Vec<u8> {
        // A structural fixture, not a decoder test: 1x1 VP8L header and payload.
        let mut bytes = b"RIFF\x1a\x00\x00\x00WEBPVP8L\x0d\x00\x00\x00".to_vec();
        bytes.extend_from_slice(&[
            0x2f, 0, 0, 0, 0, 7, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 7, 0,
        ]);
        bytes
    }

    #[test]
    fn validates_encoded_png_jpeg_and_webp_container_without_decoding() {
        let png = encoded(image::ImageFormat::Png);
        let jpeg = encoded(image::ImageFormat::Jpeg);
        let webp = lossless_webp_container();
        for (format, bytes) in [
            (ImageFormat::Png, png),
            (ImageFormat::Jpeg, jpeg),
            (ImageFormat::Webp, webp),
        ] {
            format.validate(&bytes).unwrap();
            assert!(format.validate(&bytes[..bytes.len() - 1]).is_err());
            assert!(format.validate(&bytes[..bytes.len() / 2]).is_err());
            assert!(format.validate(b"not an image").is_err());
        }
        assert!(ImageFormat::Webp
            .validate(&encoded(image::ImageFormat::Png))
            .is_err());
        assert!(ImageFormat::parse("gif").is_err());
    }

    #[test]
    fn rejects_false_headers_and_invalid_chunk_boundaries() {
        assert!(ImageFormat::Png.validate(b"\x89PNG\r\n\x1a\n").is_err());
        assert!(ImageFormat::Jpeg
            .validate(&[0xff, 0xd8, 0xff, 0xd9])
            .is_err());
        let mut png = encoded(image::ImageFormat::Png);
        png[8..12].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(ImageFormat::Png.validate(&png).is_err());
        let mut webp = lossless_webp_container();
        webp[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(ImageFormat::Webp.validate(&webp).is_err());
        let mut webp = lossless_webp_container();
        webp[4] += 2;
        assert!(ImageFormat::Webp.validate(&webp).is_err());
        let mut jpeg = encoded(image::ImageFormat::Jpeg);
        jpeg[4..6].copy_from_slice(&u16::MAX.to_be_bytes());
        assert!(ImageFormat::Jpeg.validate(&jpeg).is_err());
    }

    #[test]
    fn size_limit_is_checked_without_allocating_a_large_image() {
        assert!(validate_size(0).is_err());
        validate_size(MAX_IMAGE_BYTES).unwrap();
        assert!(validate_size(MAX_IMAGE_BYTES + 1).is_err());
        assert!(validate_size(usize::MAX).is_err());
    }

    #[test]
    fn selected_path_must_have_the_expected_extension() {
        let directory = Directory::new();
        for name in [
            "scene.ply",
            "project.json",
            "image.webp.ply",
            "image",
            "image.jpg",
        ] {
            let path = directory.0.join(name);
            fs::write(&path, b"original").unwrap();
            assert!(destination_path(&path, ImageFormat::Webp).is_err());
            assert_eq!(fs::read(path).unwrap(), b"original");
        }
        for name in ["scene.jpg", "scene.jpeg", "scene.JPEG"] {
            assert!(destination_path(&directory.0.join(name), ImageFormat::Jpeg).is_ok());
        }
        assert!(destination_path(Path::new("relative.webp"), ImageFormat::Webp).is_err());
        fs::create_dir(directory.0.join("directory.webp")).unwrap();
        assert!(destination_path(&directory.0.join("directory.webp"), ImageFormat::Webp).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_image_named_symlink_to_a_project_file() {
        let directory = Directory::new();
        let protected = directory.0.join("project.json");
        fs::write(&protected, b"project").unwrap();
        let alias = directory.0.join("scene.webp");
        std::os::unix::fs::symlink(&protected, &alias).unwrap();
        assert!(destination_path(&alias, ImageFormat::Webp).is_err());
        assert_eq!(fs::read(protected).unwrap(), b"project");
    }

    #[test]
    fn replaces_only_the_selected_image_and_removes_temporary_files() {
        let directory = Directory::new();
        let selected = directory.0.join("image.png");
        fs::write(&selected, b"old image").unwrap();
        let bytes = encoded(image::ImageFormat::Png);
        let path = destination_path(&selected, ImageFormat::Png).unwrap();
        atomic_write_image(&path, &bytes).unwrap();
        assert_eq!(fs::read(selected).unwrap(), bytes);
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_rename_preserves_the_destination_and_cleans_the_owned_temporary() {
        let directory = Directory::new();
        let destination = directory.0.join("occupied.png");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"old target").unwrap();
        // Exercise a real rename failure after temporary creation/write/sync.
        // The public flow rejects this directory even earlier in path validation.
        assert!(atomic_write_image(&destination, b"new image").is_err());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"old target");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
