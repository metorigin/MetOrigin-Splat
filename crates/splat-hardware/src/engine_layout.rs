//! Portable development-engine discovery from the shared repository layout.

use std::path::{Path, PathBuf};

const LAYOUT: &str = include_str!("../../../packaging/shared/engine-paths.json");

#[derive(Debug, thiserror::Error)]
pub enum EngineLayoutError {
    #[error("Cannot parse the shared engine layout: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid shared engine layout: {0}")]
    Invalid(&'static str),
}

struct MacosLayout {
    engines: PathBuf,
    development: PathBuf,
}

fn portable_relative_path(value: Option<&str>) -> Result<PathBuf, EngineLayoutError> {
    let value = value.ok_or(EngineLayoutError::Invalid("missing relative directory"))?;
    if value.is_empty()
        || value.trim() != value
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
        || value.split('/').any(|part| matches!(part, "" | "." | ".."))
        || Path::new(value).is_absolute()
    {
        return Err(EngineLayoutError::Invalid(
            "engine directories must be portable repository-relative paths",
        ));
    }
    Ok(PathBuf::from(value))
}

fn parse_macos_layout(json: &str) -> Result<MacosLayout, EngineLayoutError> {
    let config: serde_json::Value = serde_json::from_str(json)?;
    if config["schema_version"].as_u64() != Some(1) {
        return Err(EngineLayoutError::Invalid("unsupported schema version"));
    }
    let engines = portable_relative_path(config["engines_root"].as_str())?;
    let development = &config["platforms"]["macos-arm64"]["paths"]["developmentRoot"];
    if development["base"].as_str() != Some("engines") {
        return Err(EngineLayoutError::Invalid(
            "the macOS development root must use the engines base",
        ));
    }
    Ok(MacosLayout {
        development: engines.join(portable_relative_path(development["path"].as_str())?),
        engines,
    })
}

/// Select a development directory without modifying environment or settings.
/// Every platform-specific candidate precedes any legacy flat directory. An
/// existing selected directory stays selected even when its tools are missing,
/// so a damaged development set cannot silently turn into a distribution pack.
pub fn macos_development_engine_dir(
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, EngineLayoutError> {
    let layout = parse_macos_layout(LAYOUT)?;
    Ok(select_development_directory(&layout, roots))
}

fn select_development_directory(layout: &MacosLayout, roots: &[PathBuf]) -> Option<PathBuf> {
    if let Some(candidate) = roots
        .iter()
        .map(|root| root.join(&layout.development))
        .find(|candidate| candidate.is_dir())
    {
        return Some(candidate);
    }
    roots
        .iter()
        .map(|root| root.join(&layout.engines))
        .find(|candidate| {
            ["ffmpeg", "colmap", "brush"]
                .iter()
                .any(|name| candidate.join(name).is_dir())
        })
}

/// Preserve the debug executable's own checkout before inspecting launch roots
/// from other checkouts. A legacy flat set at that anchor retains its priority.
pub fn macos_development_engine_dir_with_anchor(
    checkout_anchor: &Path,
    fallback_roots: &[PathBuf],
) -> Result<Option<PathBuf>, EngineLayoutError> {
    let layout = parse_macos_layout(LAYOUT)?;
    let anchor = checkout_anchor.to_path_buf();
    Ok(
        select_development_directory(&layout, std::slice::from_ref(&anchor))
            .or_else(|| select_development_directory(&layout, fallback_roots)),
    )
}

/// The configured path for one checkout, without inspecting the filesystem.
pub fn macos_development_root(repository_root: &Path) -> Result<PathBuf, EngineLayoutError> {
    Ok(repository_root.join(parse_macos_layout(LAYOUT)?.development))
}

fn windows_engine_path(key: &str) -> Result<PathBuf, EngineLayoutError> {
    let config: serde_json::Value = serde_json::from_str(LAYOUT)?;
    if config["schema_version"].as_u64() != Some(1) {
        return Err(EngineLayoutError::Invalid("unsupported schema version"));
    }
    let entry = &config["platforms"]["windows-x64"]["paths"][key];
    if entry["base"].as_str() != Some("engines") {
        return Err(EngineLayoutError::Invalid(
            "Windows runtime paths must use the engines base",
        ));
    }
    Ok(portable_relative_path(config["engines_root"].as_str())?
        .join(portable_relative_path(entry["path"].as_str())?))
}

/// Repository-managed packs always require their manifest, even when damaged.
pub fn is_windows_managed_engine_dir(root: &Path) -> bool {
    ["distributionRoot", "alignmentRoot"]
        .into_iter()
        .any(|key| windows_engine_path(key).is_ok_and(|path| root.ends_with(path.join("engines"))))
        || root.ends_with("target/distribution/windows-x64/engines")
        || root.ends_with("target/distribution/windows-x64-alignment/engines")
}

/// Plain Windows development selects the stable prepared pack. The explicit
/// candidate-launcher hint remains a separate higher-priority caller input.
pub fn windows_development_engine_dir(
    roots: &[PathBuf],
) -> Result<Option<PathBuf>, EngineLayoutError> {
    let distribution = windows_engine_path("distributionRoot")?.join("engines");
    if let Some(selected) = roots
        .iter()
        .map(|root| root.join(&distribution))
        .find(|path| path.is_dir())
    {
        return Ok(Some(selected));
    }
    let development = windows_engine_path("developmentRoot")?;
    for suffix in [development, PathBuf::from(".engines")] {
        if let Some(selected) = roots.iter().map(|root| root.join(&suffix)).find(|path| {
            ["ffmpeg", "colmap", "brush"]
                .iter()
                .any(|name| path.join(name).is_dir())
        }) {
            return Ok(Some(selected));
        }
    }
    Ok(None)
}

/// Candidate checkout roots for common Cargo, Tauri and direct-debug launches.
/// No compile-machine checkout path is embedded in the executable.
pub fn macos_development_search_roots(
    current_directory: Option<&Path>,
    executable: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(directory) = current_directory {
        roots.extend(directory.ancestors().take(4).map(Path::to_path_buf));
    }
    if let Some(executable) = executable {
        roots.extend(
            executable
                .ancestors()
                .skip(1)
                .take(6)
                .map(Path::to_path_buf),
        );
    }
    roots
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_SERIAL: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let serial = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "engine-layout-中文 空格-{}-{serial}-{}",
                std::process::id(),
                FIXTURE_SERIAL.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn create(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn shared_layout_prefers_platform_development_across_launch_roots() {
        let fixture = Fixture::new();
        let checkout = fixture.create("checkout");
        let launch = fixture.create("launch");
        fixture.create("launch/.engines/ffmpeg");
        let layout = parse_macos_layout(LAYOUT).unwrap();
        let development = checkout.join(layout.development);
        fs::create_dir_all(&development).unwrap();
        assert_eq!(
            macos_development_engine_dir(&[launch, checkout]).unwrap(),
            Some(development)
        );
    }

    #[test]
    fn missing_platform_directory_can_use_flat_compatibility() {
        let fixture = Fixture::new();
        fixture.create(".engines/brush/bin");
        assert_eq!(
            macos_development_engine_dir(std::slice::from_ref(&fixture.0)).unwrap(),
            Some(fixture.0.join(".engines"))
        );
    }

    #[test]
    fn checkout_anchor_keeps_its_legacy_set_ahead_of_other_checkouts() {
        let fixture = Fixture::new();
        let anchor = fixture.create("own checkout");
        let legacy = fixture.create("own checkout/.engines/colmap");
        let foreign = fixture.create("other checkout");
        let foreign_development = macos_development_root(&foreign).unwrap();
        fs::create_dir_all(&foreign_development).unwrap();
        let roots = std::slice::from_ref(&foreign);
        assert_eq!(
            macos_development_engine_dir_with_anchor(&anchor, roots).unwrap(),
            Some(anchor.join(".engines"))
        );
        fs::remove_dir_all(legacy).unwrap();
        assert_eq!(
            macos_development_engine_dir_with_anchor(&anchor, roots).unwrap(),
            Some(foreign_development)
        );
    }

    #[test]
    fn distribution_only_container_is_never_a_development_fallback() {
        let fixture = Fixture::new();
        fixture.create(".engines/macos-arm64/distribution/engines/brush/bin");
        assert!(
            macos_development_engine_dir(std::slice::from_ref(&fixture.0))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn nested_cwd_and_debug_executable_find_the_checkout_without_build_machine_paths() {
        let fixture = Fixture::new();
        let layout = parse_macos_layout(LAYOUT).unwrap();
        let development = fixture.0.join(layout.development);
        fs::create_dir_all(&development).unwrap();
        let cwd = fixture.create("apps/desktop/src-tauri");
        let executable = fixture
            .0
            .join("target/aarch64-apple-darwin/debug/splat-desktop");
        let roots = macos_development_search_roots(Some(&cwd), Some(&executable));
        assert_eq!(
            macos_development_engine_dir(&roots).unwrap(),
            Some(development)
        );
    }

    #[test]
    fn invalid_or_escaping_shared_layout_is_rejected() {
        for invalid in [
            "../outside",
            "/outside",
            "C:/outside",
            "bad\\path",
            ".",
            "bad\npath",
        ] {
            let mut config: serde_json::Value = serde_json::from_str(LAYOUT).unwrap();
            config["engines_root"] = invalid.into();
            assert!(parse_macos_layout(&config.to_string()).is_err());
            config = serde_json::from_str(LAYOUT).unwrap();
            config["platforms"]["macos-arm64"]["paths"]["developmentRoot"]["path"] = invalid.into();
            assert!(parse_macos_layout(&config.to_string()).is_err());
        }
        let mut config: serde_json::Value = serde_json::from_str(LAYOUT).unwrap();
        config["schema_version"] = 2.into();
        assert!(parse_macos_layout(&config.to_string()).is_err());
        config["schema_version"] = 1.into();
        config["platforms"]["macos-arm64"]["paths"]["developmentRoot"]["base"] = "cache".into();
        assert!(parse_macos_layout(&config.to_string()).is_err());
    }

    #[test]
    fn windows_shared_pack_precedes_flat_and_empty_containers_are_ignored() {
        let fixture = Fixture::new();
        let checkout = fixture.create("checkout");
        let launch = fixture.create("launch");
        fs::create_dir_all(launch.join(".engines/brush")).unwrap();
        let prepared = checkout
            .join(windows_engine_path("distributionRoot").unwrap())
            .join("engines");
        fs::create_dir_all(&prepared).unwrap();
        assert_eq!(
            windows_development_engine_dir(&[launch.clone(), checkout.clone()]).unwrap(),
            Some(prepared.clone())
        );
        assert!(is_windows_managed_engine_dir(&prepared));
        let candidate = checkout
            .join(windows_engine_path("alignmentRoot").unwrap())
            .join("engines");
        assert!(is_windows_managed_engine_dir(&candidate));
        fs::remove_dir_all(&prepared).unwrap();
        assert_eq!(
            windows_development_engine_dir(&[launch.clone(), checkout.clone()]).unwrap(),
            Some(launch.join(".engines"))
        );
        fs::remove_dir_all(launch.join(".engines/brush")).unwrap();
        assert_eq!(
            windows_development_engine_dir(&[launch, checkout]).unwrap(),
            None
        );
    }
}
