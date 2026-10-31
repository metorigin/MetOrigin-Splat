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
    /// Prepared Windows packs require a manifest even in development builds.
    pub require_resource_manifest: bool,
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
        let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("windows", "x86_64") => "windows-x64".to_string(),
            ("macos", "aarch64") => "macos-arm64".to_string(),
            (os, arch) => format!("{os}-{arch}"),
        };
        Self::resolve_detailed_inner(options, environment, path, &platform)
    }

    fn resolve_detailed_inner(
        options: EngineLocatorOptions,
        environment_dir: Option<PathBuf>,
        path_value: Option<OsString>,
        expected_platform: &str,
    ) -> EngineResolution {
        let mut resolution = Self::empty_resolution();
        // METORIGIN_ENGINE_DIR is deliberately a developer-only escape hatch.
        // A release build accepts advanced paths persisted in app settings,
        // but never changes behavior because of a process environment value.
        let environment_dir = (options.mode == EngineResolutionMode::Development)
            .then_some(environment_dir)
            .flatten();
        let resource_exists = options.resource_dir.as_deref().is_some_and(Path::is_dir);

        // Windows development directories can be complete managed packs. Verify
        // them before the historical loose-executable fast path, even when all
        // four executables exist. A selected broken pack must not leak into PATH.
        if options.mode == EngineResolutionMode::Development && expected_platform == "windows-x64" {
            if environment_dir.is_none() {
                let mut individual_options = options.clone();
                individual_options.configured_dir = None;
                Self::fill_explicit_overrides(
                    &mut resolution,
                    &individual_options,
                    None,
                    expected_platform,
                );
                if Self::paths_are_complete(&resolution.paths) {
                    return resolution;
                }
            }
            let selected = environment_dir
                .as_deref()
                .or(options.configured_dir.as_deref());
            if let Some(root) = selected {
                if !root.is_dir() {
                    return Self::block_corrupt_pack(
                        resolution,
                        None,
                        format!(
                            "Explicit engine directory does not exist: {}",
                            root.display()
                        ),
                    );
                }
                if Self::managed_directory_required(root, &options) {
                    match Self::verify_selected_pack(root, &options, expected_platform) {
                        Ok(mut pack) => {
                            if environment_dir.is_some() {
                                for status in pack.statuses.values_mut() {
                                    status.source = EnginePackSource::Environment;
                                }
                                return pack;
                            }
                            for status in pack.statuses.values_mut() {
                                status.source = EnginePackSource::ConfiguredOrPath;
                            }
                            // Individual saved paths precede the saved directory.
                            let mut executable_options = options.clone();
                            executable_options.configured_dir = None;
                            Self::fill_explicit_overrides(
                                &mut resolution,
                                &executable_options,
                                None,
                                expected_platform,
                            );
                            Self::fill_from_pack(
                                &mut resolution,
                                Self::executable_map(&pack.paths),
                                pack.statuses,
                            );
                            Self::finalize_missing(&mut resolution);
                            return resolution;
                        }
                        Err(error) => return Self::block_corrupt_pack(resolution, None, error),
                    }
                }
            }
        }

        if (options.mode == EngineResolutionMode::Release || options.require_resource_manifest)
            && options.resource_dir.is_some()
            && !resource_exists
        {
            Self::fill_explicit_overrides(&mut resolution, &options, None, expected_platform);
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
            Self::fill_explicit_overrides(
                &mut resolution,
                &options,
                environment_dir.as_deref(),
                expected_platform,
            );
            if resolution.pack_error.is_some() {
                return resolution;
            }
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
                    match manifest.verify(root, &digest, cache, expected_platform) {
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
                                    expected_platform,
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
                        && !options.require_resource_manifest
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
                                expected_platform,
                            );
                        }
                        return Self::block_corrupt_pack(resolution, None, error.to_string());
                    }
                }
            }
        }

        if options.mode == EngineResolutionMode::Release {
            Self::fill_explicit_overrides(
                &mut resolution,
                &options,
                environment_dir.as_deref(),
                expected_platform,
            );
            if resolution.pack_error.is_some() {
                return resolution;
            }
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

    fn verify_selected_pack(
        root: &Path,
        options: &EngineLocatorOptions,
        platform: &str,
    ) -> Result<EngineResolution, String> {
        let (manifest, digest) =
            EnginePackManifest::load_with_digest(root).map_err(|error| error.to_string())?;
        let cache = options
            .integrity_cache
            .as_ref()
            .map(|cache| (cache.path.as_path(), cache.app_version.as_str()));
        let pack = manifest
            .verify(root, &digest, cache, platform)
            .map_err(|error| error.to_string())?;
        Ok(Self::resolution_from_pack(pack.executables, pack.statuses))
    }

    fn managed_directory_required(root: &Path, options: &EngineLocatorOptions) -> bool {
        root.join("engine-manifest.json").exists()
            || root.join("BUILD-INFO.json").exists()
            || root.ends_with("target/distribution/windows-x64/engines")
            || root.ends_with("target/distribution/windows-x64-alignment/engines")
            || (options.require_resource_manifest
                && options.resource_dir.as_deref().is_some_and(|resource| {
                    root == resource
                        || std::fs::canonicalize(root)
                            .ok()
                            .zip(std::fs::canonicalize(resource).ok())
                            .is_some_and(|(selected, prepared)| selected == prepared)
                }))
    }

    fn executable_map(paths: &EnginePaths) -> BTreeMap<String, PathBuf> {
        LOGICAL_ENGINES
            .into_iter()
            .filter_map(|name| {
                Self::path_for(paths, name).map(|path| (name.to_string(), path.clone()))
            })
            .collect()
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
        expected_platform: &str,
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
            if expected_platform == "windows-x64" {
                if !configured_dir.is_dir() {
                    *resolution = Self::block_corrupt_pack(
                        resolution.clone(),
                        None,
                        "Explicit engine directory does not exist".into(),
                    );
                    return;
                }
                if Self::managed_directory_required(configured_dir, options) {
                    match Self::verify_selected_pack(configured_dir, options, expected_platform) {
                        Ok(mut pack) => {
                            for status in pack.statuses.values_mut() {
                                status.source = EnginePackSource::ConfiguredOrPath;
                            }
                            Self::fill_from_pack(
                                resolution,
                                Self::executable_map(&pack.paths),
                                pack.statuses,
                            );
                        }
                        Err(error) => {
                            *resolution = Self::block_corrupt_pack(resolution.clone(), None, error)
                        }
                    }
                    return;
                }
            }
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
            candidates.extend([
                root.join("brush-cli.exe"),
                root.join("bin/brush-cli.exe"),
                root.join("brush/brush-cli.exe"),
                root.join("brush/bin/brush-cli.exe"),
            ]);
            candidates.push(root.join("brush_app.exe"));
            candidates.push(root.join("bin").join("brush_app.exe"));
        }
        if cfg!(unix) && name == "brush" {
            candidates.extend([
                root.join("brush-cli"),
                root.join("bin/brush-cli"),
                root.join("brush/brush-cli"),
                root.join("brush/bin/brush-cli"),
            ]);
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
                    candidates.push(versioned_root.join("brush-cli.exe"));
                    candidates.push(versioned_root.join("bin/brush-cli.exe"));
                    candidates.push(versioned_root.join("brush_app.exe"));
                    candidates.push(versioned_root.join("bin").join("brush_app.exe"));
                }
                if cfg!(unix) && name == "brush" {
                    candidates.push(versioned_root.join("brush-cli"));
                    candidates.push(versioned_root.join("bin/brush-cli"));
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
                        candidates.push(directory.join("brush-cli.exe"));
                        candidates.push(directory.join("brush_app.exe"));
                    }
                    if cfg!(unix) && name == "brush" {
                        candidates.push(directory.join("brush-cli"));
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

    #[test]
    fn windows_explicit_managed_directory_verifies_all_files_before_fast_path() {
        let root = TestDirectory::new("dev-managed");
        write_valid_pack(root.path());
        let options = EngineLocatorOptions {
            configured_dir: Some(root.path().into()),
            mode: EngineResolutionMode::Development,
            ..Default::default()
        };
        let good =
            EngineLocator::resolve_detailed_inner(options.clone(), None, None, "windows-x64");
        assert!(good.paths.is_complete());
        assert_eq!(
            good.status("brush").unwrap().integrity_status,
            IntegrityStatus::Valid
        );
        std::fs::write(root.path().join("brush/LICENSE"), b"tampered notice").unwrap();
        let bad = EngineLocator::resolve_detailed_inner(options.clone(), None, None, "windows-x64");
        assert!(bad.pack_error.is_some());
        assert!(!bad.paths.is_complete());
        let bad_env = EngineLocator::resolve_detailed_inner(
            options,
            Some(root.path().into()),
            None,
            "windows-x64",
        );
        assert!(bad_env.pack_error.is_some());
        assert!(!bad_env.paths.is_complete());
    }

    #[test]
    fn windows_missing_explicit_directory_and_prepared_manifest_block_fallback() {
        let root = TestDirectory::new("dev-missing");
        let options = EngineLocatorOptions {
            configured_dir: Some(root.path().join("missing")),
            mode: EngineResolutionMode::Development,
            ..Default::default()
        };
        let bad = EngineLocator::resolve_detailed_inner(options, None, None, "windows-x64");
        assert!(bad.pack_error.is_some());
        let bad = EngineLocator::resolve_detailed_inner(
            EngineLocatorOptions {
                resource_dir: Some(root.path().into()),
                require_resource_manifest: true,
                mode: EngineResolutionMode::Development,
                ..Default::default()
            },
            None,
            None,
            "windows-x64",
        );
        assert!(bad.pack_error.is_some());
        assert!(!bad.paths.is_complete());
    }

    #[test]
    fn windows_release_external_managed_pack_is_verified_when_resources_absent() {
        let root = TestDirectory::new("release-external-managed");
        write_valid_pack(root.path());
        let options = EngineLocatorOptions {
            configured_dir: Some(root.path().into()),
            mode: EngineResolutionMode::Release,
            ..Default::default()
        };
        let good =
            EngineLocator::resolve_detailed_inner(options.clone(), None, None, "windows-x64");
        assert!(good.paths.is_complete());
        assert_eq!(
            good.status("brush").unwrap().integrity_status,
            IntegrityStatus::Valid
        );
        std::fs::write(root.path().join("brush/LICENSE"), b"corrupt").unwrap();
        let bad = EngineLocator::resolve_detailed_inner(options, None, None, "windows-x64");
        assert!(bad.pack_error.is_some());
        assert!(!bad.paths.is_complete());
    }

    #[test]
    fn windows_selected_prepared_directory_cannot_bypass_a_deleted_manifest() {
        let root = TestDirectory::new("deleted-prepared-manifest");
        for name in LOGICAL_ENGINES {
            std::fs::write(
                root.path().join(EngineLocator::executable_name(name)),
                b"loose executable",
            )
            .unwrap();
        }
        let options = EngineLocatorOptions {
            configured_dir: Some(root.path().into()),
            resource_dir: Some(root.path().into()),
            require_resource_manifest: true,
            mode: EngineResolutionMode::Development,
            ..Default::default()
        };
        for environment in [None, Some(root.path().to_path_buf())] {
            let result = EngineLocator::resolve_detailed_inner(
                options.clone(),
                environment,
                None,
                "windows-x64",
            );
            assert!(result.pack_error.is_some());
            assert!(!result.paths.is_complete());
        }
        // Relocated packs retain their managed marker even without a resource hint.
        std::fs::write(root.path().join("BUILD-INFO.json"), b"{}").unwrap();
        let result = EngineLocator::resolve_detailed_inner(
            EngineLocatorOptions {
                configured_dir: Some(root.path().into()),
                mode: EngineResolutionMode::Release,
                ..Default::default()
            },
            None,
            None,
            "windows-x64",
        );
        assert!(result.pack_error.is_some());
        assert!(!result.paths.is_complete());
    }

    #[test]
    fn windows_individual_overrides_precede_an_unused_directory_but_partial_ones_do_not() {
        let root = TestDirectory::new("individual-priority");
        let executables = LOGICAL_ENGINES
            .into_iter()
            .map(|name| {
                let file = root.path().join(EngineLocator::executable_name(name));
                std::fs::write(&file, b"explicit executable").unwrap();
                (name.to_string(), file)
            })
            .collect::<BTreeMap<_, _>>();
        let mut options = EngineLocatorOptions {
            configured_dir: Some(root.path().join("old-directory-no-longer-exists")),
            configured_executables: executables,
            mode: EngineResolutionMode::Development,
            ..Default::default()
        };
        let complete =
            EngineLocator::resolve_detailed_inner(options.clone(), None, None, "windows-x64");
        assert!(complete.paths.is_complete());
        assert!(complete.pack_error.is_none());
        options.configured_executables.remove("brush");
        let partial = EngineLocator::resolve_detailed_inner(options, None, None, "windows-x64");
        assert!(!partial.paths.is_complete());
        assert!(partial.pack_error.is_some());
    }

    fn release_options(resource_dir: &Path) -> EngineLocatorOptions {
        EngineLocatorOptions {
            resource_dir: Some(resource_dir.to_path_buf()),
            mode: EngineResolutionMode::Release,
            ..EngineLocatorOptions::default()
        }
    }

    fn write_mac_pack(root: &Path, arm64: bool) {
        write_valid_pack(root);
        let manifest_path = root.join("engine-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["platform"] = json!("macos-arm64");
        let mut header = [0_u8; 32];
        header[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        header[4..8].copy_from_slice(if arm64 { &[12, 0, 0, 1] } else { &[7, 0, 0, 1] });
        header[12] = 2; // MH_EXECUTE; this fixture validates the container, not execution.
        for (engine_name, engine) in manifest["engines"].as_object_mut().unwrap() {
            let mut files: Vec<serde_json::Value> = engine["files"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|file| {
                    engine["license_files"]
                        .as_array()
                        .unwrap()
                        .contains(&file["path"])
                })
                .cloned()
                .collect();
            for (logical, relative) in engine["executables"].as_object_mut().unwrap() {
                let executable = if logical == "brush" {
                    "brush-cli"
                } else {
                    logical.as_str()
                };
                let path = format!("{engine_name}/bin/{executable}");
                files.push(create_file(root, &path, &header));
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(
                        root.join(&path),
                        std::fs::Permissions::from_mode(0o755),
                    )
                    .unwrap();
                }
                *relative = json!(path);
            }
            engine["files"] = json!(files);
        }
        std::fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    }

    fn resolve_mac_pack(options: EngineLocatorOptions) -> EngineResolution {
        EngineLocator::resolve_detailed_inner(options, None, None, "macos-arm64")
    }

    /// Exercise the same release resolver as startup without launching engines
    /// or using an integrity cache. Both inputs are explicit so a different
    /// locally installed pack cannot silently replace the frozen build input.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    #[ignore = "requires METORIGIN_TEST_ENGINE_PACK and METORIGIN_TEST_ENGINE_MANIFEST_SHA256"]
    fn frozen_macos_engine_pack_resolves_without_execution() {
        let root = PathBuf::from(
            std::env::var_os("METORIGIN_TEST_ENGINE_PACK")
                .expect("set METORIGIN_TEST_ENGINE_PACK to the frozen engine pack"),
        );
        let expected_digest = std::env::var("METORIGIN_TEST_ENGINE_MANIFEST_SHA256")
            .expect("set METORIGIN_TEST_ENGINE_MANIFEST_SHA256 to the selected manifest digest");
        let (manifest, digest) = EnginePackManifest::load_with_digest(&root).unwrap();
        assert!(digest.eq_ignore_ascii_case(&expected_digest));
        let resolution = EngineLocator::resolve_detailed(release_options(&root));
        assert!(
            resolution.pack_error.is_none() && resolution.bundled_pack_is_valid(),
            "frozen pack rejected by runtime resolver: {:?}",
            resolution.pack_error
        );
        assert!(resolution.paths.is_complete());
        for engine in manifest.engines.values() {
            for (logical_name, relative) in &engine.executables {
                assert_eq!(
                    EngineLocator::path_for(&resolution.paths, logical_name),
                    Some(&std::fs::canonicalize(root.join(relative)).unwrap())
                );
            }
        }
        println!(
            "{}",
            serde_json::json!({
                "engine_pack": root,
                "manifest_sha256": digest,
                "declared_file_count": manifest.engines.values().map(|engine| engine.files.len()).sum::<usize>(),
                "mode": "release",
                "integrity_cache": false,
                "runtime_resolution": "passed",
                "engines_executed": false,
                "statuses": resolution.statuses,
            })
        );
    }

    #[test]
    fn macos_manifest_maps_brush_cli_and_verifies_native_headers() {
        let root = TestDirectory::new("macos-valid");
        write_mac_pack(root.path(), true);
        let resolution = resolve_mac_pack(release_options(root.path()));
        assert!(
            resolution.bundled_pack_is_valid(),
            "{:?}",
            resolution.pack_error
        );
        assert!(resolution
            .paths
            .brush
            .unwrap()
            .ends_with("brush/bin/brush-cli"));
    }

    #[test]
    fn macos_target_rejects_windows_pack_without_fallback() {
        let root = TestDirectory::new("macos-windows-pack");
        write_valid_pack(root.path());
        let resolution = resolve_mac_pack(release_options(root.path()));
        assert!(!resolution.paths.is_complete());
        assert!(resolution.pack_error.unwrap().contains("does not match"));
    }

    #[test]
    fn macos_pack_rejects_wrong_executable_architecture() {
        let root = TestDirectory::new("macos-wrong-architecture");
        write_mac_pack(root.path(), false);
        let resolution = resolve_mac_pack(release_options(root.path()));
        assert!(!resolution.paths.is_complete());
        assert!(resolution.pack_error.unwrap().contains("arm64 Mach-O"));
    }

    #[cfg(unix)]
    #[test]
    fn macos_execute_permission_is_checked_even_when_hashes_are_cached() {
        use std::os::unix::fs::PermissionsExt;
        let root = TestDirectory::new("macos-mode");
        write_mac_pack(root.path(), true);
        let mut options = release_options(root.path());
        options.integrity_cache = Some(EngineIntegrityCacheOptions {
            path: root.path().join("cache.json"),
            app_version: "0.1.0".into(),
        });
        assert!(resolve_mac_pack(options.clone()).bundled_pack_is_valid());
        std::fs::set_permissions(
            root.path().join("brush/bin/brush-cli"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let resolution = resolve_mac_pack(options);
        assert!(resolution
            .pack_error
            .unwrap()
            .contains("execute permission"));
    }

    #[test]
    fn macos_pack_rejects_case_only_duplicate_inventory_paths() {
        let root = TestDirectory::new("macos-duplicate-case");
        write_mac_pack(root.path(), true);
        let path = root.path().join("engine-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let files = manifest["engines"]["brush"]["files"]
            .as_array_mut()
            .unwrap();
        let mut duplicate = files.last().unwrap().clone();
        duplicate["path"] = json!("brush/bin/BRUSH-CLI");
        files.push(duplicate);
        std::fs::write(path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let resolution = resolve_mac_pack(release_options(root.path()));
        assert!(resolution.pack_error.unwrap().contains("duplicate"));
    }

    #[test]
    fn macos_pack_rejects_wrong_dylib_architecture_and_path_casing() {
        let root = TestDirectory::new("macos-dylib");
        write_mac_pack(root.path(), true);
        let path = root.path().join("engine-manifest.json");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut header = [0_u8; 32];
        header[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        header[4..8].copy_from_slice(&[7, 0, 0, 1]); // x86_64 MH_DYLIB
        header[12] = 6;
        let entry = create_file(root.path(), "colmap/lib/libtest.dylib", &header);
        manifest["engines"]["colmap"]["files"]
            .as_array_mut()
            .unwrap()
            .push(entry);
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(resolve_mac_pack(release_options(root.path()))
            .pack_error
            .unwrap()
            .contains("arm64 Mach-O dynamic library"));

        header[4..8].copy_from_slice(&[12, 0, 0, 1]);
        let mut entry = create_file(root.path(), "colmap/lib/libtest.dylib", &header);
        entry["path"] = json!("colmap/lib/LIBTEST.dylib");
        *manifest["engines"]["colmap"]["files"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap() = entry;
        std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(!resolve_mac_pack(release_options(root.path())).bundled_pack_is_valid());
    }

    #[cfg(unix)]
    #[test]
    fn macos_pack_rejects_executable_symlink_escape() {
        let root = TestDirectory::new("macos-link-escape");
        let outside = TestDirectory::new("macos-link-target");
        write_mac_pack(root.path(), true);
        let executable = root.path().join("brush/bin/brush-cli");
        let external = outside.path().join("brush-cli");
        std::fs::rename(&executable, &external).unwrap();
        std::os::unix::fs::symlink(external, executable).unwrap();
        let resolution = resolve_mac_pack(release_options(root.path()));
        assert!(!resolution.paths.is_complete());
        assert!(resolution.pack_error.unwrap().contains("escapes its root"));
    }

    #[cfg(unix)]
    #[test]
    fn development_can_resolve_brush_cli_name() {
        let root = TestDirectory::new("brush-cli");
        let path = root.path().join("brush/bin/brush-cli");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"test cli").unwrap();
        let resolution = resolve_mac_pack(EngineLocatorOptions {
            configured_dir: Some(root.path().to_path_buf()),
            mode: EngineResolutionMode::Development,
            ..EngineLocatorOptions::default()
        });
        assert_eq!(resolution.paths.brush, Some(path));
        let cli = root.path().join("brush-cli");
        std::fs::write(&cli, b"test cli").unwrap();
        let paths = std::env::join_paths([root.path()]).unwrap();
        assert_eq!(
            EngineLocator::find_on_path_value("brush", Some(&paths)),
            Some(cli)
        );
    }

    fn resolve_without_process_environment(
        options: EngineLocatorOptions,
        path: Option<&Path>,
    ) -> EngineResolution {
        EngineLocator::resolve_detailed_inner(
            options,
            None,
            path.map(|path| std::env::join_paths([path]).unwrap()),
            "windows-x64",
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
            "windows-x64",
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
