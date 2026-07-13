use std::io::{self, Write};
use std::path::PathBuf;

use chrono::Utc;

/// Writes process stdout/stderr to a log file with timestamps.
///
/// Each line is prefixed with a timestamp and stream identifier,
/// making it easy to diagnose issues after the fact.
///
/// # Log format
///
/// ```text
/// [2026-07-12 18:00:00.123] [stdout] Frame extraction started
/// [2026-07-12 18:00:01.456] [stderr] [FFmpeg] Invalid data found
/// [2026-07-12 18:00:01.457] ===== Process exited with code 1 =====
/// ```
pub struct LogWriter {
    /// Path to the log file
    file_path: PathBuf,
    /// The underlying file handle
    file: Option<std::fs::File>,
}

impl LogWriter {
    /// Create a new log writer.
    ///
    /// The parent directory will be created if it does not exist.
    pub fn create(file_path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::File::create(&file_path)?;
        Ok(Self {
            file_path,
            file: Some(file),
        })
    }

    /// Write a line from a specific stream (stdout or stderr).
    pub fn write_line(&mut self, stream: &str, line: &str) -> io::Result<()> {
        if let Some(ref mut file) = self.file {
            let now = Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
            writeln!(file, "[{now}] [{stream}] {line}")?;
            file.flush()?;
        }
        Ok(())
    }

    /// Write a separator line to mark an event boundary.
    pub fn write_separator(&mut self, message: &str) -> io::Result<()> {
        if let Some(ref mut file) = self.file {
            let now = Utc::now().format("%Y-%m-%d %H:%M:%S%.3f");
            writeln!(file, "[{now}] ===== {message} =====")?;
            file.flush()?;
        }
        Ok(())
    }

    /// Return the path to the log file.
    pub fn path(&self) -> &PathBuf {
        &self.file_path
    }

    /// Close the log file explicitly.
    pub fn close(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.take() {
            file.sync_all()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn test_log_writer_creates_file() {
        let dir = std::env::temp_dir().join("splat-log-test");
        let log_path = dir.join("test.log");
        let _ = std::fs::remove_dir_all(&dir);

        let mut writer = LogWriter::create(log_path.clone()).unwrap();
        writer.write_line("stdout", "hello world").unwrap();
        writer.close().unwrap();

        assert!(log_path.exists());

        let mut content = String::new();
        std::fs::File::open(&log_path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert!(content.contains("hello world"));
        assert!(content.contains("[stdout]"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_log_writer_separator() {
        let dir = std::env::temp_dir().join("splat-log-sep");
        let log_path = dir.join("sep.log");
        let _ = std::fs::remove_dir_all(&dir);

        let mut writer = LogWriter::create(log_path.clone()).unwrap();
        writer.write_separator("Process started").unwrap();
        writer.close().unwrap();

        let content = std::fs::read_to_string(&log_path).unwrap();
        assert!(content.contains("Process started"));
        assert!(content.contains("====="));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_log_writer_auto_creates_parent_dir() {
        let dir = std::env::temp_dir().join("splat-log-nested/deep/test");
        let log_path = dir.join("auto.log");
        let _ = std::fs::remove_dir_all(&dir);

        let mut writer = LogWriter::create(log_path.clone()).unwrap();
        writer.write_line("stdout", "auto-created dirs").unwrap();
        writer.close().unwrap();

        assert!(log_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
