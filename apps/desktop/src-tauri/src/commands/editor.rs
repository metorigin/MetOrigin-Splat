use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use tauri::{Emitter, Manager};

use super::preview::{self, GaussianPreviewSource};
use crate::state::AppState;

const ORIGINAL: &str = "output/scene.ply";
const MAX_BYTES: usize = 1024 * 1024 * 1024;

#[derive(Default)]
pub struct EditorState(Mutex<HashMap<String, EditorSession>>);

#[derive(Clone, serde::Serialize)]
pub struct EditorSession {
    session_id: String,
    project_id: String,
    project_path: String,
    project_name: String,
    source: GaussianPreviewSource,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SavedModel {
    source: GaussianPreviewSource,
    saved_at: String,
}

#[derive(Clone, serde::Serialize)]
struct SavedEvent {
    project_id: String,
    model: SavedModel,
}

fn completed_root(project_path: &str, project_id: &str) -> Result<(PathBuf, String), String> {
    let root = preview::project_root(project_path, project_id)?;
    let project: serde_json::Value =
        serde_json::from_reader(File::open(root.join("project.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !project["status"]
        .as_str()
        .is_some_and(|status| status.eq_ignore_ascii_case("completed"))
    {
        return Err("请等待重建完成后再编辑模型。".into());
    }
    Ok((root, project["name"].as_str().unwrap_or("项目").to_string()))
}

fn prepare_session(project_id: String, project_path: String) -> Result<EditorSession, String> {
    let (root, project_name) = completed_root(&project_path, &project_id)?;
    let source = preview::source(&root, ORIGINAL, None)?;
    Ok(EditorSession {
        session_id: uuid::Uuid::now_v7().to_string(),
        project_id,
        project_path: root.to_string_lossy().into_owned(),
        project_name,
        source,
    })
}

#[tauri::command]
pub async fn open_model_editor(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    editors: tauri::State<'_, EditorState>,
    project_id: String,
    project_path: String,
) -> Result<EditorSession, String> {
    uuid::Uuid::parse_str(&project_id).map_err(|_| "项目身份无效。")?;
    {
        let inner = state.0.lock().map_err(|e| e.to_string())?;
        if inner.active_pipeline.as_ref().is_some_and(|pipeline| {
            pipeline.project_id == project_id && !*pipeline.completion.borrow()
        }) {
            return Err("请等待该项目重建完成后再编辑模型。".into());
        }
    }
    let session =
        tauri::async_runtime::spawn_blocking(move || prepare_session(project_id, project_path))
            .await
            .map_err(|e| e.to_string())??;
    let mut sessions = editors.0.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(window.label()) {
        return Err("请先返回训练结果，再打开另一个编辑会话。".into());
    }
    sessions.insert(window.label().to_string(), session.clone());
    Ok(session)
}

#[tauri::command]
pub async fn close_model_editor(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, EditorState>,
    session_id: String,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|e| e.to_string())?;
    if sessions
        .get(window.label())
        .is_some_and(|s| s.session_id == session_id)
    {
        sessions.remove(window.label());
    }
    Ok(())
}

fn save_model(session: &mut EditorSession, bytes: &[u8]) -> Result<SavedModel, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("编辑结果为空或超过 1 GiB 上限。".into());
    }
    let (root, _) = completed_root(&session.project_path, &session.project_id)?;
    if preview::source(&root, ORIGINAL, None)?.revision != session.source.revision {
        return Err(
            "模型文件已变化，请重新打开编辑器。当前编辑内容仍保留，可通过 SuperSplat 导出。".into(),
        );
    }
    let directory = preview::safe_path(&root, "output")?;
    let filename = format!(".scene-{}.tmp.ply", uuid::Uuid::now_v7());
    let temporary_name = format!("output/{filename}");
    let temporary = directory.join(filename);
    let destination = preview::safe_path(&root, ORIGINAL)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        let mut model = model_info(&root, &temporary_name)?;
        // Recheck immediately before replacement. Invalid exports or a model
        // changed outside this session must leave the existing file intact.
        if preview::source(&root, ORIGINAL, None)?.revision != session.source.revision {
            return Err("模型文件已变化，请重新打开编辑器。".into());
        }
        // Same-directory rename replaces the destination without truncating it
        // first. No historical copies are created, including on Windows.
        std::fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        model.source.relative_path = ORIGINAL.into();
        session.source = model.source.clone();
        Ok(model)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn model_info(root: &Path, relative: &str) -> Result<SavedModel, String> {
    let source = preview::source(root, relative, None)?;
    let time = File::open(preview::safe_path(root, relative)?)
        .and_then(|file| file.metadata())
        .and_then(|metadata| metadata.modified())
        .map_err(|e| e.to_string())?;
    Ok(SavedModel {
        source,
        saved_at: chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339(),
    })
}

#[tauri::command]
pub async fn save_edited_ply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<SavedModel, String> {
    // Bind binary saves to the exact session, even after navigation/reopening.
    let session_id = request
        .headers()
        .get("x-editor-session")
        .and_then(|v| v.to_str().ok())
        .ok_or("编辑会话已失效，请从项目重新打开编辑器。")?
        .to_string();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_BYTES => bytes.clone(),
        _ => return Err("请以二进制格式保存不超过 1 GiB 的 PLY。".into()),
    };
    let handle = app.clone();
    let label = window.label().to_string();
    let (project_id, model) = tauri::async_runtime::spawn_blocking(move || {
        let editors = handle.state::<EditorState>();
        // Serialize validation, replacement and revision update. Concurrent
        // saves cannot use an outdated revision or outlive a closed session.
        let mut sessions = editors.0.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get_mut(&label)
            .filter(|s| s.session_id == session_id)
            .ok_or("编辑会话已失效，请从项目重新打开编辑器。")?;
        let model = save_model(session, &bytes)?;
        Ok::<_, String>((session.project_id.clone(), model))
    })
    .await
    .map_err(|e| e.to_string())??;
    // The persisted file is authoritative; a closed main window must not turn
    // a successful save into a failure or a duplicate retry.
    let _ = app.emit(
        "model-edit-saved",
        SavedEvent {
            project_id,
            model: model.clone(),
        },
    );
    Ok(model)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let id = uuid::Uuid::now_v7().to_string();
            let root = std::env::temp_dir().join(format!("metorigin-editor-{id}"));
            std::fs::create_dir_all(root.join("output")).unwrap();
            std::fs::write(
                root.join("project.json"),
                serde_json::json!({ "id": id, "name": "编辑测试", "status": "completed" })
                    .to_string(),
            )
            .unwrap();
            std::fs::write(root.join(ORIGINAL), ply(2)).unwrap();
            Self { root, id }
        }
        fn session(&self) -> EditorSession {
            prepare_session(self.id.clone(), self.root.to_string_lossy().into_owned()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn ply(count: usize) -> Vec<u8> {
        let properties = [
            "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1",
            "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
        ];
        let mut header = format!("ply\nformat binary_little_endian 1.0\nelement vertex {count}\n");
        for name in properties {
            header.push_str(&format!("property float {name}\n"));
        }
        header.push_str("end_header\n");
        let mut bytes = header.into_bytes();
        bytes.resize(bytes.len() + count * properties.len() * 4, 0);
        bytes
    }

    #[test]
    fn overwrites_original_repeatedly_and_reopens_latest_save_without_history() {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        let first = save_model(&mut session, &ply(1)).unwrap();
        assert_eq!(first.source.relative_path, ORIGINAL);
        assert_eq!(first.source.vertex_count, 1);
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(1));
        assert_eq!(session.source.revision, first.source.revision);
        let second = save_model(&mut session, &ply(3)).unwrap();
        assert_eq!(second.source.relative_path, ORIGINAL);
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(3));
        assert_eq!(fixture.session().source.vertex_count, 3);
        assert_eq!(
            std::fs::read_dir(fixture.root.join("output"))
                .unwrap()
                .count(),
            1
        );
        assert!(!fixture.root.join("output/edited").exists());
    }

    #[test]
    fn rejects_truncated_and_empty_exports_and_removes_temporary_files() {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        let revision = session.source.revision.clone();
        let mut corrupt = ply(2);
        corrupt.pop();
        assert!(save_model(&mut session, &corrupt).is_err());
        assert!(save_model(&mut session, &ply(0)).is_err());
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(2));
        assert_eq!(session.source.revision, revision);
        assert_eq!(
            std::fs::read_dir(fixture.root.join("output"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn rejects_unfinished_projects_and_external_model_changes() {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        assert!(prepare_session("another-project".into(), session.project_path.clone(),).is_err());
        std::fs::write(fixture.root.join(ORIGINAL), ply(3)).unwrap();
        assert!(save_model(&mut session, &ply(1))
            .unwrap_err()
            .contains("已变化"));
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(3));
        std::fs::write(
            fixture.root.join("project.json"),
            serde_json::json!({ "id": fixture.id, "status": "running" }).to_string(),
        )
        .unwrap();
        assert!(prepare_session(fixture.id.clone(), session.project_path.clone(),).is_err());
        assert!(save_model(&mut session, &ply(1)).is_err());
    }

    #[test]
    fn ignores_existing_legacy_versions_without_deleting_them() {
        let fixture = Fixture::new();
        let legacy = fixture.root.join("output/edited");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("scene-legacy.ply"), ply(7)).unwrap();
        let mut session = fixture.session();
        assert_eq!(session.source.vertex_count, 2);
        save_model(&mut session, &ply(1)).unwrap();
        assert_eq!(
            std::fs::read(legacy.join("scene-legacy.ply")).unwrap(),
            ply(7)
        );
        assert_eq!(std::fs::read_dir(legacy).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_original_and_allows_retry() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let mut session = fixture.session();
        // Other readers are allowed; replacing this file is blocked by Windows.
        let locked = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(fixture.root.join(ORIGINAL))
            .unwrap();
        assert!(save_model(&mut session, &ply(1)).is_err());
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(2));
        assert_eq!(
            std::fs::read_dir(fixture.root.join("output"))
                .unwrap()
                .count(),
            1
        );
        drop(locked);
        save_model(&mut session, &ply(1)).unwrap();
        assert_eq!(std::fs::read(fixture.root.join(ORIGINAL)).unwrap(), ply(1));
    }
}
