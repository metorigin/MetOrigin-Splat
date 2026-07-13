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

    /// Return a localized copy safe for presentation in the UI.
    ///
    /// Technical details remain available through `technical_message` and
    /// diagnostic logs, but are intentionally not exposed to end users.
    pub fn localized_for_ui(&self) -> Self {
        let mut localized = self.clone();
        let (title, message, suggestion) = match self.category {
            ErrorCategory::User => (
                "输入内容有误",
                "输入内容或项目数据无效，请检查后重试。",
                "检查输入内容和项目设置后重试。",
            ),
            ErrorCategory::Environment => (
                "运行环境异常",
                "运行环境不满足要求，请检查系统配置后重试。",
                "检查系统环境、驱动程序和依赖工具。",
            ),
            ErrorCategory::Media => (
                "媒体文件异常",
                "媒体文件无效、损坏或缺失，请检查源媒体后重试。",
                "确认媒体文件存在、可读取且格式受支持。",
            ),
            ErrorCategory::Engine => (
                "处理引擎执行失败",
                "处理引擎执行失败，请检查引擎状态并查看日志。",
                "确认处理引擎可用，并查看日志了解详细信息。",
            ),
            ErrorCategory::Filesystem => (
                "文件操作失败",
                "文件或目录操作失败，请检查路径和访问权限。",
                "检查文件路径、磁盘空间和目录访问权限。",
            ),
            ErrorCategory::Resource => (
                "系统资源不足",
                "系统资源不足，请释放内存或磁盘空间后重试。",
                "关闭其他程序或释放磁盘空间后重试。",
            ),
            ErrorCategory::Internal => (
                "应用内部错误",
                "应用内部发生错误，请重试并查看日志。",
                "重新执行操作；如果问题持续出现，请保留日志。",
            ),
        };

        if !contains_chinese(&localized.title) {
            localized.title = title.to_string();
        }
        if !contains_chinese(&localized.user_message) {
            localized.user_message = format!("{}（错误代码：{}）", message, self.code);
        }
        localized.suggestions.retain(|item| contains_chinese(item));
        if localized.suggestions.is_empty() {
            localized.suggestions = vec![suggestion.to_string()];
        }
        localized
    }

    /// Return the Simplified Chinese user message for an application error.
    pub fn user_message_zh(&self) -> String {
        self.localized_for_ui().user_message.clone()
    }
}

fn contains_chinese(value: &str) -> bool {
    value
        .chars()
        .any(|character| ('\u{3400}'..='\u{9fff}').contains(&character))
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
            "JSON 序列化失败",
            "应用数据无法序列化，请重试并查看日志。",
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
    fn test_error_has_safe_chinese_user_message() {
        let err = AppError::new(
            "E-2101",
            ErrorCategory::Engine,
            "Engine Failed",
            "The external engine returned an error.",
        );
        let message = err.user_message_zh();
        assert!(message.contains("处理引擎执行失败"));
        assert!(message.contains("E-2101"));
        assert!(!message.contains("external engine"));

        let localized = err.localized_for_ui();
        assert_eq!(localized.title, "处理引擎执行失败");
        assert!(localized.suggestions[0].contains("处理引擎"));
        assert_eq!(localized.technical_message, err.technical_message);
    }

    #[test]
    fn test_existing_chinese_user_message_is_preserved() {
        let err = AppError::new(
            "E-1001",
            ErrorCategory::User,
            "输入无效",
            "请选择有效的媒体文件。",
        );
        assert_eq!(err.user_message_zh(), "请选择有效的媒体文件。");
    }

    #[test]
    fn test_error_category_display() {
        assert_eq!(format!("{}", ErrorCategory::User), "user");
        assert_eq!(format!("{}", ErrorCategory::Engine), "engine");
        assert_eq!(format!("{}", ErrorCategory::Internal), "internal");
    }
}
