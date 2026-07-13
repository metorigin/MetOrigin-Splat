use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Specification for launching an external process.
///
/// All fields use OS-native types (`OsString`) to avoid encoding issues
/// with CJK characters and special characters in paths.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandSpec {
    /// Path to the executable program
    pub program: PathBuf,
    /// Arguments passed to the program (each arg is a separate OS string)
    pub args: Vec<std::ffi::OsString>,
    /// Working directory for the process
    pub cwd: Option<PathBuf>,
    /// Environment variables (will be merged with the current environment)
    pub env: HashMap<std::ffi::OsString, std::ffi::OsString>,
    /// Path to the log file for capturing stdout/stderr
    pub log_file: PathBuf,
    /// Optional timeout duration
    pub timeout: Option<Duration>,
}

impl CommandSpec {
    /// Create a new command specification.
    pub fn new(
        program: impl Into<PathBuf>,
        args: Vec<impl Into<std::ffi::OsString>>,
        log_file: impl Into<PathBuf>,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            cwd: None,
            env: HashMap::new(),
            log_file: log_file.into(),
            timeout: None,
        }
    }

    /// Set the working directory.
    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// Add an environment variable.
    pub fn with_env(
        mut self,
        key: impl Into<std::ffi::OsString>,
        value: impl Into<std::ffi::OsString>,
    ) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    /// Set a timeout for the process.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_command_spec_creation() {
        let spec = CommandSpec::new(
            "ffmpeg.exe",
            vec!["-i", "input.mp4", "-frames:v", "100"],
            "logs/ffmpeg.log",
        );
        assert!(spec.program.to_string_lossy().contains("ffmpeg"));
        assert_eq!(spec.args.len(), 4);
        assert!(spec.cwd.is_none());
        assert!(spec.timeout.is_none());
    }

    #[test]
    fn test_command_spec_with_options() {
        let spec = CommandSpec::new("test.exe", vec!["--help"], "test.log")
            .with_cwd("/projects/test")
            .with_timeout(Duration::from_secs(300));

        assert!(spec.cwd.is_some());
        assert_eq!(spec.timeout.unwrap().as_secs(), 300);
    }

    #[test]
    fn test_command_spec_serialization() {
        let spec = CommandSpec::new(
            "brush.exe",
            vec!["--train", "--iterations", "7000"],
            "brush.log",
        );
        let json = serde_json::to_string(&spec).unwrap();
        let deserialized: CommandSpec = serde_json::from_str(&json).unwrap();
        assert!(deserialized.program.to_string_lossy().contains("brush"));
        assert_eq!(deserialized.args.len(), 3);
    }
}
