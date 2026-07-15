use crate::result::ColmapResult;
use crate::types::DiagnosticLevel;
use crate::validator::{ValidationCheck, ValidationReport};

/// A single diagnostic item with bilingual support.
#[derive(Debug, Clone)]
pub struct DiagnosticItem {
    /// English message
    pub message_en: String,
    /// Chinese message
    pub message_zh: String,
    /// Actionable suggestions for the user
    pub suggestions: Vec<String>,
}

/// Complete diagnostic report for a COLMAP reconstruction attempt.
///
/// Provides bilingual (English/Chinese) messages and actionable
/// suggestions depending on the outcome of the reconstruction.
#[derive(Debug, Clone)]
pub struct ColmapDiagnosticReport {
    /// Overall severity level
    pub level: DiagnosticLevel,
    /// One-line summary (English)
    pub summary_en: String,
    /// One-line summary (Chinese)
    pub summary_zh: String,
    /// Whether the reconstruction was successful enough to continue
    pub success: bool,
    /// Detailed diagnostic items
    pub details: Vec<DiagnosticItem>,
}

impl ColmapDiagnosticReport {
    /// Generate a diagnostic report from a successful reconstruction.
    pub fn success(result: &ColmapResult) -> Self {
        let rate = result.registration_rate();
        Self {
            level: DiagnosticLevel::Info,
            summary_en: format!(
                "Sparse reconstruction completed: {}/{} images registered ({} points)",
                result.registered_images, result.total_images, result.point_count
            ),
            summary_zh: format!(
                "稀疏重建完成：{}/{} 张图像已注册（{} 个三维点）",
                result.registered_images, result.total_images, result.point_count
            ),
            success: true,
            details: vec![
                DiagnosticItem {
                    message_en: format!(
                        "Registration rate: {:.1}% ({} / {} images)",
                        rate * 100.0,
                        result.registered_images,
                        result.total_images
                    ),
                    message_zh: format!(
                        "注册率：{:.1}%（{} / {} 张图像）",
                        rate * 100.0,
                        result.registered_images,
                        result.total_images
                    ),
                    suggestions: vec![],
                },
                DiagnosticItem {
                    message_en: format!("3D points: {}", result.point_count),
                    message_zh: format!("三维点数：{}", result.point_count),
                    suggestions: vec![],
                },
            ],
        }
    }

    /// Generate a diagnostic report from a failed/poor quality reconstruction.
    pub fn failure(result: &ColmapResult, total_images: usize, report: &ValidationReport) -> Self {
        let details = generate_failure_diagnostics(result, total_images, &report.failed_checks());

        let level = report.worst_level();
        let success = report.passed;

        Self {
            level,
            summary_en: format!(
                "Sparse reconstruction could not be completed. {}/{} images registered ({} points).",
                result.registered_images, total_images, result.point_count
            ),
            summary_zh: format!(
                "稀疏重建未能成功完成。已注册 {}/{} 张图像（{} 个三维点）。",
                result.registered_images, total_images, result.point_count
            ),
            success,
            details,
        }
    }

    /// Format the report for log output (single locale).
    pub fn format_log(&self) -> String {
        let status = if self.success { "OK" } else { "FAILED" };
        let mut lines = vec![format!("[COLMAP] {}: {}", status, self.summary_en)];
        for detail in &self.details {
            lines.push(format!("  - {}", detail.message_en));
            for suggestion in &detail.suggestions {
                lines.push(format!("    * {}", suggestion));
            }
        }
        lines.join("\n")
    }

    /// Format the report for the Tauri frontend (with Chinese).
    pub fn format_ui(&self) -> serde_json::Value {
        serde_json::json!({
            "success": self.success,
            "level": format!("{:?}", self.level),
            "summary": {
                "en": self.summary_en,
                "zh": self.summary_zh,
            },
            "details": self.details.iter().map(|d| {
                serde_json::json!({
                    "message": {
                        "en": d.message_en,
                        "zh": d.message_zh,
                    },
                    "suggestions": d.suggestions,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

/// Generate detailed failure diagnostics.
fn generate_failure_diagnostics(
    result: &ColmapResult,
    total: usize,
    failed_checks: &[&ValidationCheck],
) -> Vec<DiagnosticItem> {
    let mut items = Vec::new();

    // Core message: reconstruction failure
    items.push(DiagnosticItem {
        message_en: "Could not establish a stable camera trajectory.".into(),
        message_zh: "无法建立稳定的相机轨迹。".into(),
        suggestions: vec![],
    });

    // Registration summary
    items.push(DiagnosticItem {
        message_en: format!(
            "Registered images: {}/{} ({:.1}%)",
            result.registered_images,
            total,
            if total > 0 {
                result.registered_images as f64 / total as f64 * 100.0
            } else {
                0.0
            }
        ),
        message_zh: format!(
            "已注册图像：{}/{}（{:.1}%）",
            result.registered_images,
            total,
            if total > 0 {
                result.registered_images as f64 / total as f64 * 100.0
            } else {
                0.0
            }
        ),
        suggestions: vec![],
    });

    // Add details for each failed check
    for check in failed_checks {
        let (msg_en, msg_zh) = match check.name.as_str() {
            "registered_images" => (
                "No images were registered in the reconstruction.".to_string(),
                "没有任何图像被成功注册到重建中。".to_string(),
            ),
            "registration_rate" => (
                format!(
                    "Registration rate ({:.1}%) is below the minimum threshold ({:.0}%).",
                    if result.total_images > 0 {
                        result.registered_images as f64 / result.total_images as f64 * 100.0
                    } else {
                        0.0
                    },
                    50.0
                ),
                format!(
                    "注册率（{:.1}%）低于最低要求（{:.0}%）。",
                    if result.total_images > 0 {
                        result.registered_images as f64 / result.total_images as f64 * 100.0
                    } else {
                        0.0
                    },
                    50.0
                ),
            ),
            "point_count" => (
                format!(
                    "Only {} 3D points were generated. More textured scenes produce better results.",
                    result.point_count
                ),
                format!("仅生成了 {} 个三维点，含更多纹理的场景可获得更好的结果。", result.point_count),
            ),
            "reprojection_error" => (
                "Reprojection error is higher than expected.".to_string(),
                "重投影误差过高，可能影响最终重建质量。".to_string(),
            ),
            _ => (check.detail.clone(), check.detail.clone()),
        };

        items.push(DiagnosticItem {
            message_en: msg_en,
            message_zh: msg_zh,
            suggestions: vec![],
        });
    }

    // Possible causes
    let causes_en = [
        "Video motion is too fast or contains motion blur",
        "Scene has insufficient texture or detail",
        "Insufficient overlap between adjacent frames",
        "Scene contains significant dynamic objects (people, cars, etc.)",
        "Scene contains reflective, transparent, or uniform surfaces",
    ];
    let causes_zh = [
        "视频运动过快或存在模糊",
        "场景纹理不足",
        "相邻画面重叠不够",
        "画面中存在大量动态物体（人、车等）",
        "场景中存在强反光、透明或纯色表面",
    ];

    let mut reasons_en = vec!["Possible causes:".to_string()];
    let mut reasons_zh = vec!["可能原因：".to_string()];
    for (i, (en, zh)) in causes_en.iter().zip(causes_zh.iter()).enumerate() {
        reasons_en.push(format!("{}. {}", i + 1, en));
        reasons_zh.push(format!("{}. {}", i + 1, zh));
    }

    items.push(DiagnosticItem {
        message_en: reasons_en.join("\n"),
        message_zh: reasons_zh.join("\n"),
        suggestions: vec![],
    });

    // Suggestions
    items.push(DiagnosticItem {
        message_en: [
            "Suggestions:",
            "1. Use slower, more continuous camera motion",
            "2. Reduce the frame extraction interval to capture more frames",
            "3. Ensure the subject is captured from multiple angles",
            "4. Avoid reflective, transparent, and uniform surfaces",
            "5. Ensure adequate lighting and texture in the scene",
        ]
        .join("\n"),
        message_zh: [
            "建议：",
            "1. 使用更缓慢、连续的拍摄方式",
            "2. 降低抽帧间隔，增加更多画面",
            "3. 确保目标从多个角度被拍摄",
            "4. 避免强反光、透明和纯色表面",
            "5. 确保场景中有充足的光线和纹理细节",
        ]
        .join("\n"),
        suggestions: vec![
            "使用更缓慢、连续的拍摄方式".into(),
            "降低抽帧间隔，增加更多画面".into(),
            "确保目标从多个角度被拍摄".into(),
            "避免强反光、透明和纯色表面".into(),
            "确保场景中有足够的纹理细节".into(),
        ],
    });

    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validator::{ColmapValidator, ValidationOptions};

    fn sample_result(registered: usize, total: usize, points: usize) -> ColmapResult {
        ColmapResult::new(registered, total, points, "colmap/sparse/0".into())
            .with_observations(points * 10)
            .with_error(0.85)
    }

    fn sample_model_info(
        registered: usize,
        total: usize,
        points: usize,
        error: f64,
    ) -> crate::types::ModelInfo {
        crate::types::ModelInfo {
            cameras: 1,
            images: total,
            registered_images: registered,
            point_count: points,
            observations: points * 10,
            mean_track_length: 5.0,
            mean_reprojection_error: error,
        }
    }

    #[test]
    fn test_success_report() {
        let result = sample_result(80, 100, 50000);
        let report = ColmapDiagnosticReport::success(&result);
        assert!(report.success);
        assert_eq!(report.level, DiagnosticLevel::Info);
        assert!(report.summary_en.contains("80/100"));
        assert!(report.summary_zh.contains("80/100"));
    }

    #[test]
    fn test_failure_report_contains_chinese() {
        let result = sample_result(4, 180, 200);
        let info = sample_model_info(4, 180, 200, 0.5);
        let validation = ColmapValidator::validate(&info, 180, &ValidationOptions::default());
        let report = ColmapDiagnosticReport::failure(&result, 180, &validation);

        assert!(!report.success);
        assert_eq!(report.level, DiagnosticLevel::Warning);

        // Check for Chinese content
        let all_zh: String = report
            .details
            .iter()
            .map(|d| d.message_zh.clone())
            .collect();
        assert!(all_zh.contains("无法建立稳定的相机轨迹"));
        assert!(all_zh.contains("运动过快"));
        assert!(all_zh.contains("纹理不足"));
    }

    #[test]
    fn test_failure_report_contains_english() {
        let result = sample_result(4, 180, 200);
        let info = sample_model_info(4, 180, 200, 0.5);
        let validation = ColmapValidator::validate(&info, 180, &ValidationOptions::default());
        let report = ColmapDiagnosticReport::failure(&result, 180, &validation);

        let all_en: String = report
            .details
            .iter()
            .map(|d| d.message_en.clone())
            .collect();
        assert!(all_en.contains("Could not establish"));
        assert!(all_en.contains("motion is too fast"));
        assert!(all_en.contains("insufficient texture"));
    }

    #[test]
    fn test_failure_report_contains_suggestions() {
        let result = sample_result(4, 180, 200);
        let info = sample_model_info(4, 180, 200, 0.5);
        let validation = ColmapValidator::validate(&info, 180, &ValidationOptions::default());
        let report = ColmapDiagnosticReport::failure(&result, 180, &validation);

        let has_suggestions = report.details.iter().any(|d| !d.suggestions.is_empty());
        assert!(has_suggestions);

        // Check specific Chinese suggestion
        let suggestions: Vec<&str> = report
            .details
            .iter()
            .flat_map(|d| d.suggestions.iter().map(|s| s.as_str()))
            .collect();
        assert!(suggestions.contains(&"使用更缓慢、连续的拍摄方式"));
    }

    #[test]
    fn test_format_log() {
        let result = sample_result(80, 100, 50000);
        let report = ColmapDiagnosticReport::success(&result);
        let log = report.format_log();
        assert!(log.starts_with("[COLMAP] OK:"));
        assert!(log.contains("80/100"));
    }

    #[test]
    fn test_format_ui() {
        let result = sample_result(80, 100, 50000);
        let report = ColmapDiagnosticReport::success(&result);
        let ui = report.format_ui();
        assert_eq!(ui["success"], true);
        assert_eq!(ui["summary"]["en"], report.summary_en);
        assert_eq!(ui["summary"]["zh"], report.summary_zh);
    }

    #[test]
    fn test_edge_case_zero_images() {
        let result = sample_result(0, 0, 0);
        let info = sample_model_info(0, 0, 0, 0.0);
        let options = ValidationOptions::default();
        let validation = ColmapValidator::validate(&info, 0, &options);
        let report = ColmapDiagnosticReport::failure(&result, 0, &validation);

        assert!(!report.success);
        // Should not crash when total_images is 0
        assert!(report.summary_en.contains("0/0"));
    }
}
