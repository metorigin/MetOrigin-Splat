use std::ffi::OsStr;
use std::process::Command;

/// Create a command intended to run as a background child process.
///
/// MetOrigin's release executable uses the Windows GUI subsystem and therefore
/// has no console for command-line engines to inherit. Without an explicit
/// creation flag, Windows allocates a new console window for each child
/// process. This helper keeps those engine and system-tool processes headless
/// while preserving their redirected stdout and stderr streams.
///
/// Deliberately do not use this helper for user-facing GUI programs such as
/// Explorer.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    configure_background_command(&mut command);
    command
}

/// Apply platform-specific settings for a background child process.
pub fn configure_background_command(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // WinBase.h: CREATE_NO_WINDOW. The flag prevents console-subsystem
        // children from allocating a visible conhost window. It does not
        // interfere with redirected standard streams.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_command_preserves_captured_output() {
        #[cfg(windows)]
        let output = background_command("cmd.exe")
            .args(["/D", "/C", "echo metorigin-background-command"])
            .output()
            .unwrap();

        #[cfg(not(windows))]
        let output = background_command("sh")
            .args(["-c", "printf metorigin-background-command"])
            .output()
            .unwrap();

        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "metorigin-background-command"
        );
    }

    #[cfg(windows)]
    #[test]
    fn background_command_has_no_windows_console() {
        let script = r#"
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MetOriginConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'
[Console]::Out.Write("captured")
if ([MetOriginConsoleProbe]::GetConsoleWindow() -eq [IntPtr]::Zero) { exit 0 }
exit 17
"#;
        let output = background_command("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ])
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "background child unexpectedly had a console; status={:?}, stderr={}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "captured");
    }
}
