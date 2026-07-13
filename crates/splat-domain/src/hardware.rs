/// Information about a detected external engine.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EngineInfo {
    /// Engine name (e.g. "ffmpeg", "colmap", "brush")
    pub name: String,
    /// Detected version string
    pub version: Option<String>,
    /// Path to the engine executable
    pub path: Option<String>,
    /// Whether the engine is available and functional
    pub available: bool,
}

impl EngineInfo {
    /// Create a new engine info entry.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            version: None,
            path: None,
            available: false,
        }
    }
}

/// A detected GPU device.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GpuDevice {
    /// Device name (e.g. "NVIDIA GeForce RTX 4090")
    pub name: String,
    /// Vendor (e.g. "NVIDIA", "AMD", "Intel")
    pub vendor: String,
    /// Dedicated video memory in bytes
    pub vram_bytes: Option<u64>,
    /// CUDA compute capability (e.g. "8.9") — NVIDIA only
    pub compute_capability: Option<String>,
    /// DirectX version supported
    pub directx_version: Option<String>,
}

/// Profile of the user's hardware, collected on startup.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HardwareProfile {
    /// Operating system name
    pub operating_system: String,
    /// CPU model name (if detectable)
    pub cpu_name: Option<String>,
    /// Total system memory in bytes
    pub memory_total_bytes: u64,
    /// Detected GPU devices
    pub gpu_devices: Vec<GpuDevice>,
    /// Available disk space at the default project location
    pub available_disk_bytes: u64,
    /// Recommended training preset based on hardware
    pub recommended_preset: String,
    /// Warnings about hardware limitations
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_engine_info_new() {
        let info = EngineInfo::new("ffmpeg");
        assert_eq!(info.name, "ffmpeg");
        assert!(!info.available);
    }

    #[test]
    fn test_engine_info_serialization() {
        let info = EngineInfo {
            name: "brush".into(),
            version: Some("1.0.0".into()),
            path: Some("C:/brush/brush.exe".into()),
            available: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        let deserialized: EngineInfo = serde_json::from_str(&json).unwrap();
        assert!(deserialized.available);
        assert_eq!(deserialized.version.unwrap(), "1.0.0");
    }

    #[test]
    fn test_gpu_device() {
        let gpu = GpuDevice {
            name: "NVIDIA GeForce RTX 4090".into(),
            vendor: "NVIDIA".into(),
            vram_bytes: Some(24 * 1024 * 1024 * 1024),
            compute_capability: Some("8.9".into()),
            directx_version: Some("12".into()),
        };
        assert_eq!(gpu.vendor, "NVIDIA");
    }

    #[test]
    fn test_hardware_profile() {
        let profile = HardwareProfile {
            operating_system: "Windows 11 Pro".into(),
            cpu_name: Some("AMD Ryzen 9 7950X".into()),
            memory_total_bytes: 64 * 1024 * 1024 * 1024,
            gpu_devices: vec![],
            available_disk_bytes: 500 * 1024 * 1024 * 1024,
            recommended_preset: "balanced".into(),
            warnings: vec![],
        };
        assert_eq!(profile.operating_system, "Windows 11 Pro");
        assert_eq!(profile.recommended_preset, "balanced");
    }
}
