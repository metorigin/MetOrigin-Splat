use std::fmt;
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;

/// Categorizes an error for user-facing presentation and recovery guidance.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ErrorCategory {
    /// User did something wrong (invalid input, wrong file type, etc.)
    User,
    /// System environment issue (missing GPU driver, no disk space, etc.)
    Environment,
    /// Media file problem (corrupted video, unsupported codec, etc.)
    Media,
    /// External engine error (FFmpeg, COLMAP, Brush crashed or returned error)
    Engine,
    /// File system error (permission denied, path not found, etc.)
    Filesystem,
    /// System resource exhaustion (OOM, out of VRAM, etc.)
    Resource,
    /// Internal programming error (should not happen in normal operation)
    Internal,
}

impl fmt::Display for ErrorCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::User => write!(f, "user"),
            Self::Environment => write!(f, "environment"),
            Self::Media => write!(f, "media"),
            Self::Engine => write!(f, "engine"),
            Self::Filesystem => write!(f, "filesystem"),
            Self::Resource => write!(f, "resource"),
            Self::Internal => write!(f, "internal"),
        }
    }
}

/// Unified application error with user-friendly messaging and recovery hints.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppErrorData {
    /// Machine-readable error code (e.g. "E-1001")
    pub code: String,
    /// High-level category for grouping and routing
    pub category: ErrorCategory,
    /// Short human-readable title ("File Not Found")
    pub title: String,
    /// User-facing message that explains what happened
    pub user_message: String,
    /// Technical details for diagnostic logs (optional)
    pub technical_message: Option<String>,
    /// Ordered list of actionable suggestions for the user
    pub suggestions: Vec<String>,
    /// Whether retrying the same operation may succeed
    pub retryable: bool,
    /// Path to the relevant log file, if any
    pub log_path: Option<PathBuf>,
}

/// Compact, wire-compatible wrapper around [`AppErrorData`].
///
/// Boxing the error payload keeps `Result<T, AppError>` small without
/// changing the serialized error object or callers' field access.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct AppError(Box<AppErrorData>);

impl Deref for AppError {
    type Target = AppErrorData;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for AppError {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl AppError {
    /// Create a new user-facing error.
    pub fn new(
        code: impl Into<String>,
        category: ErrorCategory,
        title: impl Into<String>,
        user_message: impl Into<String>,
    ) -> Self {
        Self(Box::new(AppErrorData {
            code: code.into(),
            category,
            title: title.into(),
            user_message: user_message.into(),
            technical_message: None,
            suggestions: Vec::new(),
            retryable: false,
            log_path: None,
        }))
    }

    /// Attach a technical detail message.
    pub fn with_technical(mut self, message: impl Into<String>) -> Self {
        self.technical_message = Some(message.into());
        self
    }

    /// Attach actionable suggestions.
    pub fn with_suggestions(mut self, suggestions: Vec<impl Into<String>>) -> Self {
        self.suggestions = suggestions.into_iter().map(Into::into).collect();
        self
    }

    /// Mark the error as retryable.
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// Attach a log file path.
    pub fn with_log_path(mut self, path: PathBuf) -> Self {
        self.log_path = Some(path);
        self
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.code, self.title, self.user_message)
    }
}

impl std::error::Error for AppError {}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            "E-9003",
            ErrorCategory::Internal,
            "JSON Serialization Failed",
            "Application data could not be serialized.",
        )
        .with_technical(error.to_string())
    }
}

/// Convenience alias for Results that use [`AppError`] as the error type.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_creation() {
        let err = AppError::new(
            "E-1001",
            ErrorCategory::User,
            "Invalid Input",
            "The file must be a video.",
        );
        assert_eq!(err.code, "E-1001");
        assert_eq!(err.category, ErrorCategory::User);
        assert!(err.technical_message.is_none());
        assert!(err.suggestions.is_empty());
        assert!(!err.retryable);
    }

    #[test]
    fn test_error_with_details() {
        let err = AppError::new(
            "E-2001",
            ErrorCategory::Engine,
            "FFmpeg Error",
            "FFmpeg exited with code 1",
        )
        .with_technical("ffmpeg reported 'Invalid data found when processing input'")
        .with_suggestions(vec![
            "Check the video file is not corrupted",
            "Try converting to MP4 first",
        ])
        .retryable(true);

        assert_eq!(err.code, "E-2001");
        assert!(err.technical_message.is_some());
        assert_eq!(err.suggestions.len(), 2);
        assert!(err.retryable);
    }

    #[test]
    fn test_error_serialization_roundtrip() {
        let err = AppError::new("E-1001", ErrorCategory::User, "Test", "Test message");
        let json = serde_json::to_string(&err).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["code"], "E-1001");
        assert!(value.get("0").is_none(), "wrapper must remain transparent");
        let deserialized: AppError = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.code, "E-1001");
        assert_eq!(deserialized.category, ErrorCategory::User);
    }

    #[test]
    fn test_error_display() {
        let err = AppError::new(
            "E-1001",
            ErrorCategory::User,
            "Invalid Input",
            "The file must be a video.",
        );
        let display = format!("{}", err);
        assert!(display.contains("E-1001"));
        assert!(display.contains("Invalid Input"));
    }

    #[test]
    fn test_error_category_display() {
        assert_eq!(format!("{}", ErrorCategory::User), "user");
        assert_eq!(format!("{}", ErrorCategory::Engine), "engine");
        assert_eq!(format!("{}", ErrorCategory::Internal), "internal");
    }
}
