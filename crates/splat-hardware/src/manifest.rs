use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MANIFEST_FILE_NAME: &str = "engine-manifest.json";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SUPPORTED_PLATFORM: &str = "windows-x64";
const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

/// Reproducible description of every file shipped in the Windows engine pack.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnginePackManifest {
    pub schema_version: u32,
    pub pack_version: String,
    pub platform: String,
    pub engines: BTreeMap<String, EnginePackEngine>,
}

/// One independently licensed engine contained in an engine pack.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnginePackEngine {
    pub version: String,
    pub executables: BTreeMap<String, String>,
    pub source_url: String,
    pub source_sha256: String,
    pub files: Vec<EnginePackFile>,
    pub license_files: Vec<String>,
}

/// A file path is relative to the directory containing the manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EnginePackFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

/// Where an executable selected by [`crate::EngineLocator`] came from.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnginePackSource {
    Resource,
    Environment,
    ConfiguredOrPath,
    Missing,
}

/// Whether a selected executable is covered by a verified manifest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrityStatus {
    Valid,
    Invalid,
    NotApplicable,
}

/// Detailed status attached to each resolved logical executable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnginePackStatus {
    pub source: EnginePackSource,
    pub pack_version: Option<String>,
    pub integrity_status: IntegrityStatus,
    pub expected_version: Option<String>,
    pub actual_version: Option<String>,
    pub diagnostic: Option<String>,
}

impl EnginePackStatus {
    pub(crate) fn external(source: EnginePackSource) -> Self {
        Self {
            source,
            pack_version: None,
            integrity_status: IntegrityStatus::NotApplicable,
            expected_version: None,
            actual_version: None,
            diagnostic: None,
        }
    }

    pub(crate) fn missing(diagnostic: impl Into<String>) -> Self {
        Self {
            source: EnginePackSource::Missing,
            pack_version: None,
            integrity_status: IntegrityStatus::NotApplicable,
            expected_version: None,
            actual_version: None,
            diagnostic: Some(diagnostic.into()),
        }
    }
}

#[derive(Debug, Error)]
pub enum EnginePackError {
    #[error("engine pack directory does not exist: {0}")]
    MissingRoot(PathBuf),
    #[error("engine pack manifest is missing: {0}")]
    MissingManifest(PathBuf),
    #[error("could not read engine pack manifest: {0}")]
    ManifestRead(String),
    #[error("engine pack manifest is too large ({0} bytes)")]
    ManifestTooLarge(u64),
    #[error("engine pack manifest is not valid JSON: {0}")]
    ManifestJson(String),
    #[error("unsupported engine pack schema version {0}")]
    UnsupportedSchema(u32),
    #[error("unsupported engine pack platform '{0}'")]
    UnsupportedPlatform(String),
    #[error("invalid engine pack manifest: {0}")]
    InvalidManifest(String),
    #[error("unsafe engine pack path '{0}'")]
    UnsafePath(String),
    #[error("duplicate engine pack path '{0}'")]
    DuplicatePath(String),
    #[error("engine pack file is missing: {0}")]
    MissingFile(String),
    #[error("engine pack path escapes its root: {0}")]
    PathEscape(String),
    #[error("engine pack file size mismatch for '{path}': expected {expected}, found {actual}")]
    SizeMismatch {
        path: String,
        expected: u64,
        actual: u64,
    },
    #[error("engine pack SHA-256 mismatch for '{0}'")]
    HashMismatch(String),
}

#[derive(Debug)]
pub(crate) struct VerifiedEnginePack {
    pub executables: BTreeMap<String, PathBuf>,
    pub statuses: BTreeMap<String, EnginePackStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct IntegrityCache {
    schema_version: u32,
    app_version: String,
    pack_version: String,
    platform: String,
    manifest_sha256: String,
    files: BTreeMap<String, CachedFileFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct CachedFileFingerprint {
    size_bytes: u64,
    modified_unix_nanos: u64,
}

struct CheckedFile<'a> {
    declaration: &'a EnginePackFile,
    canonical_path: PathBuf,
    fingerprint: CachedFileFingerprint,
}

impl EnginePackManifest {
    /// Read and strictly deserialize an engine manifest without trusting any
    /// paths from it. Callers normally use the locator, which also verifies
    /// every declared file before returning executable paths.
    pub fn load(root: &Path) -> Result<Self, EnginePackError> {
        Self::load_with_digest(root).map(|(manifest, _)| manifest)
    }

    pub(crate) fn load_with_digest(root: &Path) -> Result<(Self, String), EnginePackError> {
        if !root.is_dir() {
            return Err(EnginePackError::MissingRoot(root.to_path_buf()));
        }
        let path = root.join(MANIFEST_FILE_NAME);
        let metadata =
            std::fs::metadata(&path).map_err(|_| EnginePackError::MissingManifest(path.clone()))?;
        if !metadata.is_file() {
            return Err(EnginePackError::MissingManifest(path));
        }
        if metadata.len() > MAX_MANIFEST_BYTES {
            return Err(EnginePackError::ManifestTooLarge(metadata.len()));
        }
        let bytes = std::fs::read(&path)
            .map_err(|error| EnginePackError::ManifestRead(error.to_string()))?;
        let manifest: Self = serde_json::from_slice(&bytes)
            .map_err(|error| EnginePackError::ManifestJson(error.to_string()))?;
        manifest.validate_shape()?;
        Ok((manifest, sha256_bytes(&bytes)))
    }

    fn validate_shape(&self) -> Result<(), EnginePackError> {
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(EnginePackError::UnsupportedSchema(self.schema_version));
        }
        if self.platform != SUPPORTED_PLATFORM {
            return Err(EnginePackError::UnsupportedPlatform(self.platform.clone()));
        }
        if self.pack_version.trim().is_empty() {
            return Err(EnginePackError::InvalidManifest(
                "pack_version must not be empty".into(),
            ));
        }
        let expected_engines = ["brush", "colmap", "ffmpeg"]
            .into_iter()
            .collect::<BTreeSet<_>>();
        let actual_engines = self
            .engines
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if actual_engines != expected_engines {
            return Err(EnginePackError::InvalidManifest(
                "schema 1 requires exactly the ffmpeg, colmap, and brush engines".into(),
            ));
        }
        for (engine_name, engine) in &self.engines {
            if engine.version.trim().is_empty() {
                return Err(EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' has an empty version"
                )));
            }
            if engine.source_url.trim().is_empty() {
                return Err(EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' has an empty source_url"
                )));
            }
            validate_sha256(&engine.source_sha256).map_err(|reason| {
                EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' source_sha256 {reason}"
                ))
            })?;
            if engine.files.is_empty() {
                return Err(EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' does not declare files"
                )));
            }
            if engine.license_files.is_empty() {
                return Err(EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' does not declare license files"
                )));
            }
            for file in &engine.files {
                normalize_relative_path(&file.path)?;
            }
            for executable in engine.executables.values() {
                normalize_relative_path(executable)?;
            }
            for license in &engine.license_files {
                normalize_relative_path(license)?;
            }
            let expected_executables: &[&str] = match engine_name.as_str() {
                "ffmpeg" => &["ffmpeg", "ffprobe"],
                "colmap" => &["colmap"],
                "brush" => &["brush"],
                _ => unreachable!("engine names were checked above"),
            };
            if engine.executables.len() != expected_executables.len()
                || !expected_executables
                    .iter()
                    .all(|name| engine.executables.contains_key(*name))
            {
                return Err(EnginePackError::InvalidManifest(format!(
                    "engine '{engine_name}' has an invalid executables map"
                )));
            }
        }
        for executable in ["ffmpeg", "ffprobe", "colmap", "brush"] {
            let count = self
                .engines
                .values()
                .filter(|engine| engine.executables.contains_key(executable))
                .count();
            if count != 1 {
                return Err(EnginePackError::InvalidManifest(format!(
                    "logical executable '{executable}' must be declared exactly once"
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn verify(
        &self,
        root: &Path,
        manifest_sha256: &str,
        cache: Option<(&Path, &str)>,
    ) -> Result<VerifiedEnginePack, EnginePackError> {
        let canonical_root = std::fs::canonicalize(root)
            .map_err(|_| EnginePackError::MissingRoot(root.to_path_buf()))?;
        let mut checked_files = Vec::new();
        let mut declared_paths = BTreeMap::new();

        for (engine_name, engine) in &self.engines {
            for file in &engine.files {
                validate_sha256(&file.sha256).map_err(|reason| {
                    EnginePackError::InvalidManifest(format!(
                        "file '{}' SHA-256 {reason}",
                        file.path
                    ))
                })?;
                let normalized = normalize_relative_path(&file.path)?;
                if declared_paths
                    .insert(normalized.clone(), engine_name.as_str())
                    .is_some()
                {
                    return Err(EnginePackError::DuplicatePath(normalized));
                }
                let canonical_path = canonical_pack_file(&canonical_root, &normalized)?;
                let metadata = std::fs::metadata(&canonical_path)
                    .map_err(|_| EnginePackError::MissingFile(normalized.clone()))?;
                if !metadata.is_file() {
                    return Err(EnginePackError::MissingFile(normalized));
                }
                if metadata.len() != file.size_bytes {
                    return Err(EnginePackError::SizeMismatch {
                        path: file.path.clone(),
                        expected: file.size_bytes,
                        actual: metadata.len(),
                    });
                }
                checked_files.push(CheckedFile {
                    declaration: file,
                    canonical_path,
                    fingerprint: CachedFileFingerprint {
                        size_bytes: metadata.len(),
                        modified_unix_nanos: modified_unix_nanos(&metadata),
                    },
                });
            }
        }

        let fingerprint_map = checked_files
            .iter()
            .map(|file| {
                (
                    normalize_relative_path(&file.declaration.path)
                        .expect("path was validated above"),
                    file.fingerprint.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let cache_is_valid = cache
            .and_then(|(path, app_version)| {
                std::fs::read(path).ok().map(|bytes| (bytes, app_version))
            })
            .and_then(|(bytes, app_version)| {
                serde_json::from_slice::<IntegrityCache>(&bytes)
                    .ok()
                    .map(|cached| (cached, app_version))
            })
            .is_some_and(|(cached, app_version)| {
                cached.schema_version == MANIFEST_SCHEMA_VERSION
                    && cached.app_version == app_version
                    && cached.pack_version == self.pack_version
                    && cached.platform == self.platform
                    && cached.manifest_sha256.eq_ignore_ascii_case(manifest_sha256)
                    && cached.files == fingerprint_map
            });

        if !cache_is_valid {
            for file in &checked_files {
                let actual = sha256_file(&file.canonical_path)?;
                if !actual.eq_ignore_ascii_case(&file.declaration.sha256) {
                    return Err(EnginePackError::HashMismatch(file.declaration.path.clone()));
                }
            }
            if let Some((path, app_version)) = cache {
                let cached = IntegrityCache {
                    schema_version: MANIFEST_SCHEMA_VERSION,
                    app_version: app_version.to_string(),
                    pack_version: self.pack_version.clone(),
                    platform: self.platform.clone(),
                    manifest_sha256: manifest_sha256.to_ascii_uppercase(),
                    files: fingerprint_map,
                };
                write_cache_best_effort(path, &cached);
            }
        }

        let checked_paths = checked_files
            .iter()
            .map(|file| {
                (
                    normalize_relative_path(&file.declaration.path)
                        .expect("path was validated above"),
                    file.canonical_path.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut executables = BTreeMap::new();
        let mut statuses = BTreeMap::new();
        let mut executable_names = BTreeSet::new();

        for (engine_name, engine) in &self.engines {
            let engine_file_paths = engine
                .files
                .iter()
                .map(|file| {
                    normalize_relative_path(&file.path).expect("file path was validated above")
                })
                .collect::<BTreeSet<_>>();
            for license in &engine.license_files {
                let normalized = normalize_relative_path(license)?;
                if !engine_file_paths.contains(&normalized) {
                    return Err(EnginePackError::InvalidManifest(format!(
                        "license file '{license}' for '{engine_name}' is not listed in files"
                    )));
                }
            }
            for (logical_name, relative_path) in &engine.executables {
                if !executable_names.insert(logical_name.clone()) {
                    return Err(EnginePackError::InvalidManifest(format!(
                        "logical executable '{logical_name}' is declared more than once"
                    )));
                }
                let normalized = normalize_relative_path(relative_path)?;
                if !engine_file_paths.contains(&normalized) {
                    return Err(EnginePackError::InvalidManifest(format!(
                        "executable '{logical_name}' path '{relative_path}' is not listed in '{engine_name}' files"
                    )));
                }
                let path = checked_paths.get(&normalized).ok_or_else(|| {
                    EnginePackError::InvalidManifest(format!(
                        "executable '{logical_name}' path '{relative_path}' is not listed in files"
                    ))
                })?;
                executables.insert(logical_name.clone(), path.clone());
                statuses.insert(
                    logical_name.clone(),
                    EnginePackStatus {
                        source: EnginePackSource::Resource,
                        pack_version: Some(self.pack_version.clone()),
                        integrity_status: IntegrityStatus::Valid,
                        expected_version: Some(engine.version.clone()),
                        actual_version: None,
                        diagnostic: None,
                    },
                );
            }
        }

        Ok(VerifiedEnginePack {
            executables,
            statuses,
        })
    }
}

/// Match a pinned version against the version token reported by an engine.
/// Suffixes such as `8.1.2-essentials_build` are accepted, while `8.1.20`
/// does not accidentally match `8.1.2`.
pub fn version_matches(expected: &str, actual: &str) -> bool {
    let expected = expected.trim().trim_start_matches(['v', 'V']);
    !expected.is_empty()
        && actual
            .split(|character: char| !(character.is_ascii_alphanumeric() || character == '.'))
            .map(|token| token.trim_start_matches(['v', 'V']))
            .any(|token| token == expected)
}

fn normalize_relative_path(path: &str) -> Result<String, EnginePackError> {
    if path.is_empty()
        || path.contains('\0')
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.contains(':')
    {
        return Err(EnginePackError::UnsafePath(path.into()));
    }
    let normalized = path.replace('\\', "/");
    let mut segments = Vec::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(EnginePackError::UnsafePath(path.into()));
        }
        segments.push(segment);
    }
    if segments.is_empty() {
        return Err(EnginePackError::UnsafePath(path.into()));
    }
    Ok(segments.join("/"))
}

fn canonical_pack_file(root: &Path, normalized: &str) -> Result<PathBuf, EnginePackError> {
    let mut candidate = root.to_path_buf();
    for segment in normalized.split('/') {
        candidate.push(segment);
    }
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|_| EnginePackError::MissingFile(normalized.into()))?;
    if !canonical.starts_with(root) {
        return Err(EnginePackError::PathEscape(normalized.into()));
    }
    Ok(canonical)
}

fn validate_sha256(value: &str) -> Result<(), &'static str> {
    if value.len() != 64 {
        return Err("must contain exactly 64 hexadecimal characters");
    }
    if !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("contains a non-hexadecimal character");
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, EnginePackError> {
    let file =
        File::open(path).map_err(|error| EnginePackError::ManifestRead(error.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    // Keep the 1 MiB streaming buffer off the thread stack. Windows GUI
    // executables reserve a 1 MiB stack by default, so an equally large local
    // array overflows as soon as first-launch engine integrity verification
    // starts.
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| EnginePackError::ManifestRead(error.to_string()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:X}", digest.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:X}", digest.finalize())
}

fn modified_unix_nanos(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn write_cache_best_effort(path: &Path, cache: &IntegrityCache) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(bytes) = serde_json::to_vec_pretty(cache) else {
        return;
    };
    let _ = std::fs::write(path, bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matching_observes_token_boundaries() {
        assert!(version_matches(
            "8.1.2",
            "ffmpeg version 8.1.2-essentials_build"
        ));
        assert!(version_matches(
            "4.1.0",
            "COLMAP 4.1.0 -- Structure-from-Motion"
        ));
        assert!(version_matches("0.3.0", "brush-app v0.3.0"));
        assert!(!version_matches("8.1.2", "ffmpeg version 8.1.20"));
        assert!(!version_matches("0.3.0", "brush-app 0.2.9"));
    }

    #[test]
    fn rejects_windows_and_portable_path_escape_forms() {
        for path in [
            "../ffmpeg.exe",
            "ffmpeg/../ffmpeg.exe",
            "C:/ffmpeg.exe",
            "/ffmpeg.exe",
            "\\\\server/share/ffmpeg.exe",
            "ffmpeg.exe:stream",
        ] {
            assert!(matches!(
                normalize_relative_path(path),
                Err(EnginePackError::UnsafePath(_))
            ));
        }
    }

    #[test]
    fn hashes_large_file_on_a_small_thread_stack() {
        let bytes = vec![0xA5; 2 * 1024 * 1024 + 17];
        let expected = sha256_bytes(&bytes);
        let path = std::env::temp_dir().join(format!(
            "metorigin-sha256-small-stack-{}-{}.bin",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, bytes).unwrap();

        let worker_path = path.clone();
        let actual = std::thread::Builder::new()
            .name("sha256-small-stack".into())
            .stack_size(256 * 1024)
            .spawn(move || sha256_file(&worker_path).unwrap())
            .unwrap()
            .join()
            .unwrap();

        let _ = std::fs::remove_file(path);
        assert_eq!(actual, expected);
    }
}
