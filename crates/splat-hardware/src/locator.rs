use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use splat_domain::hardware::EnginePaths;

use crate::manifest::{EnginePackManifest, EnginePackSource, EnginePackStatus, IntegrityStatus};

const LOGICAL_ENGINES: [&str; 4] = ["ffmpeg", "ffprobe", "colmap", "brush"];

/// Controls the compatibility behavior used when a signed application
/// resource pack is not present.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineResolutionMode {
    Development,
    Release,
}

impl Default for EngineResolutionMode {
    fn default() -> Self {
        if cfg!(debug_assertions) {
            Self::Development
        } else {
            Self::Release
        }
    }
}

/// Location and application version used to cache a successful full-pack
/// hash pass. The cache is only reused while every file's size and modified
/// timestamp still match.
#[derive(Debug, Clone)]
pub struct EngineIntegrityCacheOptions {
    pub path: PathBuf,
    pub app_version: String,
}

/// Inputs to detailed engine resolution.
#[derive(Debug, Clone, Default)]
pub struct EngineLocatorOptions {
    pub configured_dir: Option<PathBuf>,
    pub configured_executables: BTreeMap<String, PathBuf>,
    pub resource_dir: Option<PathBuf>,
    pub integrity_cache: Option<EngineIntegrityCacheOptions>,
    pub mode: EngineResolutionMode,
}

/// Paths consumed by the pipeline plus diagnostics consumed by startup UI
/// and project preflight.
#[derive(Debug, Clone)]
pub struct EngineResolution {
    pub paths: EnginePaths,
    pub statuses: BTreeMap<String, EnginePackStatus>,
    pub pack_error: Option<String>,
}

impl EngineResolution {
    pub fn status(&self, name: &str) -> Option<&EnginePackStatus> {
        self.statuses.get(name)
    }

    pub fn bundled_pack_is_valid(&self) -> bool {
        LOGICAL_ENGINES.iter().all(|name| {
            self.statuses.get(*name).is_some_and(|status| {
                status.source == EnginePackSource::Resource
                    && status.integrity_status == IntegrityStatus::Valid
            })
        })
    }
}

/// Resolves engine executables from a verified application resource pack,
/// an explicit advanced override, and finally the current process PATH.
pub struct EngineLocator;

impl EngineLocator {
    pub fn resolve(resource_dir: Option<&Path>) -> EnginePaths {
        Self::resolve_with_configured(None, resource_dir)
    }

    /// Compatibility wrapper retained for pipeline callers that only need
    /// paths. New startup/preflight code should use [`Self::resolve_detailed`].
    pub fn resolve_with_configured(
        configured_dir: Option<&Path>,
        resource_dir: Option<&Path>,
    ) -> EnginePaths {
        Self::resolve_detailed(EngineLocatorOptions {
            configured_dir: configured_dir.map(Path::to_path_buf),
            resource_dir: resource_dir.map(Path::to_path_buf),
            ..EngineLocatorOptions::default()
        })
        .paths
    }

    pub fn resolve_detailed(options: EngineLocatorOptions) -> EngineResolution {
        let environment = std::env::var_os("METORIGIN_ENGINE_DIR").map(PathBuf::from);
        let path = std::env::var_os("PATH");
        Self::resolve_detailed_inner(options, environment, path)
    }

    fn resolve_detailed_inner(
        options: EngineLocatorOptions,
        environment_dir: Option<PathBuf>,
        path_value: Option<OsString>,
    ) -> EngineResolution {
        let mut resolution = Self::empty_resolution();
        // METORIGIN_ENGINE_DIR is deliberately a developer-only escape hatch.
        // A release build accepts advanced paths persisted in app settings,
        // but never changes behavior because of a process environment value.
        let environment_dir = (options.mode == EngineResolutionMode::Development)
            .then_some(environment_dir)
            .flatten();
        let resource_exists = options.resource_dir.as_deref().is_some_and(Path::is_dir);

        if options.mode == EngineResolutionMode::Release
            && options.resource_dir.is_some()
            && !resource_exists
        {
            Self::fill_explicit_overrides(&mut resolution, &options, None);
            let missing_root = options
                .resource_dir
                .as_deref()
                .expect("resource_dir was checked above");
            return Self::block_corrupt_pack(
                resolution,
                None,
                crate::manifest::EnginePackError::MissingRoot(missing_root.to_path_buf())
                    .to_string(),
            );
        }

        if options.mode == EngineResolutionMode::Development {
            Self::fill_explicit_overrides(&mut resolution, &options, environment_dir.as_deref());
            if Self::paths_are_complete(&resolution.paths) {
                return resolution;
            }
        }

        if resource_exists {
            let root = options.resource_dir.as_deref().expect("checked above");
            match EnginePackManifest::load_with_digest(root) {
                Ok((manifest, digest)) => {
                    let cache = options
                        .integrity_cache
                        .as_ref()
                        .map(|cache| (cache.path.as_path(), cache.app_version.as_str()));
                    match manifest.verify(root, &digest, cache) {
                        Ok(pack) => {
                            if options.mode == EngineResolutionMode::Release {
                                return Self::resolution_from_pack(pack.executables, pack.statuses);
                            }
                            Self::fill_from_pack(&mut resolution, pack.executables, pack.statuses);
                        }
                        Err(error) => {
                            if options.mode == EngineResolutionMode::Release {
                                Self::fill_explicit_overrides(
                                    &mut resolution,
                                    &options,
                                    environment_dir.as_deref(),
                                );
                            }
                            return Self::block_corrupt_pack(
                                resolution,
                                Some(&manifest),
                                error.to_string(),
                            );
                        }
                    }
                }
                Err(error) => {
                    if options.mode == EngineResolutionMode::Development
                        && matches!(error, crate::manifest::EnginePackError::MissingManifest(_))
                    {
                        Self::fill_from_directory(
                            &mut resolution,
                            root,
                            EnginePackSource::Resource,
                        );
                    } else {
                        if options.mode == EngineResolutionMode::Release {
                            Self::fill_explicit_overrides(
                                &mut resolution,
                                &options,
                                environment_dir.as_deref(),
                            );
                        }
                        return Self::block_corrupt_pack(resolution, None, error.to_string());
                    }
                }
            }
        }

        if options.mode == EngineResolutionMode::Release {
            Self::fill_explicit_overrides(&mut resolution, &options, environment_dir.as_deref());
        }
        Self::fill_from_path(&mut resolution, path_value.as_deref());
        Self::finalize_missing(&mut resolution);
        resolution
    }

    fn empty_resolution() -> EngineResolution {
        EngineResolution {
            paths: EnginePaths::default(),
            statuses: BTreeMap::new(),
            pack_error: None,
        }
    }

    fn resolution_from_pack(
        executables: BTreeMap<String, PathBuf>,
        statuses: BTreeMap<String, EnginePackStatus>,
    ) -> EngineResolution {
        let mut resolution = Self::empty_resolution();
        Self::fill_from_pack(&mut resolution, executables, statuses);
        Self::finalize_missing(&mut resolution);
        resolution
    }

    fn fill_from_pack(
        resolution: &mut EngineResolution,
        executables: BTreeMap<String, PathBuf>,
        statuses: BTreeMap<String, EnginePackStatus>,
    ) {
        for (name, path) in executables {
            if Self::path_for(&resolution.paths, &name).is_none() {
                Self::set_path(&mut resolution.paths, &name, path);
                if let Some(status) = statuses.get(&name) {
                    resolution.statuses.insert(name, status.clone());
                }
            }
        }
    }

    fn fill_explicit_overrides(
        resolution: &mut EngineResolution,
        options: &EngineLocatorOptions,
        environment_dir: Option<&Path>,
    ) {
        if let Some(environment_dir) = environment_dir {
            Self::fill_from_directory(resolution, environment_dir, EnginePackSource::Environment);
            return;
        }

        for name in LOGICAL_ENGINES {
            if Self::path_for(&resolution.paths, name).is_some() {
                continue;
            }
            if let Some(path) = options.configured_executables.get(name) {
                if path.is_file() {
                    Self::set_external(
                        resolution,
                        name,
                        path.clone(),
                        EnginePackSource::ConfiguredOrPath,
                    );
                }
            }
        }
        if let Some(configured_dir) = options.configured_dir.as_deref() {
            Self::fill_from_directory(
                resolution,
                configured_dir,
                EnginePackSource::ConfiguredOrPath,
            );
        }
    }

    fn fill_from_directory(
        resolution: &mut EngineResolution,
        root: &Path,
        source: EnginePackSource,
    ) {
        for name in LOGICAL_ENGINES {
            if Self::path_for(&resolution.paths, name).is_some() {
                continue;
            }
            if let Some(candidate) = Self::candidates(root, name)
                .into_iter()
                .find(|candidate| candidate.is_file())
            {
                Self::set_external(resolution, name, candidate, source);
            }
        }
    }

    fn fill_from_path(resolution: &mut EngineResolution, path_value: Option<&std::ffi::OsStr>) {
        for name in LOGICAL_ENGINES {
            if Self::path_for(&resolution.paths, name).is_some() {
                continue;
            }
            if let Some(path) = Self::find_on_path_value(name, path_value) {
                Self::set_external(resolution, name, path, EnginePackSource::ConfiguredOrPath);
            }
        }
    }

    fn block_corrupt_pack(
        mut resolution: EngineResolution,
        manifest: Option<&EnginePackManifest>,
        error: String,
    ) -> EngineResolution {
        let diagnostic = format!("内置引擎包校验失败：{error}。请重新安装或修复 MetOrigin Splat。");
        resolution.pack_error = Some(diagnostic.clone());
        for name in LOGICAL_ENGINES {
            if Self::path_for(&resolution.paths, name).is_some() {
                if let Some(status) = resolution.statuses.get_mut(name) {
                    status.diagnostic =
                        Some(format!("{diagnostic} 当前仅使用明确配置的外部引擎。"));
                }
                continue;
            }
            let (pack_version, expected_version) = manifest
                .map(|manifest| {
                    (
                        Some(manifest.pack_version.clone()),
                        manifest.engines.values().find_map(|engine| {
                            engine
                                .executables
                                .contains_key(name)
                                .then(|| engine.version.clone())
                        }),
                    )
                })
                .unwrap_or((None, None));
            resolution.statuses.insert(
                name.into(),
                EnginePackStatus {
                    source: EnginePackSource::Missing,
                    pack_version,
                    integrity_status: IntegrityStatus::Invalid,
                    expected_version,
                    actual_version: None,
                    diagnostic: Some(diagnostic.clone()),
                },
            );
        }
        resolution
    }

    fn finalize_missing(resolution: &mut EngineResolution) {
        for name in LOGICAL_ENGINES {
            if Self::path_for(&resolution.paths, name).is_none() {
                resolution.statuses.entry(name.into()).or_insert_with(|| {
                    EnginePackStatus::missing(format!("未找到 {name} 可执行文件。"))
                });
            }
        }
    }

    fn set_external(
        resolution: &mut EngineResolution,
        name: &str,
        path: PathBuf,
        source: EnginePackSource,
    ) {
        Self::set_path(&mut resolution.paths, name, path);
        resolution
            .statuses
            .insert(name.into(), EnginePackStatus::external(source));
    }

    fn set_path(paths: &mut EnginePaths, name: &str, path: PathBuf) {
        match name {
            "ffmpeg" => paths.ffmpeg = Some(path),
            "ffprobe" => paths.ffprobe = Some(path),
            "colmap" => paths.colmap = Some(path),
            "brush" => paths.brush = Some(path),
            _ => {}
        }
    }

    fn path_for<'a>(paths: &'a EnginePaths, name: &str) -> Option<&'a PathBuf> {
        match name {
            "ffmpeg" => paths.ffmpeg.as_ref(),
            "ffprobe" => paths.ffprobe.as_ref(),
            "colmap" => paths.colmap.as_ref(),
            "brush" => paths.brush.as_ref(),
            _ => None,
        }
    }

    fn paths_are_complete(paths: &EnginePaths) -> bool {
        LOGICAL_ENGINES
            .iter()
            .all(|name| Self::path_for(paths, name).is_some())
    }

    fn candidates(root: &Path, name: &str) -> Vec<PathBuf> {
        let executable = Self::executable_name(name);
        let mut candidates = vec![
            root.join(&executable),
            root.join("bin").join(&executable),
            root.join(name).join(&executable),
            root.join(name).join("bin").join(&executable),
        ];
        if cfg!(windows) && name == "brush" {
            candidates.push(root.join("brush_app.exe"));
            candidates.push(root.join("bin").join("brush_app.exe"));
        }
        let mut search_parents = vec![root.to_path_buf(), root.join(name)];
        if name == "ffprobe" {
            search_parents.push(root.join("ffmpeg"));
        }
        for parent in search_parents {
            let Ok(entries) = std::fs::read_dir(parent) else {
                continue;
            };
            let mut versioned_roots = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect::<Vec<_>>();
            versioned_roots.sort();
            versioned_roots.reverse();
            for versioned_root in versioned_roots {
                candidates.push(versioned_root.join(&executable));
                candidates.push(versioned_root.join("bin").join(&executable));
                if cfg!(windows) && name == "brush" {
                    candidates.push(versioned_root.join("brush_app.exe"));
                    candidates.push(versioned_root.join("bin").join("brush_app.exe"));
                }
            }
        }
        candidates
    }

    #[cfg(test)]
    fn find_on_path(name: &str) -> Option<PathBuf> {
        let path = std::env::var_os("PATH");
        Self::find_on_path_value(name, path.as_deref())
    }

    fn find_on_path_value(name: &str, path_value: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
        let executable = Self::executable_name(name);
        path_value.and_then(|paths| {
            std::env::split_paths(paths)
                .flat_map(|directory| {
                    let mut candidates = vec![directory.join(&executable)];
                    if cfg!(windows) && name == "brush" {
                        candidates.push(directory.join("brush_app.exe"));
                    }
                    candidates
                })
                .find(|candidate| candidate.is_file())
        })
    }

    fn executable_name(name: &str) -> String {
        if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;
    use sha2::{Digest, Sha256};

    use super::*;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "metorigin-engine-pack-{label}-{}-{id}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn file_hash(bytes: &[u8]) -> String {
        let mut digest = Sha256::new();
        digest.update(bytes);
        format!("{:X}", digest.finalize())
    }

    fn create_file(root: &Path, relative: &str, bytes: &[u8]) -> serde_json::Value {
        let path = relative
            .split('/')
            .fold(root.to_path_buf(), |path, segment| path.join(segment));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
        json!({
            "path": relative,
            "sha256": file_hash(bytes),
            "size_bytes": bytes.len(),
        })
    }

    fn write_valid_pack(root: &Path) {
        let ffmpeg = create_file(root, "ffmpeg/bin/ffmpeg.exe", b"ffmpeg");
        let ffprobe = create_file(root, "ffmpeg/bin/ffprobe.exe", b"ffprobe");
        let ffmpeg_license = create_file(root, "ffmpeg/LICENSE", b"GPL-3.0");
        let colmap = create_file(root, "colmap/bin/colmap.exe", b"colmap");
        let colmap_license = create_file(root, "colmap/COPYING.txt", b"BSD");
        let brush = create_file(root, "brush/brush_app.exe", b"brush");
        let brush_license = create_file(root, "brush/LICENSE", b"Apache-2.0");
        let manifest = json!({
            "schema_version": 1,
            "pack_version": "0.1.0-internal.1",
            "platform": "windows-x64",
            "engines": {
                "ffmpeg": {
                    "version": "8.1.2",
                    "executables": {
                        "ffmpeg": "ffmpeg/bin/ffmpeg.exe",
                        "ffprobe": "ffmpeg/bin/ffprobe.exe"
                    },
                    "source_url": "https://example.invalid/ffmpeg.zip",
                    "source_sha256": "A".repeat(64),
                    "files": [ffmpeg, ffprobe, ffmpeg_license],
                    "license_files": ["ffmpeg/LICENSE"]
                },
                "colmap": {
                    "version": "4.1.0",
                    "executables": {"colmap": "colmap/bin/colmap.exe"},
                    "source_url": "https://example.invalid/colmap.zip",
                    "source_sha256": "B".repeat(64),
                    "files": [colmap, colmap_license],
                    "license_files": ["colmap/COPYING.txt"]
                },
                "brush": {
                    "version": "0.3.0",
                    "executables": {"brush": "brush/brush_app.exe"},
                    "source_url": "https://example.invalid/brush.zip",
                    "source_sha256": "C".repeat(64),
                    "files": [brush, brush_license],
                    "license_files": ["brush/LICENSE"]
                }
            }
        });
        std::fs::write(
            root.join("engine-manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
    }

    fn release_options(resource_dir: &Path) -> EngineLocatorOptions {
        EngineLocatorOptions {
            resource_dir: Some(resource_dir.to_path_buf()),
            mode: EngineResolutionMode::Release,
            ..EngineLocatorOptions::default()
        }
    }

    fn resolve_without_process_environment(
        options: EngineLocatorOptions,
        path: Option<&Path>,
    ) -> EngineResolution {
        EngineLocator::resolve_detailed_inner(
            options,
            None,
            path.map(|path| std::env::join_paths([path]).unwrap()),
        )
    }

    #[test]
    fn candidates_cover_supported_layouts() {
        let candidates = EngineLocator::candidates(Path::new("engines"), "ffmpeg");
        assert!(candidates.len() >= 4);
        let suffix = if cfg!(windows) {
            Path::new("ffmpeg/bin/ffmpeg.exe")
        } else {
            Path::new("ffmpeg/bin/ffmpeg")
        };
        assert!(candidates.iter().any(|path| path.ends_with(suffix)));

        let brush = EngineLocator::candidates(Path::new("engines"), "brush");
        if cfg!(windows) {
            assert!(brush.iter().any(|path| path.ends_with("brush_app.exe")));
        }
    }

    #[test]
    fn missing_resource_directory_is_safe() {
        let paths = EngineLocator::resolve(Some(Path::new("definitely-missing-engines")));
        assert_eq!(
            paths.ffmpeg.is_some(),
            EngineLocator::find_on_path("ffmpeg").is_some()
        );
    }

    #[test]
    fn verifies_manifest_and_resolves_all_resource_executables() {
        let root = TestDirectory::new("valid");
        write_valid_pack(root.path());

        let resolution = resolve_without_process_environment(release_options(root.path()), None);

        assert!(resolution.paths.is_complete());
        assert!(resolution.bundled_pack_is_valid());
        assert_eq!(
            resolution
                .status("ffmpeg")
                .unwrap()
                .expected_version
                .as_deref(),
            Some("8.1.2")
        );
        assert_eq!(
            resolution
                .status("ffprobe")
                .unwrap()
                .expected_version
                .as_deref(),
            Some("8.1.2")
        );
    }

    #[test]
    fn release_resource_pack_precedes_explicit_external_directory() {
        let root = TestDirectory::new("precedence-resource");
        let configured = TestDirectory::new("precedence-configured");
        write_valid_pack(root.path());
        let configured_ffmpeg = configured
            .path()
            .join(EngineLocator::executable_name("ffmpeg"));
        std::fs::write(&configured_ffmpeg, b"configured").unwrap();
        let mut options = release_options(root.path());
        options.configured_dir = Some(configured.path().to_path_buf());

        let resolution = resolve_without_process_environment(options, None);

        assert_ne!(resolution.paths.ffmpeg.as_ref(), Some(&configured_ffmpeg));
        assert_eq!(
            resolution.status("ffmpeg").unwrap().source,
            EnginePackSource::Resource
        );
    }

    #[test]
    fn release_mode_ignores_developer_environment_directory() {
        let environment = TestDirectory::new("release-environment");
        let ffmpeg = environment
            .path()
            .join(EngineLocator::executable_name("ffmpeg"));
        std::fs::write(&ffmpeg, b"environment").unwrap();
        let options = EngineLocatorOptions {
            mode: EngineResolutionMode::Release,
            ..EngineLocatorOptions::default()
        };

        let resolution = EngineLocator::resolve_detailed_inner(
            options,
            Some(environment.path().to_path_buf()),
            None,
        );

        assert!(resolution.paths.ffmpeg.is_none());
        assert_eq!(
            resolution.status("ffmpeg").unwrap().source,
            EnginePackSource::Missing
        );
    }

    #[test]
    fn missing_release_manifest_blocks_path_fallback() {
        let root = TestDirectory::new("missing-manifest");
        let path = TestDirectory::new("missing-manifest-path");
        for name in LOGICAL_ENGINES {
            std::fs::write(
                path.path().join(EngineLocator::executable_name(name)),
                b"path",
            )
            .unwrap();
        }

        let resolution =
            resolve_without_process_environment(release_options(root.path()), Some(path.path()));

        assert!(!resolution.paths.is_complete());
        assert!(resolution.paths.ffmpeg.is_none());
        assert_eq!(
            resolution.status("ffmpeg").unwrap().integrity_status,
            IntegrityStatus::Invalid
        );
        assert!(resolution.pack_error.is_some());
    }

    #[test]
    fn missing_release_resource_directory_blocks_path_fallback() {
        let root = TestDirectory::new("missing-resource-root");
        let missing_resource = root.path().join("resources/engines");
        let path = TestDirectory::new("missing-resource-path");
        std::fs::write(
            path.path().join(EngineLocator::executable_name("ffmpeg")),
            b"path",
        )
        .unwrap();
        let options = EngineLocatorOptions {
            resource_dir: Some(missing_resource),
            mode: EngineResolutionMode::Release,
            ..EngineLocatorOptions::default()
        };

        let resolution = resolve_without_process_environment(options, Some(path.path()));

        assert!(resolution.paths.ffmpeg.is_none());
        assert_eq!(
            resolution.status("ffmpeg").unwrap().integrity_status,
            IntegrityStatus::Invalid
        );
        assert!(resolution.pack_error.is_some());
    }

    #[test]
    fn wrong_file_hash_blocks_path_fallback() {
        let root = TestDirectory::new("wrong-hash");
        let path = TestDirectory::new("wrong-hash-path");
        write_valid_pack(root.path());
        std::fs::write(root.path().join("brush/brush_app.exe"), b"brash").unwrap();
        for name in LOGICAL_ENGINES {
            std::fs::write(
                path.path().join(EngineLocator::executable_name(name)),
                b"path",
            )
            .unwrap();
        }

        let resolution =
            resolve_without_process_environment(release_options(root.path()), Some(path.path()));

        assert!(resolution.paths.brush.is_none());
        assert!(resolution
            .pack_error
            .as_deref()
            .is_some_and(|error| error.contains("SHA-256")));
    }

    #[test]
    fn missing_declared_file_invalidates_the_entire_pack() {
        let root = TestDirectory::new("missing-file");
        write_valid_pack(root.path());
        std::fs::remove_file(root.path().join("colmap/bin/colmap.exe")).unwrap();

        let resolution = resolve_without_process_environment(release_options(root.path()), None);

        assert!(!resolution.paths.is_complete());
        assert_eq!(
            resolution.status("colmap").unwrap().integrity_status,
            IntegrityStatus::Invalid
        );
        assert!(resolution
            .pack_error
            .as_deref()
            .is_some_and(|error| error.contains("missing")));
    }

    #[test]
    fn traversal_in_manifest_is_rejected() {
        let root = TestDirectory::new("traversal");
        write_valid_pack(root.path());
        let manifest_path = root.path().join("engine-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["engines"]["brush"]["executables"]["brush"] = json!("../brush_app.exe");
        std::fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();

        let resolution = resolve_without_process_environment(release_options(root.path()), None);

        assert!(resolution.paths.brush.is_none());
        assert!(resolution
            .pack_error
            .as_deref()
            .is_some_and(|error| error.contains("unsafe engine pack path")));
    }

    #[test]
    fn development_mode_keeps_legacy_dot_engines_layout() {
        let root = TestDirectory::new("legacy");
        let ffmpeg = root.path().join(EngineLocator::executable_name("ffmpeg"));
        std::fs::write(&ffmpeg, b"legacy").unwrap();
        let options = EngineLocatorOptions {
            resource_dir: Some(root.path().to_path_buf()),
            mode: EngineResolutionMode::Development,
            ..EngineLocatorOptions::default()
        };

        let resolution = resolve_without_process_environment(options, None);

        assert_eq!(resolution.paths.ffmpeg.as_ref(), Some(&ffmpeg));
        assert_eq!(
            resolution.status("ffmpeg").unwrap().source,
            EnginePackSource::Resource
        );
    }

    #[test]
    fn integrity_cache_is_invalidated_when_a_file_changes() {
        let root = TestDirectory::new("cache");
        write_valid_pack(root.path());
        let cache_path = root.path().join("cache/status.json");
        let mut options = release_options(root.path());
        options.integrity_cache = Some(EngineIntegrityCacheOptions {
            path: cache_path.clone(),
            app_version: "0.1.0".into(),
        });
        let first = resolve_without_process_environment(options.clone(), None);
        assert!(first.bundled_pack_is_valid());
        assert!(cache_path.is_file());

        std::fs::write(root.path().join("ffmpeg/bin/ffmpeg.exe"), b"changed").unwrap();
        let second = resolve_without_process_environment(options, None);

        assert!(second.paths.ffmpeg.is_none());
        assert_eq!(
            second.status("ffmpeg").unwrap().integrity_status,
            IntegrityStatus::Invalid
        );
    }

    #[test]
    fn candidates_include_versioned_engine_pack_layouts() {
        let root = TestDirectory::new("versioned");
        let ffmpeg_executable = EngineLocator::executable_name("ffmpeg");
        let ffprobe_executable = EngineLocator::executable_name("ffprobe");
        let expected_ffmpeg = root
            .path()
            .join("ffmpeg")
            .join("ffmpeg-8.1.2")
            .join("bin")
            .join(ffmpeg_executable);
        let expected_ffprobe = expected_ffmpeg.with_file_name(ffprobe_executable);
        std::fs::create_dir_all(expected_ffmpeg.parent().unwrap()).unwrap();
        std::fs::write(&expected_ffmpeg, b"test").unwrap();
        std::fs::write(&expected_ffprobe, b"test").unwrap();

        assert!(EngineLocator::candidates(root.path(), "ffmpeg").contains(&expected_ffmpeg));
        assert!(EngineLocator::candidates(root.path(), "ffprobe").contains(&expected_ffprobe));
    }
}
