use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::execution::ColmapExecutionSettings;
use splat_domain::runtime::RuntimePlatform;
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

pub(crate) fn command_spec_with_settings(
    colmap_path: &Path,
    args: Vec<impl Into<OsString>>,
    log_path: &Path,
    settings: Option<&ColmapExecutionSettings>,
) -> CommandSpec {
    if settings.is_some_and(|settings| settings.platform() == RuntimePlatform::Macos) {
        CommandSpec::new(colmap_path, args, log_path)
    } else {
        command_spec(colmap_path, args, log_path)
    }
}

/// Build a synchronous COLMAP command with the same environment as pipeline
/// `CommandSpec`s. Detection, validation and model analysis use this path.
pub(crate) fn command(colmap_path: &Path) -> std::process::Command {
    command_with_settings(colmap_path, None)
}

pub(crate) fn command_with_settings(
    colmap_path: &Path,
    settings: Option<&ColmapExecutionSettings>,
) -> std::process::Command {
    let mut command = background_command(colmap_path);
    for (key, value) in execution_variables(colmap_path, settings) {
        command.env(key, value);
    }
    command
}

fn execution_variables(
    colmap_path: &Path,
    settings: Option<&ColmapExecutionSettings>,
) -> Vec<(OsString, OsString)> {
    if settings.is_some_and(|settings| settings.platform() == RuntimePlatform::Macos) {
        // Native CLI-only Mach-O dependencies must resolve through their rpaths.
        // No Qt directory or dylib directory is injected into PATH on this path.
        Vec::new()
    } else {
        runtime_variables(colmap_path)
    }
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
    fn native_synchronous_detection_does_not_inject_windows_or_dyld_environment() {
        let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(
            "../../../schemas/examples/execution-profile/macos.valid.json"
        ))
        .unwrap();
        let settings = ColmapExecutionSettings::from_execution_profile(&profile).unwrap();
        let command =
            command_with_settings(Path::new("engine-pack/colmap/bin/colmap"), Some(&settings));
        assert_eq!(command.get_envs().count(), 0);
    }

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
