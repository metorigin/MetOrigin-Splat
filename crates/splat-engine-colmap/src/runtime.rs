use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use splat_process::{background_command, CommandSpec};

/// Build a COLMAP command spec with the portable Windows runtime environment.
///
/// Official COLMAP Windows archives launch `bin/colmap.exe` through a batch
/// file that adds the package's `bin` and `lib` directories to `PATH` and
/// points Qt at the package's `plugins` directory. The desktop application
/// launches the executable directly, so every command must reproduce that
/// environment explicitly.
pub(crate) fn command_spec(
    colmap_path: &Path,
    args: Vec<impl Into<OsString>>,
    log_path: &Path,
) -> CommandSpec {
    let mut spec = CommandSpec::new(colmap_path, args, log_path);
    for (key, value) in runtime_variables(colmap_path) {
        spec = spec.with_env(key, value);
    }
    spec
}

/// Build a synchronous COLMAP command with the same environment as pipeline
/// `CommandSpec`s. Detection, validation and model analysis use this path.
pub(crate) fn command(colmap_path: &Path) -> std::process::Command {
    let mut command = background_command(colmap_path);
    for (key, value) in runtime_variables(colmap_path) {
        command.env(key, value);
    }
    command
}

fn runtime_variables(colmap_path: &Path) -> Vec<(OsString, OsString)> {
    let Some(bin_dir) = executable_directory(colmap_path) else {
        // A bare `colmap` command is expected to be a system installation
        // whose launcher/runtime is already configured through the process
        // environment.
        return Vec::new();
    };
    let package_root = if bin_dir
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("bin"))
    {
        bin_dir.parent().unwrap_or(&bin_dir).to_path_buf()
    } else {
        bin_dir.clone()
    };

    let mut search_paths = vec![bin_dir, package_root.join("lib")];
    if let Some(existing) = std::env::var_os("PATH") {
        search_paths.extend(std::env::split_paths(&existing));
    }
    deduplicate_paths(&mut search_paths);

    let mut variables = Vec::with_capacity(2);
    if let Ok(path) = std::env::join_paths(search_paths) {
        variables.push((OsString::from("PATH"), path));
    }
    variables.push((
        OsString::from("QT_PLUGIN_PATH"),
        package_root.join("plugins").into_os_string(),
    ));
    variables
}

fn executable_directory(colmap_path: &Path) -> Option<PathBuf> {
    colmap_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| seen.insert(normalized_path_key(path)));
}

fn normalized_path_key(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        OsString::from(path.as_os_str().to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn packaged_command_spec_injects_colmap_runtime() {
        let executable = Path::new("engine-pack")
            .join("colmap")
            .join("COLMAP-4.1.0")
            .join("bin")
            .join(if cfg!(windows) {
                "colmap.exe"
            } else {
                "colmap"
            });
        let spec = command_spec(&executable, vec!["-h"], Path::new("colmap.log"));

        let path = spec.env.get(OsStr::new("PATH")).unwrap();
        let entries = std::env::split_paths(path).collect::<Vec<_>>();
        assert_eq!(entries[0], executable.parent().unwrap());
        assert_eq!(
            entries[1],
            executable.parent().unwrap().parent().unwrap().join("lib")
        );
        assert_eq!(
            spec.env.get(OsStr::new("QT_PLUGIN_PATH")),
            Some(
                &executable
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("plugins")
                    .into_os_string()
            )
        );
    }

    #[test]
    fn bare_system_command_keeps_inherited_runtime_untouched() {
        let spec = command_spec(Path::new("colmap"), vec!["-h"], Path::new("colmap.log"));
        assert!(!spec.env.contains_key(OsStr::new("PATH")));
        assert!(!spec.env.contains_key(OsStr::new("QT_PLUGIN_PATH")));
    }

    #[test]
    fn synchronous_detection_command_uses_the_same_runtime() {
        let executable = Path::new("engine-pack")
            .join("colmap")
            .join("COLMAP-4.1.0")
            .join("bin")
            .join(if cfg!(windows) {
                "colmap.exe"
            } else {
                "colmap"
            });
        let command = command(&executable);
        let environment = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<std::collections::HashMap<_, _>>();

        assert!(environment.contains_key(OsStr::new("PATH")));
        assert_eq!(
            environment.get(OsStr::new("QT_PLUGIN_PATH")),
            Some(
                &executable
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join("plugins")
                    .as_os_str()
            )
        );
    }
}
