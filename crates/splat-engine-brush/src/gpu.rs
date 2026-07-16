use std::io;

use splat_domain::error::{AppError, AppResult, ErrorCategory};
use splat_process::background_command;

/// NVIDIA GPU and driver evidence returned by `nvidia-smi`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NvidiaSmiInfo {
    pub gpu_name: String,
    pub driver_version: String,
    pub memory_total_bytes: u64,
}

impl NvidiaSmiInfo {
    pub fn summary(&self) -> String {
        format!(
            "{} · 驱动 {} · {:.1} GiB 显存",
            self.gpu_name,
            self.driver_version,
            self.memory_total_bytes as f64 / 1024_f64.powi(3)
        )
    }
}

/// Require a working NVIDIA driver before accepting a reconstruction/training
/// run. The driver itself is deliberately not bundled with the application,
/// so `nvidia-smi` is the release-safe source of truth on the target machine.
pub fn require_nvidia_smi() -> AppResult<NvidiaSmiInfo> {
    probe_nvidia_smi_with(|| {
        background_command("nvidia-smi")
            .args([
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .map(|output| ProbeOutput {
                success: output.status.success(),
                exit_code: output.status.code(),
                stdout: output.stdout,
                stderr: output.stderr,
            })
    })
}

struct ProbeOutput {
    success: bool,
    exit_code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn probe_nvidia_smi_with(
    run: impl FnOnce() -> io::Result<ProbeOutput>,
) -> AppResult<NvidiaSmiInfo> {
    let output = run().map_err(|error| {
        AppError::new(
            "E-5001",
            ErrorCategory::Environment,
            "NVIDIA 驱动不可用",
            "未能运行 nvidia-smi，无法确认 NVIDIA 显卡和驱动可用于 3DGS 训练。请安装或更新 NVIDIA 官方驱动后重试。",
        )
        .with_technical(format!("failed to launch nvidia-smi: {error}"))
        .with_suggestions(vec![
            "从 NVIDIA 官网安装适用于当前显卡的最新驱动。",
            "安装后重启 Windows，并在命令提示符运行 nvidia-smi 验证。",
        ])
    })?;

    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::new(
            "E-5002",
            ErrorCategory::Environment,
            "NVIDIA 驱动响应异常",
            "nvidia-smi 返回错误，NVIDIA 驱动可能未正确安装或当前未能加载。请修复驱动后再开始训练。",
        )
        .with_technical(format!(
            "nvidia-smi exit_code={:?}, stderr={stderr}",
            output.exit_code
        ))
        .with_suggestions(vec![
            "重启 Windows 后再次运行 nvidia-smi。",
            "若问题仍存在，请执行 NVIDIA 驱动的全新安装。",
        ]));
    }

    parse_nvidia_smi_output(&output.stdout)
}

fn parse_nvidia_smi_output(stdout: &[u8]) -> AppResult<NvidiaSmiInfo> {
    let text = String::from_utf8_lossy(stdout);
    let best = text
        .lines()
        .filter_map(parse_gpu_line)
        .max_by_key(|gpu| gpu.memory_total_bytes);
    best.ok_or_else(|| {
        AppError::new(
            "E-5003",
            ErrorCategory::Environment,
            "未检测到可用的 NVIDIA GPU",
            "nvidia-smi 未返回可用的 NVIDIA 显卡、驱动版本和显存信息，当前环境不能开始 3DGS 训练。",
        )
        .with_technical(format!("unexpected nvidia-smi output: {}", text.trim()))
        .with_suggestions(vec![
            "确认设备管理器中可以看到 NVIDIA 显卡且没有错误标记。",
            "更新 NVIDIA 驱动并重启 Windows 后重新检查。",
        ])
    })
}

fn parse_gpu_line(line: &str) -> Option<NvidiaSmiInfo> {
    let values = line.split(',').map(str::trim).collect::<Vec<_>>();
    if values.len() != 3
        || values[0].is_empty()
        || values[1].is_empty()
        || values[0].eq_ignore_ascii_case("[N/A]")
        || values[1].eq_ignore_ascii_case("[N/A]")
    {
        return None;
    }
    let memory_mib = values[2].parse::<f64>().ok()?;
    if !memory_mib.is_finite() || memory_mib <= 0.0 {
        return None;
    }
    Some(NvidiaSmiInfo {
        gpu_name: values[0].to_string(),
        driver_version: values[1].to_string(),
        memory_total_bytes: (memory_mib * 1024.0 * 1024.0) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nvidia_smi_and_selects_the_largest_gpu() {
        let info = probe_nvidia_smi_with(|| {
            Ok(ProbeOutput {
                success: true,
                exit_code: Some(0),
                stdout: b"NVIDIA RTX A2000, 576.52, 4096\nNVIDIA GeForce RTX 4090, 576.52, 24564\n"
                    .to_vec(),
                stderr: Vec::new(),
            })
        })
        .unwrap();
        assert_eq!(info.gpu_name, "NVIDIA GeForce RTX 4090");
        assert_eq!(info.driver_version, "576.52");
        assert_eq!(info.memory_total_bytes, 24_564 * 1024 * 1024);
        assert!(info.summary().contains("驱动 576.52"));
    }

    #[test]
    fn missing_nvidia_smi_is_a_clear_hard_failure() {
        let error =
            probe_nvidia_smi_with(|| Err(io::Error::new(io::ErrorKind::NotFound, "not found")))
                .unwrap_err();
        assert_eq!(error.code, "E-5001");
        assert!(error.user_message.contains("nvidia-smi"));
        assert!(error.user_message.contains("NVIDIA"));
    }

    #[test]
    fn failed_driver_response_preserves_diagnostic_stderr() {
        let error = probe_nvidia_smi_with(|| {
            Ok(ProbeOutput {
                success: false,
                exit_code: Some(9),
                stdout: Vec::new(),
                stderr: b"Driver/library version mismatch".to_vec(),
            })
        })
        .unwrap_err();
        assert_eq!(error.code, "E-5002");
        assert!(error
            .technical_message
            .as_deref()
            .unwrap()
            .contains("version mismatch"));
    }

    #[test]
    fn malformed_or_empty_gpu_output_is_rejected() {
        let error = parse_nvidia_smi_output(b"NVIDIA GPU, [N/A], [N/A]\n").unwrap_err();
        assert_eq!(error.code, "E-5003");
        assert!(error.user_message.contains("不能开始"));
    }
}
