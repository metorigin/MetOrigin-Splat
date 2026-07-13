use splat_domain::error::AppResult;
use splat_domain::hardware::HardwareProfile;

/// Detects and profiles the user's hardware.
pub struct HardwareDetector;

impl HardwareDetector {
    /// Detect hardware and return a profile.
    ///
    /// TODO: Implement actual hardware detection.
    pub fn detect() -> HardwareProfile {
        HardwareProfile {
            operating_system: std::env::consts::OS.to_string(),
            cpu_name: None,
            memory_total_bytes: 0,
            gpu_devices: vec![],
            available_disk_bytes: 0,
            recommended_preset: "balanced".into(),
            warnings: vec![],
        }
    }

    /// Check if the system can run a given engine.
    ///
    /// TODO: Implement engine-specific capability checks.
    pub fn can_run_engine(_engine_name: &str) -> AppResult<bool> {
        Ok(true)
    }
}
