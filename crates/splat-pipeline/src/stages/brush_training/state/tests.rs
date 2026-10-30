use super::*;
use splat_domain::{ExecutionProfile, PipelineStageId};
use std::sync::Arc;

const PLY: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../test-fixtures/gaussian/minimal-sh0-ascii.ply"
));

fn context() -> (tempfile::TempDir, StageContext) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = StageContext::new(
        PipelineStageId::BrushTraining,
        dir.path(),
        Some("fast".into()),
    );
    std::fs::create_dir_all(ctx.paths.training_dataset.join("images")).unwrap();
    std::fs::write(
        ctx.paths.training_dataset.join("images/a.jpg"),
        b"fixture image",
    )
    .unwrap();
    std::fs::create_dir_all(&ctx.paths.training_checkpoints).unwrap();
    (dir, ctx)
}

fn key(ctx: &StageContext) -> String {
    let config = super::super::effective_config(ctx, "fast").unwrap();
    fingerprint(ctx, &config, "brush-cli 1.0.0", "fixture-binary", None).unwrap()
}

fn complete_fixture(ctx: &StageContext) -> PathBuf {
    let checkpoint = ctx.paths.training_checkpoints.join("checkpoint_3000.ply");
    std::fs::write(&checkpoint, PLY).unwrap();
    std::fs::write(&ctx.paths.training_result, b"{\"success\":true}").unwrap();
    complete(ctx, key(ctx), &checkpoint, 3000).unwrap();
    checkpoint
}

#[test]
fn only_success_metadata_with_matching_hashes_is_cacheable() {
    let (_dir, ctx) = context();
    let checkpoint = ctx.paths.training_checkpoints.join("checkpoint_3000.ply");
    std::fs::write(&checkpoint, PLY).unwrap();
    assert!(!completed_matches(&ctx, &key(&ctx), 3000).unwrap());
    start(&ctx, key(&ctx)).unwrap();
    assert!(!completed_matches(&ctx, &key(&ctx), 3000).unwrap());
    complete_fixture(&ctx);
    assert!(completed_matches(&ctx, &key(&ctx), 3000).unwrap());
    assert!(!completed_matches(&ctx, &key(&ctx), 7000).unwrap());
    std::fs::write(&ctx.paths.training_result, b"{}").unwrap();
    assert!(!completed_matches(&ctx, &key(&ctx), 3000).unwrap());
    complete_fixture(&ctx);
    std::fs::write(checkpoint, b"ply\n").unwrap();
    assert!(!completed_matches(&ctx, &key(&ctx), 3000).unwrap());
}

#[test]
fn fingerprint_binds_content_engine_and_limits_but_not_run_or_probe() {
    let (_dir, mut ctx) = context();
    let profile = ExecutionProfile::from_json(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../schemas/examples/execution-profile/macos.valid.json"
    )))
    .unwrap();
    ctx.execution_profile = Some(Arc::new(profile));
    let initial = key(&ctx);
    let profile = Arc::make_mut(ctx.execution_profile.as_mut().unwrap());
    profile.run_id = *ProjectId::new().as_uuid();
    profile.os_version = "new patch version".into();
    profile.brush.probe_result.device_name = Some("fresh probe label".into());
    assert_eq!(initial, key(&ctx));
    std::fs::write(ctx.paths.training_dataset.join("init.ply"), PLY).unwrap();
    assert_eq!(initial, key(&ctx));
    std::fs::write(
        ctx.paths.training_dataset.join("images/a.jpg"),
        b"different image",
    )
    .unwrap();
    assert_ne!(initial, key(&ctx));
    std::fs::write(
        ctx.paths.training_dataset.join("images/a.jpg"),
        b"fixture image",
    )
    .unwrap();
    let profile = Arc::make_mut(ctx.execution_profile.as_mut().unwrap());
    profile.effective_training.max_splats = Some(123_456);
    assert_ne!(initial, key(&ctx));
    let config = TrainingConfig::from_builtin("fast").unwrap();
    assert_ne!(
        fingerprint(&ctx, &config, "v1", "hash-a", None).unwrap(),
        fingerprint(&ctx, &config, "v1", "hash-b", None).unwrap()
    );
    assert_ne!(
        fingerprint(&ctx, &config, "v1", "hash-a", None).unwrap(),
        fingerprint(&ctx, &config, "v1", "hash-a", Some("companion")).unwrap()
    );
}

#[test]
fn fingerprint_binds_preparation_provenance_and_embedded_arguments() {
    let (_dir, ctx) = context();
    let initial = key(&ctx);
    std::fs::write(
        ctx.paths
            .training_dataset
            .join("preparation-fingerprint.json"),
        b"source A",
    )
    .unwrap();
    let prepared = key(&ctx);
    assert_ne!(initial, prepared);
    std::fs::write(
        ctx.paths
            .training_dataset
            .join("preparation-fingerprint.json"),
        b"source B",
    )
    .unwrap();
    assert_ne!(prepared, key(&ctx));
    std::fs::write(
        ctx.paths.training_dataset.join("args.txt"),
        b"--max-splats 100",
    )
    .unwrap();
    assert_ne!(initial, key(&ctx));
}

#[test]
fn archive_preserves_checkpoint_result_unknown_init_and_metadata() {
    let (_dir, ctx) = context();
    complete_fixture(&ctx);
    std::fs::write(
        ctx.paths.training_dataset.join("init.ply"),
        b"unknown user geometry",
    )
    .unwrap();
    archive(&ctx).unwrap();
    assert!(!ctx.paths.training_checkpoints.exists());
    assert!(!ctx.paths.training_result.exists());
    assert!(!state_path(&ctx).exists());
    assert!(ctx.paths.training_dataset.join("images/a.jpg").is_file());
    let archive = std::fs::read_dir(ctx.project_dir.join("runtime/previous-training"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(archive.join("checkpoints/checkpoint_3000.ply")).unwrap(),
        PLY
    );
    assert_eq!(
        std::fs::read(archive.join("init.ply")).unwrap(),
        b"unknown user geometry"
    );
    assert!(archive.join("result.json").is_file());
    assert!(archive.join(STATE_FILE).is_file());
    assert!(archive.join("archive.json").is_file());
    assert!(!journal_path(&ctx).exists());
}

#[test]
fn interrupted_archive_continues_without_overwriting_data() {
    let (_dir, ctx) = context();
    complete_fixture(&ctx);
    let journal = ArchiveJournal {
        schema_version: VERSION,
        archive_id: ProjectId::new().to_string(),
        entries: vec![
            ArchiveEntry::Checkpoints,
            ArchiveEntry::Result,
            ArchiveEntry::Fingerprint,
        ],
    };
    write_json_atomic(&journal, &journal_path(&ctx)).unwrap();
    let destination = ctx
        .project_dir
        .join("runtime/previous-training")
        .join(&journal.archive_id);
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::rename(
        &ctx.paths.training_checkpoints,
        destination.join("checkpoints"),
    )
    .unwrap();
    assert!(!completed_matches(&ctx, &key(&ctx), 3000).unwrap());
    recover_archive(&ctx).unwrap();
    assert!(destination.join("result.json").is_file());
    assert!(destination.join(STATE_FILE).is_file());
    recover_archive(&ctx).unwrap();
    assert!(destination
        .join("checkpoints/checkpoint_3000.ply")
        .is_file());
}

#[test]
fn archive_conflicts_and_future_formats_preserve_source_files() {
    let (_dir, ctx) = context();
    complete_fixture(&ctx);
    std::fs::write(state_path(&ctx), b"{\"schema_version\":2}").unwrap();
    assert!(load(&ctx).is_err());
    assert!(ctx.paths.training_checkpoints.exists());
    let journal = ArchiveJournal {
        schema_version: VERSION,
        archive_id: ProjectId::new().to_string(),
        entries: vec![ArchiveEntry::Result],
    };
    write_json_atomic(&journal, &journal_path(&ctx)).unwrap();
    let destination = ctx
        .project_dir
        .join("runtime/previous-training")
        .join(&journal.archive_id);
    std::fs::create_dir_all(&destination).unwrap();
    std::fs::write(destination.join("result.json"), b"different result").unwrap();
    assert!(recover_archive(&ctx).is_err());
    assert_eq!(
        std::fs::read(destination.join("result.json")).unwrap(),
        b"different result"
    );
    assert!(ctx.paths.training_result.is_file());
    assert!(journal_path(&ctx).is_file());
}

#[test]
fn malformed_legacy_state_is_archived_instead_of_authorizing_resume() {
    let (_dir, ctx) = context();
    std::fs::write(state_path(&ctx), b"partial metadata").unwrap();
    assert!(load(&ctx).unwrap().is_none());
    archive(&ctx).unwrap();
    let archive = std::fs::read_dir(ctx.project_dir.join("runtime/previous-training"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(
        std::fs::read(archive.join(STATE_FILE)).unwrap(),
        b"partial metadata"
    );
}

#[cfg(unix)]
#[test]
fn managed_dataset_symlinks_are_not_fingerprinted_as_trusted_inputs() {
    let (_dir, ctx) = context();
    std::os::unix::fs::symlink(
        "images/a.jpg",
        ctx.paths.training_dataset.join("linked.jpg"),
    )
    .unwrap();
    let config = TrainingConfig::from_builtin("fast").unwrap();
    assert!(fingerprint(&ctx, &config, "v1", "hash", None).is_err());
}
