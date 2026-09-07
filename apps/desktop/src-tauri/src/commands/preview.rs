use splat_engine_brush::live_preview::{self, Frame, Request, Session};
use std::{
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
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
    relative_path: String,
    revision: String,
    vertex_count: u64,
    size_bytes: u64,
    iteration: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct LivePreviewStatus {
    session_id: Option<String>,
    available: bool,
    running: bool,
    revision: u64,
    frame: Option<GaussianPreviewSource>,
}

fn project_root(project_path: &str, project_id: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|_| "项目目录不存在。")?;
    let value: serde_json::Value = read_json(&root.join("project.json"))?;
    if value["id"].as_str() != Some(project_id) {
        return Err("项目身份不匹配。".into());
    }
    Ok(root)
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
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

/// Validate the full vertex payload using its layout, without turning millions
/// of attributes into a JSON point array or silently sampling the model.
fn ply_vertex_count(file: &mut File) -> Result<u64, String> {
    let size = file.metadata().map_err(|error| error.to_string())?.len();
    if size > MAX_PLY_BYTES {
        return Err("该 PLY 超过当前预览的 1 GiB 文件上限。".into());
    }
    let mut reader = BufReader::new(file);
    let mut header_bytes = 0_u64;
    let mut vertices = None;
    let mut vertex_element = false;
    let mut properties = Vec::new();
    let mut binary = false;
    loop {
        let mut line = String::new();
        // Bound each line as well as the total header; malformed input must not allocate unbounded memory.
        let count = reader
            .by_ref()
            .take(65_537)
            .read_line(&mut line)
            .map_err(|_| "PLY 文件头无效。")?;
        header_bytes += count as u64;
        if count == 0 || header_bytes > 65_536 {
            return Err("PLY 文件头不完整。".into());
        }
        let line = line.trim();
        if header_bytes == count as u64 && line != "ply" {
            return Err("文件不是 PLY 模型。".into());
        }
        if line == "end_header" {
            break;
        }
        let parts: Vec<_> = line.split_whitespace().collect();
        match parts.as_slice() {
            ["format", "binary_little_endian", "1.0"] => binary = true,
            ["element", "vertex", count] if vertices.is_none() => {
                vertices = count.parse::<u64>().ok();
                vertex_element = true;
            }
            ["element", _, count] => {
                // Brush models have one vertex element. Nonempty preceding or subsequent elements are unsupported.
                if *count != "0" {
                    return Err("不支持该 PLY 元素布局。".into());
                }
                vertex_element = false;
            }
            ["property", "float" | "float32", name] if vertex_element => {
                properties.push(name.to_string())
            }
            ["property", ..] if vertex_element => {
                return Err("当前预览需要 Brush 的 float32 高斯属性。".into())
            }
            _ => {}
        }
    }
    if !binary {
        return Err("当前预览需要二进制小端 PLY。".into());
    }
    for name in [
        "x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
        "opacity", "f_dc_0", "f_dc_1", "f_dc_2",
    ] {
        if properties.iter().filter(|item| *item == name).count() != 1 {
            return Err(format!("PLY 缺少有效高斯属性：{name}"));
        }
    }
    let rest = properties
        .iter()
        .filter(|name| name.starts_with("f_rest_"))
        .count();
    if ![0, 9, 24, 45].contains(&rest)
        || (0..rest).any(|index| !properties.contains(&format!("f_rest_{index}")))
    {
        return Err("PLY 球谐颜色数据不完整。".into());
    }
    let count = vertices
        .filter(|value| *value > 0)
        .ok_or("PLY 中没有高斯模型。")?;
    let expected = count
        .checked_mul(properties.len() as u64 * 4)
        .and_then(|body| body.checked_add(header_bytes));
    if expected != Some(size) {
        return Err("PLY 数据尚未写完或文件已损坏。".into());
    }
    Ok(count)
}

fn source(
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
        ply_vertex_count(&mut file)?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(before.len() as usize);
        file.by_ref()
            .take(MAX_PLY_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() as u64 != before.len()
            || revision(&file.metadata().map_err(|error| error.to_string())?) != expected_revision
        {
            return Err("读取期间模型发生变化，请重试。".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| error.to_string())?
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
        if session.session_id.is_empty()
            || !session
                .session_id
                .chars()
                .all(|c| c.is_ascii_hexdigit() || c == '-')
        {
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
        let latest = latest.filter(|frame| {
            frame.protocol == live_preview::PROTOCOL && frame.session_id == session.session_id
        });
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
        let frame_source = latest
            .as_ref()
            .map(|frame| {
                if frame.relative_path != format!("frame-{}.ply", frame.revision) {
                    return Err("训练预览帧路径无效。".into());
                }
                source(
                    &root,
                    &format!("{relative_dir}/{}", frame.relative_path),
                    Some(frame.iteration),
                )
            })
            .transpose()?;
        Ok(LivePreviewStatus {
            session_id: Some(session.session_id),
            available: session.available,
            running: session.running,
            revision: latest.map(|frame| frame.revision).unwrap_or(0),
            frame: frame_source,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_all_vertices_without_sampling_and_rejects_partial_writes() {
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
            Self { root, id }
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
