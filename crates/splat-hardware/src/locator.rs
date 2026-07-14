use std::path::{Path, PathBuf};

use splat_domain::hardware::EnginePaths;

/// Resolves engine executables from a developer pack, application resources,
/// and finally the current process PATH.
pub struct EngineLocator;

impl EngineLocator {
    pub fn resolve(resource_dir: Option<&Path>) -> EnginePaths {
        let configured = std::env::var_os("METORIGIN_ENGINE_DIR").map(PathBuf::from);
        EnginePaths {
            ffmpeg: Self::resolve_one("ffmpeg", configured.as_deref(), resource_dir),
            ffprobe: Self::resolve_one("ffprobe", configured.as_deref(), resource_dir),
            colmap: Self::resolve_one("colmap", configured.as_deref(), resource_dir),
            brush: Self::resolve_one("brush", configured.as_deref(), resource_dir),
        }
    }

    fn resolve_one(
        name: &str,
        configured: Option<&Path>,
        resource_dir: Option<&Path>,
    ) -> Option<PathBuf> {
        for root in [configured, resource_dir].into_iter().flatten() {
            for candidate in Self::candidates(root, name) {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        Self::find_on_path(name)
    }

    fn candidates(root: &Path, name: &str) -> Vec<PathBuf> {
        let executable = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
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
        candidates
    }

    fn find_on_path(name: &str) -> Option<PathBuf> {
        let executable = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        std::env::var_os("PATH").and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|directory| directory.join(&executable))
                .find(|candidate| candidate.is_file())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_cover_supported_layouts() {
        let candidates = EngineLocator::candidates(Path::new("engines"), "ffmpeg");
        assert_eq!(candidates.len(), 4);
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
}
