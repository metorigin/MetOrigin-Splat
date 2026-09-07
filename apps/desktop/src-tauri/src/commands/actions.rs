use std::path::{Path, PathBuf};

use chrono::Utc;
use splat_domain::PipelineStageId;
use splat_project::ProjectManager;

use crate::commands::{pipeline, project, workspace};
use crate::state::{
    ActionPreviewRecord, ActionTokenError, AppState, PipelineControlIntent, WorkspaceActionKind,
    WorkspaceActionRequest,
};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionImpactPreview {
    action: WorkspaceActionKind,
    target_label: String,
    allowed: bool,
    blocked_reason: Option<String>,
    irreversible: bool,
    preserved: Vec<String>,
    invalidated: Vec<String>,
    regenerated: Vec<String>,
    warnings: Vec<String>,
    size_bytes: Option<u64>,
    preview_token: String,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone)]
struct ImpactDraft {
    action: WorkspaceActionKind,
    target_label: String,
    allowed: bool,
    blocked_reason: Option<String>,
    irreversible: bool,
    preserved: Vec<String>,
    invalidated: Vec<String>,
    regenerated: Vec<String>,
    warnings: Vec<String>,
    size_bytes: Option<u64>,
    fingerprint: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceActionReceipt {
    id: String,
    action: WorkspaceActionKind,
    status: String,
    title: String,
    message: String,
    completed_at: String,
    affected_resources: Vec<String>,
    dismissible: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkspaceActionExecution {
    Completed {
        receipt: WorkspaceActionReceipt,
    },
    Stale {
        code: String,
        message: String,
        preview: ActionImpactPreview,
    },
}

#[derive(Debug)]
enum PreviewExecutionGate {
    Ready(ActionPreviewRecord),
    Stale(WorkspaceActionExecution),
}

#[derive(Debug)]
struct ActiveFacts {
    project_id: String,
    project_path: String,
    stage_id: Option<String>,
    intent: String,
}

fn manager_for(project_dir: &Path) -> ProjectManager {
    ProjectManager::new(project_dir.parent().unwrap_or(project_dir).to_path_buf())
}

fn parse_stage(value: &str) -> Option<PipelineStageId> {
    PipelineStageId::all()
        .iter()
        .copied()
        .find(|stage| format!("{stage:?}").eq_ignore_ascii_case(value))
}

fn validate_request_shape(request: &WorkspaceActionRequest) -> Result<(), String> {
    let valid = match request.action {
        WorkspaceActionKind::Pause
        | WorkspaceActionKind::Cancel
        | WorkspaceActionKind::DeleteProject => {
            request.stage_id.is_none() && request.checkpoint_iteration.is_none()
        }
        WorkspaceActionKind::RerunStage => {
            request.stage_id.is_some() && request.checkpoint_iteration.is_none()
        }
        WorkspaceActionKind::RestoreCheckpoint | WorkspaceActionKind::DeleteCheckpoint => {
            request.stage_id.is_none() && request.checkpoint_iteration.is_some()
        }
    };
    if valid {
        Ok(())
    } else {
        Err("操作确认请求包含缺失或不适用的目标字段。".into())
    }
}

async fn active_facts(state: &AppState) -> Result<Option<ActiveFacts>, String> {
    let active = {
        let inner = state
            .0
            .lock()
            .map_err(|_| "操作确认状态不可用，请重试。".to_string())?;
        inner.active_pipeline.clone()
    };
    let Some(active) = active else {
        return Ok(None);
    };
    let pipeline_state = active.orchestrator.get_state().await;
    let intent = active
        .control_intent
        .lock()
        .map_err(|_| "处理流程控制状态不可用。".to_string())?;
    Ok(Some(ActiveFacts {
        project_id: active.project_id,
        project_path: active.project_dir.to_string_lossy().to_string(),
        stage_id: pipeline_state
            .current_stage
            .map(|stage| format!("{stage:?}")),
        intent: match *intent {
            PipelineControlIntent::None => "none",
            PipelineControlIntent::Pause => "pause",
            PipelineControlIntent::Cancel => "cancel",
        }
        .into(),
    }))
}

fn directory_size(path: &Path) -> Result<u64, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "无法读取项目占用空间。".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("项目目录包含不受支持的符号链接。".into());
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    let mut total = 0_u64;
    for entry in std::fs::read_dir(path).map_err(|_| "无法读取项目占用空间。".to_string())?
    {
        let entry = entry.map_err(|_| "无法读取项目占用空间。".to_string())?;
        total = total.saturating_add(directory_size(&entry.path())?);
    }
    Ok(total)
}

async fn derive_impact(
    request: &WorkspaceActionRequest,
    state: &AppState,
) -> Result<ImpactDraft, String> {
    validate_request_shape(request)?;
    let project_dir = PathBuf::from(&request.project_path);
    let project = manager_for(&project_dir)
        .open_project(&project_dir)
        .map_err(|error| error.user_message_zh())?;
    if project.id.to_string() != request.project_id {
        return Err("项目身份已变化，已拒绝生成操作确认。".into());
    }
    let active = active_facts(state).await?;
    let targets_active = active.as_ref().is_some_and(|facts| {
        facts.project_id == request.project_id || facts.project_path == request.project_path
    });
    let active_elsewhere = active.is_some() && !targets_active;
    let project_fact = serde_json::json!({
        "id": project.id.to_string(),
        "status": project.status.to_string(),
        "current_stage": project.current_stage.map(|stage| format!("{stage:?}")),
        "active": active.as_ref().map(|facts| serde_json::json!({
            "project_id": facts.project_id,
            "stage_id": facts.stage_id,
            "intent": facts.intent,
        })),
    });

    let mut draft = match request.action {
        WorkspaceActionKind::Pause | WorkspaceActionKind::Cancel => {
            let action_name = if request.action == WorkspaceActionKind::Pause {
                "暂停当前处理"
            } else {
                "安全取消当前处理"
            };
            let intent_busy = active
                .as_ref()
                .is_some_and(|facts| facts.intent.as_str() != "none");
            let allowed = targets_active && !intent_busy;
            ImpactDraft {
                action: request.action,
                target_label: action_name.into(),
                allowed,
                blocked_reason: (!allowed).then(|| {
                    if !targets_active {
                        "该项目当前没有活动处理任务。"
                    } else {
                        "已有控制操作正在执行，请等待完成。"
                    }
                    .into()
                }),
                irreversible: false,
                preserved: vec![
                    "已完成阶段".into(),
                    "已验证产物".into(),
                    "合法 Checkpoint".into(),
                ],
                invalidated: if request.action == WorkspaceActionKind::Cancel {
                    vec!["当前未完成阶段的临时结果".into()]
                } else {
                    Vec::new()
                },
                regenerated: Vec::new(),
                warnings: vec!["继续处理时会从可恢复边界重新验证状态。".into()],
                size_bytes: None,
                fingerprint: String::new(),
            }
        }
        WorkspaceActionKind::RerunStage => {
            let stage_id = request
                .stage_id
                .as_deref()
                .and_then(parse_stage)
                .ok_or_else(|| "阶段标识无效。".to_string())?;
            let stages = PipelineStageId::all();
            let index = stages
                .iter()
                .position(|stage| *stage == stage_id)
                .ok_or_else(|| "阶段不在当前处理流程中。".to_string())?;
            let downstream = stages[index..]
                .iter()
                .map(|stage| format!("{stage:?}"))
                .collect::<Vec<_>>();
            let stage_facts = downstream
                .iter()
                .filter_map(|name| parse_stage(name).and_then(|id| project.pipeline_state.stages.get(&id).map(|state| (name, state))))
                .map(|(name, state)| serde_json::json!({ "stage": name, "status": format!("{:?}", state.status) }))
                .collect::<Vec<_>>();
            ImpactDraft {
                action: request.action,
                target_label: format!("从 {stage_id:?} 阶段重新运行"),
                allowed: active.is_none(),
                blocked_reason: active
                    .is_some()
                    .then(|| "存在活动处理任务，请先暂停或安全取消。".into()),
                irreversible: false,
                preserved: vec!["所选阶段之前的已验证产物".into(), "原始素材".into()],
                invalidated: downstream
                    .iter()
                    .map(|stage| format!("{stage} 的现有状态与下游产物"))
                    .collect(),
                regenerated: downstream,
                warnings: vec!["重新运行不会修改原始素材。".into()],
                size_bytes: None,
                fingerprint: serde_json::to_string(&stage_facts)
                    .map_err(|_| "无法生成阶段影响指纹。".to_string())?,
            }
        }
        WorkspaceActionKind::RestoreCheckpoint | WorkspaceActionKind::DeleteCheckpoint => {
            let iteration = request
                .checkpoint_iteration
                .ok_or_else(|| "缺少 Checkpoint。".to_string())?;
            let checkpoints = workspace::checkpoint_summaries(&project_dir)?;
            let selected = checkpoints
                .iter()
                .find(|checkpoint| checkpoint.iteration == iteration);
            let valid_count = checkpoints
                .iter()
                .filter(|checkpoint| checkpoint.valid)
                .count();
            let checkpoint_facts = checkpoints
                .iter()
                .map(|checkpoint| {
                    serde_json::json!({
                        "iteration": checkpoint.iteration,
                        "size": checkpoint.size_bytes,
                        "created_at": checkpoint.created_at,
                        "valid": checkpoint.valid,
                        "current": checkpoint.current,
                    })
                })
                .collect::<Vec<_>>();
            let (allowed, blocked_reason, size_bytes) = match selected {
                None => (false, Some("未找到指定 Checkpoint。".into()), None),
                Some(checkpoint)
                    if request.action == WorkspaceActionKind::RestoreCheckpoint
                        && !checkpoint.valid =>
                {
                    (
                        false,
                        Some("该 Checkpoint 未通过验证，不能恢复。".into()),
                        Some(checkpoint.size_bytes),
                    )
                }
                Some(checkpoint)
                    if request.action == WorkspaceActionKind::DeleteCheckpoint
                        && (checkpoint.current || (checkpoint.valid && valid_count <= 1)) =>
                {
                    (
                        false,
                        Some("不能删除当前使用或唯一合法的 Checkpoint。".into()),
                        Some(checkpoint.size_bytes),
                    )
                }
                Some(checkpoint) if active_elsewhere || targets_active => (
                    false,
                    Some("存在活动处理任务，请先暂停或安全取消。".into()),
                    Some(checkpoint.size_bytes),
                ),
                Some(checkpoint) => (true, None, Some(checkpoint.size_bytes)),
            };
            let restoring = request.action == WorkspaceActionKind::RestoreCheckpoint;
            ImpactDraft {
                action: request.action,
                target_label: format!("Checkpoint {} step", iteration),
                allowed,
                blocked_reason,
                irreversible: !restoring,
                preserved: if restoring {
                    vec![
                        format!("Checkpoint {} step", iteration),
                        "原始素材与相机重建".into(),
                    ]
                } else {
                    vec!["其他合法 Checkpoint".into()]
                },
                invalidated: if restoring {
                    vec![format!(
                        "{} step 之后的 Checkpoint 与训练下游产物",
                        iteration
                    )]
                } else {
                    vec![format!("Checkpoint {} step 文件", iteration)]
                },
                regenerated: if restoring {
                    vec!["Brush 训练".into(), "模型校验".into(), "预览与导出".into()]
                } else {
                    Vec::new()
                },
                warnings: if restoring {
                    vec!["仅恢复几何状态，不恢复优化器状态。".into()]
                } else {
                    vec!["删除后不能通过应用恢复该文件。".into()]
                },
                size_bytes,
                fingerprint: serde_json::to_string(&checkpoint_facts)
                    .map_err(|_| "无法生成 Checkpoint 影响指纹。".to_string())?,
            }
        }
        WorkspaceActionKind::DeleteProject => {
            let creation_active = {
                let inner = state
                    .0
                    .lock()
                    .map_err(|_| "项目删除状态不可用。".to_string())?;
                inner
                    .active_creation
                    .as_ref()
                    .is_some_and(|creation| creation.id == request.project_id)
            };
            let allowed = !targets_active && !creation_active;
            let size_bytes = directory_size(&project_dir)?;
            ImpactDraft {
                action: request.action,
                target_label: format!("永久删除项目“{}”", project.name),
                allowed,
                blocked_reason: (!allowed).then(|| "项目仍在处理或创建中，请先安全停止。".into()),
                irreversible: true,
                preserved: vec!["应用设置与其他项目".into()],
                invalidated: vec![
                    "项目素材副本".into(),
                    "重建产物".into(),
                    "Checkpoint".into(),
                    "日志与导出".into(),
                ],
                regenerated: Vec::new(),
                warnings: vec!["项目目录将从磁盘永久移除，此操作不可撤销。".into()],
                size_bytes: Some(size_bytes),
                fingerprint: serde_json::to_string(&serde_json::json!({
                    "project_updated_at": project.updated_at,
                    "creation_active": creation_active,
                    "size_bytes": size_bytes,
                }))
                .map_err(|_| "无法生成项目删除影响指纹。".to_string())?,
            }
        }
    };
    draft.fingerprint = serde_json::to_string(&serde_json::json!({
        "project": project_fact,
        "action": request.action,
        "target": {
            "stage": request.stage_id,
            "checkpoint": request.checkpoint_iteration,
        },
        "domain": draft.fingerprint,
        "allowed": draft.allowed,
        "blocked": draft.blocked_reason,
    }))
    .map_err(|_| "无法生成操作影响指纹。".to_string())?;
    Ok(draft)
}

fn issue_preview(
    request: WorkspaceActionRequest,
    draft: ImpactDraft,
    state: &AppState,
) -> Result<ActionImpactPreview, String> {
    let token = state.issue_action_preview(request, draft.fingerprint)?;
    Ok(ActionImpactPreview {
        action: draft.action,
        target_label: draft.target_label,
        allowed: draft.allowed,
        blocked_reason: draft.blocked_reason,
        irreversible: draft.irreversible,
        preserved: draft.preserved,
        invalidated: draft.invalidated,
        regenerated: draft.regenerated,
        warnings: draft.warnings,
        size_bytes: draft.size_bytes,
        preview_token: token.token,
        created_at: token.created_at.to_rfc3339(),
        expires_at: token.expires_at.to_rfc3339(),
    })
}

#[tauri::command]
pub async fn preview_workspace_action(
    request: WorkspaceActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<ActionImpactPreview, String> {
    let draft = derive_impact(&request, state.inner()).await?;
    issue_preview(request, draft, state.inner())
}

fn token_error(error: ActionTokenError) -> String {
    let (code, message) = match error {
        ActionTokenError::Expired => (
            "UI-ACTION-PREVIEW-EXPIRED",
            "操作影响说明已过期，尚未执行任何操作，请重新确认。",
        ),
        ActionTokenError::UnknownOrReplayed => (
            "UI-ACTION-PREVIEW-INVALID",
            "操作确认已使用或无效，尚未执行任何操作。",
        ),
    };
    serde_json::json!({ "code": code, "message": message, "retryable": false }).to_string()
}

async fn consume_revalidated_preview(
    preview_token: &str,
    state: &AppState,
) -> Result<PreviewExecutionGate, String> {
    let record = state
        .consume_action_preview(preview_token)
        .map_err(token_error)?;
    let current = derive_impact(&record.request, state).await?;
    if current.fingerprint != record.fingerprint || !current.allowed {
        let preview = issue_preview(record.request, current, state)?;
        return Ok(PreviewExecutionGate::Stale(
            WorkspaceActionExecution::Stale {
                code: "UI-ACTION-PREVIEW-STALE".into(),
                message: "项目状态已变化，尚未执行任何操作。请检查最新影响后再次确认。".into(),
                preview,
            },
        ));
    }
    Ok(PreviewExecutionGate::Ready(record))
}

async fn dispatch_ready_action(
    record: ActionPreviewRecord,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
) -> Result<WorkspaceActionReceipt, String> {
    let action = record.request.action;
    let affected_resources = match action {
        WorkspaceActionKind::Pause => {
            pipeline::control_pipeline(state, PipelineControlIntent::Pause).await?;
            vec!["pipeline", "artifacts", "checkpoints"]
        }
        WorkspaceActionKind::Cancel => {
            pipeline::control_pipeline(state, PipelineControlIntent::Cancel).await?;
            vec!["pipeline", "artifacts", "checkpoints"]
        }
        WorkspaceActionKind::RerunStage => {
            let stage_id = record
                .request
                .stage_id
                .ok_or_else(|| "阶段操作缺少目标，未执行任何操作。".to_string())?;
            pipeline::rerun_from_stage_inner(record.request.project_path, stage_id, state)?;
            vec!["pipeline", "artifacts", "activity"]
        }
        WorkspaceActionKind::RestoreCheckpoint => {
            let iteration = record
                .request
                .checkpoint_iteration
                .ok_or_else(|| "Checkpoint 操作缺少目标，未执行任何操作。".to_string())?;
            workspace::restore_checkpoint_inner(record.request.project_path, iteration)?;
            vec!["pipeline", "checkpoints", "artifacts"]
        }
        WorkspaceActionKind::DeleteCheckpoint => {
            let iteration = record
                .request
                .checkpoint_iteration
                .ok_or_else(|| "Checkpoint 操作缺少目标，未执行任何操作。".to_string())?;
            workspace::delete_checkpoint_inner(record.request.project_path, iteration)?;
            vec!["checkpoints", "artifacts"]
        }
        WorkspaceActionKind::DeleteProject => {
            let app_handle =
                app_handle.ok_or_else(|| "项目删除缺少应用上下文，未执行任何操作。".to_string())?;
            project::delete_project_inner(
                project::DeleteProjectRequest {
                    project_id: record.request.project_id,
                    project_path: record.request.project_path,
                },
                app_handle,
                state,
            )?;
            vec!["recent_projects", "project_storage"]
        }
    };
    Ok(WorkspaceActionReceipt {
        id: uuid::Uuid::now_v7().to_string(),
        action,
        status: "success".into(),
        title: "操作已完成".into(),
        message: "已按确认的影响范围完成操作，并刷新相关状态。".into(),
        completed_at: Utc::now().to_rfc3339(),
        affected_resources: affected_resources.into_iter().map(str::to_string).collect(),
        dismissible: true,
    })
}

#[tauri::command]
pub async fn execute_workspace_action(
    preview_token: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<WorkspaceActionExecution, String> {
    let record = match consume_revalidated_preview(&preview_token, state.inner()).await? {
        PreviewExecutionGate::Ready(record) => record,
        PreviewExecutionGate::Stale(response) => return Ok(response),
    };

    let receipt = dispatch_ready_action(record, Some(&app_handle), state.inner()).await?;
    Ok(WorkspaceActionExecution::Completed { receipt })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::{Arc, Mutex};

    use splat_domain::StageStatus;
    use splat_pipeline::PipelineOrchestrator;

    use crate::state::ActivePipeline;

    use super::*;

    fn test_project(label: &str) -> (PathBuf, PathBuf, splat_domain::Project) {
        let root = std::env::temp_dir().join(format!(
            "metorigin-action-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let manager = ProjectManager::new(root.clone());
        let (project, project_dir) = manager.create_project(label).unwrap();
        (root, project_dir, project)
    }

    fn request_for(
        project: &splat_domain::Project,
        project_dir: &Path,
        action: WorkspaceActionKind,
    ) -> WorkspaceActionRequest {
        WorkspaceActionRequest {
            project_id: project.id.to_string(),
            project_path: project_dir.to_string_lossy().to_string(),
            action,
            stage_id: None,
            checkpoint_iteration: None,
        }
    }

    fn install_active_pipeline(state: &AppState, project: &splat_domain::Project, path: &Path) {
        let orchestrator = Arc::new(PipelineOrchestrator::new_default(path.to_path_buf()));
        let (_completion_tx, completion) = tokio::sync::watch::channel(true);
        state.0.lock().unwrap().active_pipeline = Some(ActivePipeline {
            project_id: project.id.to_string(),
            project_dir: path.to_path_buf(),
            orchestrator,
            completion,
            control_intent: Arc::new(Mutex::new(PipelineControlIntent::None)),
            accepted_at: "2026-08-14T08:00:00Z".into(),
            started_at: Arc::new(Mutex::new(Some("2026-08-14T08:00:01Z".into()))),
            sequence: Arc::new(AtomicU64::new(1)),
            abort_handle: Arc::new(Mutex::new(None)),
        });
    }

    fn write_valid_checkpoint(project_dir: &Path, iteration: u32) {
        let directory = project_dir.join("training/checkpoints");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join(format!("checkpoint_{iteration:06}.ply")),
            b"ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0 0 0\n",
        )
        .unwrap();
    }

    async fn ready_record(
        request: WorkspaceActionRequest,
        state: &AppState,
    ) -> ActionPreviewRecord {
        let draft = derive_impact(&request, state).await.unwrap();
        assert!(draft.allowed);
        let issued = issue_preview(request, draft, state).unwrap();
        match consume_revalidated_preview(&issued.preview_token, state)
            .await
            .unwrap()
        {
            PreviewExecutionGate::Ready(record) => record,
            PreviewExecutionGate::Stale(_) => panic!("unchanged preview must be executable"),
        }
    }

    #[test]
    fn request_shape_rejects_missing_and_extra_targets() {
        let base = WorkspaceActionRequest {
            project_id: "p".into(),
            project_path: "p".into(),
            action: WorkspaceActionKind::RerunStage,
            stage_id: None,
            checkpoint_iteration: None,
        };
        assert!(validate_request_shape(&base).is_err());
        assert!(validate_request_shape(&WorkspaceActionRequest {
            action: WorkspaceActionKind::Pause,
            stage_id: Some("Export".into()),
            ..base
        })
        .is_err());
    }

    #[test]
    fn token_errors_are_safe_and_stable() {
        assert!(token_error(ActionTokenError::Expired).contains("UI-ACTION-PREVIEW-EXPIRED"));
        assert!(!token_error(ActionTokenError::Expired).contains("\\Users\\"));
        assert!(
            token_error(ActionTokenError::UnknownOrReplayed).contains("UI-ACTION-PREVIEW-INVALID")
        );
    }

    #[tokio::test]
    async fn pause_and_cancel_impacts_are_bound_to_live_stage_and_control_intent() {
        let (root, project_dir, project) = test_project("pipeline-impact");
        let state = AppState::new();
        install_active_pipeline(&state, &project, &project_dir);

        let pause = derive_impact(
            &request_for(&project, &project_dir, WorkspaceActionKind::Pause),
            &state,
        )
        .await
        .unwrap();
        let cancel = derive_impact(
            &request_for(&project, &project_dir, WorkspaceActionKind::Cancel),
            &state,
        )
        .await
        .unwrap();
        assert!(pause.allowed && cancel.allowed);
        assert!(pause.invalidated.is_empty());
        assert!(!cancel.invalidated.is_empty());
        assert!(cancel
            .preserved
            .iter()
            .any(|item| item.contains("Checkpoint")));

        let intent = state
            .0
            .lock()
            .unwrap()
            .active_pipeline
            .as_ref()
            .unwrap()
            .control_intent
            .clone();
        *intent.lock().unwrap() = PipelineControlIntent::Pause;
        let changed = derive_impact(
            &request_for(&project, &project_dir, WorkspaceActionKind::Cancel),
            &state,
        )
        .await
        .unwrap();
        assert!(!changed.allowed);
        assert_ne!(changed.fingerprint, cancel.fingerprint);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn rerun_impact_lists_downstream_work_and_fingerprint_changes_with_stage_state() {
        let (root, project_dir, project) = test_project("rerun-impact");
        let state = AppState::new();
        let mut request = request_for(&project, &project_dir, WorkspaceActionKind::RerunStage);
        request.stage_id = Some("FrameExtraction".into());

        let before = derive_impact(&request, &state).await.unwrap();
        assert!(before.allowed);
        assert!(before.preserved.iter().any(|item| item.contains("原始")));
        assert!(before.invalidated.len() > 1);
        assert!(before.regenerated.iter().any(|item| item == "Export"));

        let manager = manager_for(&project_dir);
        let mut changed = manager.open_project(&project_dir).unwrap();
        changed
            .pipeline_state
            .stages
            .get_mut(&PipelineStageId::FrameExtraction)
            .unwrap()
            .status = StageStatus::Completed;
        manager.save_project(&changed, &project_dir).unwrap();
        let after = derive_impact(&request, &state).await.unwrap();
        assert_ne!(after.fingerprint, before.fingerprint);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn checkpoint_impacts_enforce_current_and_unique_rules_and_track_metadata() {
        let (root, project_dir, project) = test_project("checkpoint-impact");
        write_valid_checkpoint(&project_dir, 500);
        write_valid_checkpoint(&project_dir, 1000);
        let state = AppState::new();

        let mut restore = request_for(
            &project,
            &project_dir,
            WorkspaceActionKind::RestoreCheckpoint,
        );
        restore.checkpoint_iteration = Some(500);
        let restore_impact = derive_impact(&restore, &state).await.unwrap();
        assert!(restore_impact.allowed);
        assert!(!restore_impact.invalidated.is_empty());
        assert!(!restore_impact.regenerated.is_empty());
        assert!(restore_impact
            .warnings
            .iter()
            .any(|item| item.contains("优化器")));

        let mut delete = request_for(
            &project,
            &project_dir,
            WorkspaceActionKind::DeleteCheckpoint,
        );
        delete.checkpoint_iteration = Some(500);
        let deletable = derive_impact(&delete, &state).await.unwrap();
        assert!(deletable.allowed);
        delete.checkpoint_iteration = Some(1000);
        assert!(!derive_impact(&delete, &state).await.unwrap().allowed);

        std::fs::write(
            project_dir.join("training/checkpoints/checkpoint_000500.ply"),
            b"ply\nformat ascii 1.0\nelement vertex 2\nend_header\n0 0 0\n1 1 1\n",
        )
        .unwrap();
        restore.checkpoint_iteration = Some(500);
        let changed = derive_impact(&restore, &state).await.unwrap();
        assert_ne!(changed.fingerprint, restore_impact.fingerprint);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn project_delete_impact_is_path_safe_and_tracks_range_size_and_identity() {
        let (root, project_dir, project) = test_project("delete-impact");
        let output = project_dir.join("output/data.bin");
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(&output, [1_u8; 64]).unwrap();
        let state = AppState::new();
        let request = request_for(&project, &project_dir, WorkspaceActionKind::DeleteProject);

        let before = derive_impact(&request, &state).await.unwrap();
        assert!(before.allowed && before.irreversible);
        assert!(before.size_bytes.unwrap() >= 64);
        assert!(!before.invalidated.is_empty());
        let serialized =
            serde_json::to_string(&issue_preview(request.clone(), before.clone(), &state).unwrap())
                .unwrap();
        assert!(!serialized.contains(&project_dir.to_string_lossy().to_string()));

        std::fs::write(project_dir.join("output/added.bin"), [2_u8; 32]).unwrap();
        let after = derive_impact(&request, &state).await.unwrap();
        assert_ne!(after.fingerprint, before.fingerprint);

        let bytes_before = std::fs::read(project_dir.join("project.json")).unwrap();
        let mut wrong = request;
        wrong.project_id = uuid::Uuid::now_v7().to_string();
        assert!(derive_impact(&wrong, &state).await.is_err());
        assert_eq!(
            std::fs::read(project_dir.join("project.json")).unwrap(),
            bytes_before
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn stale_preview_is_consumed_without_domain_writes_and_replay_is_rejected() {
        let (root, project_dir, project) = test_project("stale-delete");
        let state = AppState::new();
        let request = request_for(&project, &project_dir, WorkspaceActionKind::DeleteProject);
        let draft = derive_impact(&request, &state).await.unwrap();
        let issued = issue_preview(request, draft, &state).unwrap();

        let external_change = project_dir.join("output/external-change.bin");
        std::fs::create_dir_all(external_change.parent().unwrap()).unwrap();
        std::fs::write(&external_change, [9_u8; 12]).unwrap();
        let gate = consume_revalidated_preview(&issued.preview_token, &state)
            .await
            .unwrap();
        match gate {
            PreviewExecutionGate::Stale(WorkspaceActionExecution::Stale {
                code, preview, ..
            }) => {
                assert_eq!(code, "UI-ACTION-PREVIEW-STALE");
                assert_ne!(preview.preview_token, issued.preview_token);
            }
            _ => panic!("changed impact must require a fresh confirmation"),
        }
        assert!(project_dir.join("project.json").is_file());
        assert_eq!(std::fs::read(&external_change).unwrap(), [9_u8; 12]);

        let replay = consume_revalidated_preview(&issued.preview_token, &state)
            .await
            .unwrap_err();
        assert!(replay.contains("UI-ACTION-PREVIEW-INVALID"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn guarded_dispatch_completes_rerun_restore_and_delete_checkpoint_actions() {
        let (root, project_dir, project) = test_project("guarded-dispatch");
        let state = AppState::new();
        let mut rerun = request_for(&project, &project_dir, WorkspaceActionKind::RerunStage);
        rerun.stage_id = Some("FrameExtraction".into());
        let rerun_receipt = dispatch_ready_action(ready_record(rerun, &state).await, None, &state)
            .await
            .unwrap();
        assert_eq!(rerun_receipt.action, WorkspaceActionKind::RerunStage);

        write_valid_checkpoint(&project_dir, 500);
        write_valid_checkpoint(&project_dir, 1000);
        let mut restore = request_for(
            &project,
            &project_dir,
            WorkspaceActionKind::RestoreCheckpoint,
        );
        restore.checkpoint_iteration = Some(500);
        let restore_receipt =
            dispatch_ready_action(ready_record(restore, &state).await, None, &state)
                .await
                .unwrap();
        assert_eq!(
            restore_receipt.action,
            WorkspaceActionKind::RestoreCheckpoint
        );
        assert!(!project_dir
            .join("training/checkpoints/checkpoint_001000.ply")
            .exists());

        write_valid_checkpoint(&project_dir, 1000);
        let mut delete = request_for(
            &project,
            &project_dir,
            WorkspaceActionKind::DeleteCheckpoint,
        );
        delete.checkpoint_iteration = Some(500);
        let delete_receipt =
            dispatch_ready_action(ready_record(delete, &state).await, None, &state)
                .await
                .unwrap();
        assert_eq!(delete_receipt.action, WorkspaceActionKind::DeleteCheckpoint);
        assert!(!project_dir
            .join("training/checkpoints/checkpoint_000500.ply")
            .exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn guarded_dispatch_completes_pause_and_cancel_with_preserved_results() {
        for action in [WorkspaceActionKind::Pause, WorkspaceActionKind::Cancel] {
            let label = format!("guarded-{action:?}").to_lowercase();
            let (root, project_dir, project) = test_project(&label);
            let state = AppState::new();
            install_active_pipeline(&state, &project, &project_dir);
            let record = ready_record(request_for(&project, &project_dir, action), &state).await;
            let receipt = dispatch_ready_action(record, None, &state).await.unwrap();
            assert_eq!(receipt.action, action);
            assert!(receipt
                .affected_resources
                .iter()
                .any(|item| item == "checkpoints"));
            let intent = *state
                .0
                .lock()
                .unwrap()
                .active_pipeline
                .as_ref()
                .unwrap()
                .control_intent
                .lock()
                .unwrap();
            assert_eq!(
                intent,
                if action == WorkspaceActionKind::Pause {
                    PipelineControlIntent::Pause
                } else {
                    PipelineControlIntent::Cancel
                }
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
