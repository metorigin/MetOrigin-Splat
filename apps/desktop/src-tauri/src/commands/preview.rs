use super::system::resources::{self, PreviewAction, PreviewResourcePolicy};
use splat_engine_brush::live_preview::{self, Frame, Request, Session};
use splat_engine_brush::ExportManager;
use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_PLY_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
pub struct GaussianCamera {
    position: [f64; 3],
    forward: [f64; 3],
    up: [f64; 3],
    fov_y_degrees: f64,
}

/// Start inside the captured camera coverage instead of outside a cloud of
/// background Gaussians. Prepared COLMAP coordinates match Brush's PLY output.
#[tauri::command]
pub async fn get_gaussian_camera(
    project_id: String,
    project_path: String,
) -> Result<Option<GaussianCamera>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = project_root(&project_path, &project_id)?;
        let prepared = "training/dataset/sparse/0";
        let model = if root.join(prepared).join("images.bin").exists() {
            prepared.to_string()
        } else if let Ok(value) = read_json::<serde_json::Value>(&root.join("colmap/result.json")) {
            value["model_path"]
                .as_str()
                .unwrap_or("colmap/sparse/0")
                .replace('\\', "/")
        } else {
            return Ok(None);
        };
        let images = safe_path(&root, &format!("{model}/images.bin"))?;
        let mut file = File::open(images).map_err(|e| e.to_string())?;
        let mut header = [0_u8; 72];
        if file.read_exact(&mut header).is_err()
            || u64::from_le_bytes(header[0..8].try_into().unwrap()) == 0
        {
            return Ok(None);
        }
        let number =
            |start: usize| f64::from_le_bytes(header[start..start + 8].try_into().unwrap());
        let mut q = [number(12), number(20), number(28), number(36)];
        let t = [number(44), number(52), number(60)];
        if !q.iter().chain(t.iter()).all(|v| v.is_finite()) {
            return Ok(None);
        }
        let norm = q.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm < 1e-10 {
            return Ok(None);
        }
        q.iter_mut().for_each(|v| *v /= norm);
        let [w, x, y, z] = q;
        let r = [
            [
                1.0 - 2.0 * (y * y + z * z),
                2.0 * (x * y - z * w),
                2.0 * (x * z + y * w),
            ],
            [
                2.0 * (x * y + z * w),
                1.0 - 2.0 * (x * x + z * z),
                2.0 * (y * z - x * w),
            ],
            [
                2.0 * (x * z - y * w),
                2.0 * (y * z + x * w),
                1.0 - 2.0 * (x * x + y * y),
            ],
        ];
        let position = [0, 1, 2].map(|i| -(r[0][i] * t[0] + r[1][i] * t[1] + r[2][i] * t[2]));
        let camera_id = u32::from_le_bytes(header[68..72].try_into().unwrap());
        let intrinsics = safe_path(&root, &format!("{model}/cameras.bin"))?;
        let fov_y_degrees = read_camera_fov(&intrinsics, camera_id).unwrap_or(52.0);
        Ok(Some(GaussianCamera {
            position,
            forward: r[2],
            up: r[1].map(|v| -v),
            fov_y_degrees,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn read_camera_fov(path: &Path, wanted: u32) -> Option<f64> {
    let mut file = BufReader::new(File::open(path).ok()?);
    let mut word = [0_u8; 8];
    file.read_exact(&mut word).ok()?;
    let count = u64::from_le_bytes(word).min(10000);
    for _ in 0..count {
        let mut header = [0_u8; 24];
        file.read_exact(&mut header).ok()?;
        let id = u32::from_le_bytes(header[0..4].try_into().ok()?);
        let model = u32::from_le_bytes(header[4..8].try_into().ok()?);
        let height = u64::from_le_bytes(header[16..24].try_into().ok()?) as f64;
        // Prepared undistorted datasets use SIMPLE_PINHOLE or PINHOLE.
        let parameters = match model {
            0 => 3,
            1 => 4,
            _ => return None,
        };
        let mut values = vec![0.0; parameters];
        for value in &mut values {
            file.read_exact(&mut word).ok()?;
            *value = f64::from_le_bytes(word);
        }
        if id == wanted {
            let fy = values[usize::from(model == 1)];
            if !fy.is_finite() || fy <= 0.0 || height <= 0.0 {
                return None;
            }
            return Some(
                (2.0 * (height / (2.0 * fy)).atan())
                    .to_degrees()
                    .clamp(10.0, 140.0),
            );
        }
    }
    None
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct GaussianPreviewSource {
    pub(super) relative_path: String,
    pub(super) revision: String,
    pub(super) vertex_count: u64,
    pub(super) size_bytes: u64,
    iteration: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct LivePreviewStatus {
    session_id: Option<String>,
    available: bool,
    running: bool,
    revision: u64,
    frame: Option<GaussianPreviewSource>,
    resource_policy: PreviewResourcePolicy,
}

pub(super) fn project_root(project_path: &str, project_id: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|_| "项目目录不存在。")?;
    let value: serde_json::Value = read_json(&root.join("project.json"))?;
    if value["id"].as_str() != Some(project_id) {
        return Err("项目身份不匹配。".into());
    }
    Ok(root)
}

pub(super) fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|item| !matches!(item, Component::Normal(_)))
    {
        return Err("预览路径超出项目目录。".into());
    }
    let resolved = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "预览文件尚未生成或已被移除。")?;
    if !resolved.starts_with(root) {
        return Err("预览路径超出项目目录。".into());
    }
    Ok(resolved)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    serde_json::from_reader(file.take(1024 * 1024)).map_err(|error| error.to_string())
}

fn revision(metadata: &std::fs::Metadata) -> String {
    format!(
        "{}:{}",
        metadata.len(),
        metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_nanos())
            .unwrap_or(0)
    )
}

/// Inspect bounded header/layout metadata; the actual response bytes are fully
/// validated separately before IPC publication. This does not read every vertex.
pub(super) fn ply_vertex_count(file: &mut File) -> Result<u64, String> {
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_PLY_BYTES {
        return Err("该 PLY 超过当前预览的 1 GiB 文件上限。".into());
    }
    ExportManager::read_preview_header(file)
        .map(|metadata| metadata.vertex_count)
        .map_err(|_| "PLY 文件头、布局或长度无效。".into())
}

pub(super) fn source(
    root: &Path,
    relative_path: &str,
    iteration: Option<u32>,
) -> Result<GaussianPreviewSource, String> {
    if !relative_path.to_ascii_lowercase().ends_with(".ply") {
        return Err("只能预览 PLY 模型。".into());
    }
    let path = safe_path(root, relative_path)?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let vertex_count = ply_vertex_count(&mut file)?;
    Ok(GaussianPreviewSource {
        relative_path: relative_path.replace('\\', "/"),
        revision: revision(&metadata),
        vertex_count,
        size_bytes: metadata.len(),
        iteration,
    })
}

#[tauri::command]
pub async fn get_gaussian_preview(
    project_id: String,
    project_path: String,
    relative_path: Option<String>,
) -> Result<GaussianPreviewSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        source(
            &project_root(&project_path, &project_id)?,
            relative_path.as_deref().unwrap_or("output/scene.ply"),
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_gaussian_ply(
    project_id: String,
    project_path: String,
    relative_path: String,
    expected_revision: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_gaussian_ply_with_policy(
            project_id,
            project_path,
            relative_path,
            expected_revision,
            resources::current_preview_policy,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn read_gaussian_ply_with_policy(
    project_id: String,
    project_path: String,
    relative_path: String,
    expected_revision: String,
    observe_policy: impl FnOnce() -> PreviewResourcePolicy,
) -> Result<tauri::ipc::Response, String> {
    let root = project_root(&project_path, &project_id)?;
    if !relative_path.to_ascii_lowercase().ends_with(".ply") {
        return Err("只能读取 PLY 模型。".into());
    }
    let mut file =
        File::open(safe_path(&root, &relative_path)?).map_err(|error| error.to_string())?;
    let before = file.metadata().map_err(|error| error.to_string())?;
    if revision(&before) != expected_revision {
        return Err("预览文件已更新，请重新读取。".into());
    }
    if before.len() > MAX_PLY_BYTES || !before.is_file() {
        return Err("PLY 文件无效或超过当前预览的 1 GiB 文件上限。".into());
    }
    let policy = observe_policy();
    if policy.action != PreviewAction::Allow || before.len() > policy.max_snapshot_bytes {
        return Err(
            "当前可用内存不足以加载完整预览；训练与检查点未改变，内存恢复后可重试。".into(),
        );
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let capacity = usize::try_from(before.len()).map_err(|_| "模型过大，无法加载预览。")?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity.saturating_add(1))
        .map_err(|_| "没有足够内存加载完整模型预览。")?;
    file.by_ref()
        .take(before.len().saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != before.len()
        || revision(&file.metadata().map_err(|error| error.to_string())?) != expected_revision
    {
        return Err("读取期间模型发生变化，请重试。".into());
    }
    ExportManager::inspect_preview_bytes(&bytes)
        .map_err(|_| "PLY 数据不完整或包含无效高斯参数。")?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Cheap independent sampling while a model read/GPU upload is in flight.
#[tauri::command]
pub(crate) fn get_preview_resource_policy() -> PreviewResourcePolicy {
    resources::current_preview_policy()
}

#[tauri::command]
pub async fn poll_live_preview(
    project_id: String,
    project_path: String,
    mode: String,
    after_revision: u64,
    session_id: Option<String>,
) -> Result<LivePreviewStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        poll_live_preview_with_policy(
            project_id,
            project_path,
            mode,
            after_revision,
            session_id,
            resources::current_preview_policy(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn poll_live_preview_with_policy(
    project_id: String,
    project_path: String,
    mode: String,
    after_revision: u64,
    session_id: Option<String>,
    mut policy: PreviewResourcePolicy,
) -> Result<LivePreviewStatus, String> {
    if !["live", "low", "off"].contains(&mode.as_str()) {
        return Err("预览刷新模式无效。".into());
    }
    let root = project_root(&project_path, &project_id)?;
    let empty = LivePreviewStatus {
        session_id: None,
        available: false,
        running: false,
        revision: 0,
        frame: None,
        resource_policy: policy.clone(),
    };
    if !root
        .join(live_preview::DIRECTORY)
        .join("session.json")
        .exists()
    {
        return Ok(empty);
    }
    let session: Session = read_json(&safe_path(
        &root,
        &format!("{}/session.json", live_preview::DIRECTORY),
    )?)?;
    if session.protocol != live_preview::PROTOCOL {
        return Err("训练预览协议版本不匹配。".into());
    }
    if uuid::Uuid::parse_str(&session.session_id).is_err() {
        return Err("训练预览会话无效。".into());
    }
    let relative_dir = format!("{}/{}", live_preview::DIRECTORY, session.session_id);
    let directory = safe_path(&root, &relative_dir)?;
    let latest: Option<Frame> = if directory.join("latest.json").exists() {
        Some(read_json(&safe_path(
            &root,
            &format!("{relative_dir}/latest.json"),
        )?)?)
    } else {
        None
    };
    if latest.as_ref().is_some_and(|frame| {
        frame.protocol != live_preview::PROTOCOL || frame.session_id != session.session_id
    }) {
        return Err("训练预览帧不属于当前协议或会话。".into());
    }
    // Validate frame identity/layout before writing an ACK request. Do not
    // acknowledge corrupt or stale frames and thereby release their slots.
    let frame_source = latest
        .as_ref()
        .map(|frame| -> Result<GaussianPreviewSource, String> {
            if frame.relative_path != format!("frame-{}.ply", frame.revision) {
                return Err("训练预览帧路径无效。".into());
            }
            let source = source(
                &root,
                &format!("{relative_dir}/{}", frame.relative_path),
                Some(frame.iteration),
            )?;
            if source.vertex_count != u64::from(frame.splat_count) {
                return Err("训练预览帧高斯数量与模型不符。".into());
            }
            Ok(source)
        })
        .transpose()?;
    if session_id.as_deref() == Some(&session.session_id)
        && latest
            .as_ref()
            .is_some_and(|frame| after_revision > frame.revision)
    {
        return Err("预览确认版本超出当前帧。".into());
    }
    if frame_source
        .as_ref()
        .is_some_and(|source| source.size_bytes > policy.max_snapshot_bytes)
        && policy.action == PreviewAction::Allow
    {
        policy.action = PreviewAction::Pause;
        policy.reason = Some("snapshot_budget");
    }
    let mode = if policy.action == PreviewAction::Allow {
        mode
    } else {
        "off".into()
    };
    if session.available && session.running {
        let request_path = directory.join("request.json");
        if request_path.exists() {
            safe_path(&root, &format!("{relative_dir}/request.json"))?;
        }
        live_preview::write_json_atomic(
            &request_path,
            &Request {
                session_id: session.session_id.clone(),
                after_revision: if session_id.as_deref() == Some(&session.session_id) {
                    after_revision
                } else {
                    0
                },
                mode,
                expires_at_ms: chrono::Utc::now().timestamp_millis().max(0) as u64 + 10_000,
            },
        )
        .map_err(|error| error.to_string())?;
    }
    let frame_source = if policy.action != PreviewAction::Allow
        || (session_id.as_deref() == Some(&session.session_id)
            && latest
                .as_ref()
                .is_some_and(|frame| frame.revision <= after_revision))
    {
        None
    } else {
        frame_source
    };
    Ok(LivePreviewStatus {
        session_id: Some(session.session_id),
        available: session.available,
        running: session.running,
        revision: latest.map(|frame| frame.revision).unwrap_or(0),
        frame: frame_source,
        resource_policy: policy,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_preserves_the_full_count_and_rejects_partial_writes() {
        let path =
            std::env::temp_dir().join(format!("gaussian-preview-{}.ply", uuid::Uuid::now_v7()));
        let names = [
            "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
            "opacity", "f_dc_0", "f_dc_1", "f_dc_2",
        ];
        let header = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex 200001\n{}end_header\n",
            names
                .map(|name| format!("property float {name}\n"))
                .join("")
        );
        let mut data = header.into_bytes();
        data.resize(data.len() + 200001 * names.len() * 4, 0);
        std::fs::write(&path, &data).unwrap();
        assert_eq!(
            ply_vertex_count(&mut File::open(&path).unwrap()).unwrap(),
            200001
        );
        data.pop();
        std::fs::write(&path, data).unwrap();
        assert!(ply_vertex_count(&mut File::open(&path).unwrap()).is_err());
        std::fs::remove_file(path).unwrap();
    }
    struct TestProject {
        root: PathBuf,
        id: String,
    }
    impl TestProject {
        fn new() -> Self {
            let id = uuid::Uuid::now_v7().to_string();
            let root = std::env::temp_dir().join(format!("preview-project-{id}"));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(
                root.join("project.json"),
                serde_json::json!({ "id": id }).to_string(),
            )
            .unwrap();
            Self {
                root: root.canonicalize().unwrap(),
                id,
            }
        }
        fn path(&self) -> String {
            self.root.to_string_lossy().into_owned()
        }
    }
    impl Drop for TestProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn gaussian_bytes(non_finite: bool) -> Vec<u8> {
        let ascii = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
        ));
        let (header, body) = ascii.split_once("end_header\n").unwrap();
        let mut bytes = format!(
            "{}end_header\n",
            header.replace("format ascii", "format binary_little_endian")
        )
        .into_bytes();
        for value in body.split_whitespace() {
            bytes.extend_from_slice(&value.parse::<f32>().unwrap().to_le_bytes());
        }
        if non_finite {
            let last = bytes.len() - 4;
            bytes[last..].copy_from_slice(&f32::NAN.to_le_bytes());
        }
        bytes
    }

    fn allow_preview_policy() -> PreviewResourcePolicy {
        resources::preview_policy(
            true,
            32 * 1024 * 1024 * 1024,
            Some(10 * 1024 * 1024 * 1024),
            Some(resources::MemoryPressure::Normal),
        )
    }

    #[test]
    fn ply_response_validates_the_actual_bytes_and_expected_revision() {
        let project = TestProject::new();
        let path = project.root.join("model.ply");
        std::fs::write(&path, gaussian_bytes(false)).unwrap();
        let metadata = source(&project.root, "model.ply", None).unwrap();
        assert!(read_gaussian_ply_with_policy(
            project.id.clone(),
            project.path(),
            "model.ply".into(),
            metadata.revision.clone(),
            allow_preview_policy,
        )
        .is_ok());
        assert!(read_gaussian_ply_with_policy(
            project.id.clone(),
            project.path(),
            "model.ply".into(),
            "stale".into(),
            allow_preview_policy,
        )
        .is_err());
        std::fs::write(&path, gaussian_bytes(true)).unwrap();
        let header = source(&project.root, "model.ply", None).unwrap();
        assert_eq!(
            header.vertex_count, 1,
            "metadata is not a finite-value gate"
        );
        assert!(read_gaussian_ply_with_policy(
            project.id.clone(),
            project.path(),
            "model.ply".into(),
            header.revision,
            allow_preview_policy,
        )
        .is_err());
    }

    #[test]
    fn live_frame_validation_precedes_ack_and_repeated_ack_returns_no_frame() {
        let project = TestProject::new();
        let session = live_preview::LiveSession::start(&project.root, true).unwrap();
        std::fs::write(session.directory.join("frame-1.ply"), gaussian_bytes(false)).unwrap();
        let mut frame = Frame {
            protocol: 1,
            session_id: session.session.session_id.clone(),
            revision: 1,
            iteration: 100,
            splat_count: 1,
            relative_path: "frame-1.ply".into(),
            created_at_ms: 1,
        };
        live_preview::write_json_atomic(&session.directory.join("latest.json"), &frame).unwrap();
        let ready = poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            0,
            None,
            allow_preview_policy(),
        )
        .unwrap();
        assert!(ready.frame.is_some());
        let acknowledged = poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            1,
            ready.session_id.clone(),
            allow_preview_policy(),
        )
        .unwrap();
        assert!(acknowledged.frame.is_none());
        let request_before = std::fs::read(session.directory.join("request.json")).unwrap();
        frame.splat_count = 2;
        live_preview::write_json_atomic(&session.directory.join("latest.json"), &frame).unwrap();
        assert!(poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            1,
            ready.session_id.clone(),
            allow_preview_policy(),
        )
        .is_err());
        assert_eq!(
            request_before,
            std::fs::read(session.directory.join("request.json")).unwrap()
        );
        frame.splat_count = 1;
        frame.session_id = uuid::Uuid::now_v7().to_string();
        live_preview::write_json_atomic(&session.directory.join("latest.json"), &frame).unwrap();
        assert!(poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            1,
            ready.session_id,
            allow_preview_policy(),
        )
        .is_err());
        assert_eq!(
            request_before,
            std::fs::read(session.directory.join("request.json")).unwrap()
        );
    }

    #[test]
    fn memory_pressure_stops_producer_requests_and_preserves_disk_recovery_frame() {
        let project = TestProject::new();
        let session = live_preview::LiveSession::start(&project.root, true).unwrap();
        let bytes = gaussian_bytes(false);
        let path = session.directory.join("frame-1.ply");
        std::fs::write(&path, &bytes).unwrap();
        let relative_path = format!(
            "{}/{}/frame-1.ply",
            live_preview::DIRECTORY,
            session.session.session_id
        );
        let metadata = source(&project.root, &relative_path, None).unwrap();
        let frame = Frame {
            protocol: 1,
            session_id: session.session.session_id.clone(),
            revision: 1,
            iteration: 100,
            splat_count: 1,
            relative_path: "frame-1.ply".into(),
            created_at_ms: 1,
        };
        live_preview::write_json_atomic(&session.directory.join("latest.json"), &frame).unwrap();
        let gib = 1024 * 1024 * 1024;
        for pressure in [
            resources::MemoryPressure::Warning,
            resources::MemoryPressure::Critical,
        ] {
            let policy = resources::preview_policy(true, 32 * gib, Some(10 * gib), Some(pressure));
            assert!(read_gaussian_ply_with_policy(
                project.id.clone(),
                project.path(),
                relative_path.clone(),
                metadata.revision.clone(),
                || policy.clone(),
            )
            .is_err());
            let status = poll_live_preview_with_policy(
                project.id.clone(),
                project.path(),
                "live".into(),
                0,
                None,
                policy,
            )
            .unwrap();
            assert!(status.frame.is_none());
            let request: Request = read_json(&session.directory.join("request.json")).unwrap();
            assert_eq!(request.mode, "off");
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        let mut capped = allow_preview_policy();
        capped.max_snapshot_bytes = bytes.len() as u64 - 1;
        assert!(read_gaussian_ply_with_policy(
            project.id.clone(),
            project.path(),
            relative_path,
            metadata.revision,
            || capped.clone(),
        )
        .is_err());
        let too_large = poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            0,
            None,
            capped,
        )
        .unwrap();
        assert!(too_large.frame.is_none());
        assert_eq!(too_large.resource_policy.reason, Some("snapshot_budget"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let policy = resources::preview_policy(
            true,
            32 * gib,
            Some(10 * gib),
            Some(resources::MemoryPressure::Normal),
        );
        let recovered = poll_live_preview_with_policy(
            project.id.clone(),
            project.path(),
            "live".into(),
            0,
            Some(session.session.session_id.clone()),
            policy,
        )
        .unwrap();
        assert!(recovered.frame.is_some());
        let request: Request = read_json(&session.directory.join("request.json")).unwrap();
        assert_eq!(request.mode, "live");
        assert_eq!(request.after_revision, 0);
    }

    #[tokio::test]
    async fn malformed_live_session_uuid_is_rejected_without_request() {
        let project = TestProject::new();
        let session = live_preview::LiveSession::start(&project.root, true).unwrap();
        let mut invalid = session.session.clone();
        invalid.session_id = "dead-beef".into();
        live_preview::write_json_atomic(
            &project
                .root
                .join(live_preview::DIRECTORY)
                .join("session.json"),
            &invalid,
        )
        .unwrap();
        assert!(
            poll_live_preview(project.id.clone(), project.path(), "live".into(), 0, None)
                .await
                .is_err()
        );
        assert!(!session.directory.join("request.json").exists());
    }

    #[tokio::test]
    async fn camera_converts_colmap_pose_and_vertical_focal_length() {
        let project = TestProject::new();
        let model = project.root.join("training/dataset/sparse/0");
        std::fs::create_dir_all(&model).unwrap();
        let mut images = Vec::new();
        images.extend_from_slice(&1_u64.to_le_bytes());
        images.extend_from_slice(&7_u32.to_le_bytes());
        let half = std::f64::consts::FRAC_1_SQRT_2;
        for v in [half, 0.0, half, 0.0, 1.0, 2.0, 3.0] {
            images.extend_from_slice(&v.to_le_bytes());
        }
        images.extend_from_slice(&9_u32.to_le_bytes());
        images.extend_from_slice(b"a\0");
        images.extend_from_slice(&0_u64.to_le_bytes());
        std::fs::write(model.join("images.bin"), images).unwrap();
        let mut cameras = Vec::new();
        cameras.extend_from_slice(&1_u64.to_le_bytes());
        cameras.extend_from_slice(&9_u32.to_le_bytes());
        cameras.extend_from_slice(&1_u32.to_le_bytes());
        cameras.extend_from_slice(&1600_u64.to_le_bytes());
        cameras.extend_from_slice(&1200_u64.to_le_bytes());
        for v in [900.0_f64, 600.0, 800.0, 600.0] {
            cameras.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(model.join("cameras.bin"), cameras).unwrap();
        let pose = get_gaussian_camera(project.id.clone(), project.path())
            .await
            .unwrap()
            .unwrap();
        for (a, b) in pose.position.into_iter().zip([3.0, -2.0, -1.0]) {
            assert!((a - b).abs() < 1e-8);
        }
        for (a, b) in pose.forward.into_iter().zip([-1.0, 0.0, 0.0]) {
            assert!((a - b).abs() < 1e-8);
        }
        assert_eq!(pose.up, [0.0, -1.0, 0.0]);
        assert!((pose.fov_y_degrees - 90.0).abs() < 1e-8);
    }

    #[tokio::test]
    async fn preview_requests_bind_to_project_and_reset_on_new_training_session() {
        let project = TestProject::new();
        let session = live_preview::LiveSession::start(&project.root, true).unwrap();
        let status = poll_live_preview(
            project.id.clone(),
            project.path(),
            "live".into(),
            99,
            Some("old-session".into()),
        )
        .await
        .unwrap();
        assert!(status.available && status.running);
        assert!(status.frame.is_none());
        let request: Request = read_json(&session.directory.join("request.json")).unwrap();
        assert_eq!(request.after_revision, 0);
        assert_eq!(request.session_id, session.session.session_id);
        assert!(request.expires_at_ms > chrono::Utc::now().timestamp_millis() as u64);
        poll_live_preview(
            project.id.clone(),
            project.path(),
            "off".into(),
            3,
            status.session_id,
        )
        .await
        .unwrap();
        let request: Request = read_json(&session.directory.join("request.json")).unwrap();
        assert_eq!(request.after_revision, 3);
        assert_eq!(request.mode, "off");
        assert!(poll_live_preview(
            "other-project".into(),
            project.path(),
            "live".into(),
            0,
            None
        )
        .await
        .is_err());
        assert!(poll_live_preview(
            project.id.clone(),
            project.path(),
            "invalid".into(),
            0,
            None
        )
        .await
        .is_err());
        drop(session);
        let stopped = poll_live_preview(project.id.clone(), project.path(), "live".into(), 0, None)
            .await
            .unwrap();
        assert!(!stopped.running);
        let next = live_preview::LiveSession::start(&project.root, true).unwrap();
        let restarted = poll_live_preview(
            project.id.clone(),
            project.path(),
            "low".into(),
            3,
            stopped.session_id.clone(),
        )
        .await
        .unwrap();
        assert_ne!(restarted.session_id, stopped.session_id);
        assert!(restarted.frame.is_none());
        let request: Request = read_json(&next.directory.join("request.json")).unwrap();
        assert_eq!(request.after_revision, 0);
    }

    #[test]
    fn rejects_path_traversal_and_absolute_paths() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        for relative in [
            "../secret.ply",
            "C:\\secret.ply",
            "/secret.ply",
            "foo/../../secret.ply",
            "",
        ] {
            assert!(safe_path(&root, relative).is_err());
        }
    }
}
