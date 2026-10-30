//! Read-only resource observations and conservative preview backpressure.
//! System availability is not a GPU allocation limit. RSS entries may share
//! pages and are deliberately never added into a physical-memory total.
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use splat_domain::runtime::{EffectiveTraining, RuntimePlatform};
use sysinfo::{Pid, System};

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MemoryPressure {
    #[cfg_attr(
        not(any(target_os = "macos", test)),
        allow(
            dead_code,
            reason = "Keep the portable normal wire value; only macOS currently produces native pressure observations"
        )
    )]
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MemoryObservation {
    pub kind: &'static str,
    pub available_bytes: Option<u64>,
    pub available_source: Option<&'static str>,
    pub available_is_estimate: bool,
    pub free_bytes: Option<u64>,
    pub inactive_bytes: Option<u64>,
    pub compressed_bytes: Option<u64>,
    pub pressure: Option<MemoryPressure>,
    pub pressure_source: Option<&'static str>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PreviewAction {
    Allow,
    Pause,
    Release,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PreviewResourcePolicy {
    pub action: PreviewAction,
    pub reason: Option<&'static str>,
    pub memory_pressure: Option<MemoryPressure>,
    pub poll_interval_ms: u64,
    pub max_snapshot_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ProcessMemory {
    pub pid: u32,
    pub role: &'static str,
    pub resident_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RuntimeResourceSummary {
    pub requested_preset: Option<String>,
    pub colmap_backend: String,
    pub brush_backend: String,
    pub device_name: Option<String>,
    pub training_budget_bytes: Option<u64>,
    pub recommended_working_set_bytes: Option<u64>,
    pub effective_training: EffectiveTraining,
}

pub(crate) fn observe_memory(system: &System) -> MemoryObservation {
    let pressure = native_pressure();
    let known = system.total_memory() > 0;
    #[cfg(target_os = "macos")]
    let availability = native_availability(system.total_memory());
    #[cfg(not(target_os = "macos"))]
    let availability = None::<AppleMemoryAvailability>;
    let available_bytes = if cfg!(target_os = "macos") {
        availability.as_ref().map(|value| value.available_bytes)
    } else {
        known.then(|| system.available_memory())
    };
    MemoryObservation {
        kind: if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "unified"
        } else {
            "system"
        },
        available_bytes,
        available_source: available_bytes.map(|_| {
            if cfg!(target_os = "macos") {
                "mach_host_statistics64_free_plus_inactive"
            } else {
                "sysinfo_available_memory"
            }
        }),
        available_is_estimate: cfg!(target_os = "macos"),
        free_bytes: availability.as_ref().map(|value| value.free_bytes),
        inactive_bytes: availability.as_ref().map(|value| value.inactive_bytes),
        compressed_bytes: availability.as_ref().map(|value| value.compressed_bytes),
        pressure,
        pressure_source: pressure.map(|_| "kern.memorystatus_vm_pressure_level"),
        swap_total_bytes: known.then(|| system.total_swap()),
        swap_used_bytes: known.then(|| system.used_swap()),
    }
}

struct AppleMemoryAvailability {
    available_bytes: u64,
    free_bytes: u64,
    inactive_bytes: u64,
    compressed_bytes: u64,
}

/// A reclaimable-headroom estimate, not a promise that Metal can allocate it.
/// Free already includes speculative pages. Inactive pages may be reclaimed;
/// purgeable is a subset of other page categories, so it is not added again.
/// Compressor pages already occupy physical RAM and are not part of free or
/// inactive counts: subtracting them here can falsely collapse headroom to zero.
#[cfg(any(target_os = "macos", test))]
fn apple_availability(
    total: u64,
    page_size: u64,
    free: u64,
    inactive: u64,
    compressed: u64,
) -> Option<AppleMemoryAvailability> {
    if total == 0 || page_size == 0 {
        return None;
    }
    let free_bytes = free.checked_mul(page_size)?;
    let inactive_bytes = inactive.checked_mul(page_size)?;
    let compressed_bytes = compressed.checked_mul(page_size)?;
    Some(AppleMemoryAvailability {
        available_bytes: free_bytes.checked_add(inactive_bytes)?.min(total),
        free_bytes,
        inactive_bytes,
        compressed_bytes,
    })
}

#[cfg(target_os = "macos")]
fn native_availability(total: u64) -> Option<AppleMemoryAvailability> {
    // One send right is retained for this process lifetime, rather than leaking
    // a new mach_host_self reference on every one-second pressure observation.
    static HOST: std::sync::OnceLock<libc::mach_port_t> = std::sync::OnceLock::new();
    // SAFETY: these read-only Mach calls use the libc-defined ABI and an
    // initialized output structure with its exact in/out integer count.
    let (status, statistics, count, page_size) = unsafe {
        // libc deprecates this binding only to recommend the mach2 crate; the
        // macOS SDK's mach/mach_init.h still exposes this supported API without
        // an OS deprecation. Reuse the already locked libc ABI for this call.
        #[allow(deprecated)]
        let host = *HOST.get_or_init(|| libc::mach_host_self());
        let mut statistics = std::mem::zeroed::<libc::vm_statistics64>();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let status = libc::host_statistics64(
            host,
            libc::HOST_VM_INFO64,
            (&mut statistics as *mut libc::vm_statistics64).cast(),
            &mut count,
        );
        (status, statistics, count, libc::sysconf(libc::_SC_PAGESIZE))
    };
    if status != libc::KERN_SUCCESS || count < libc::HOST_VM_INFO64_COUNT || page_size <= 0 {
        return None;
    }
    apple_availability(
        total,
        page_size as u64,
        u64::from(statistics.free_count),
        u64::from(statistics.inactive_count),
        u64::from(statistics.compressor_page_count),
    )
}

pub(crate) fn current_preview_policy() -> PreviewResourcePolicy {
    if !cfg!(target_os = "macos") {
        return preview_policy(false, 0, None, None);
    }
    let mut system = System::new();
    system.refresh_memory();
    let observation = observe_memory(&system);
    preview_policy(
        true,
        system.total_memory(),
        observation.available_bytes,
        observation.pressure,
    )
}

pub(crate) fn preview_policy(
    macos: bool,
    total: u64,
    available: Option<u64>,
    pressure: Option<MemoryPressure>,
) -> PreviewResourcePolicy {
    if !macos {
        return PreviewResourcePolicy {
            action: PreviewAction::Allow,
            reason: None,
            memory_pressure: None,
            poll_interval_ms: 500,
            max_snapshot_bytes: GIB,
        };
    }
    let interval = if total >= 32 * GIB {
        2_000
    } else if total >= 16 * GIB {
        5_000
    } else {
        10_000
    };
    // One PLY is only part of the peak: retain headroom for the old/new meshes,
    // decoding, GPU upload and training. This is a policy estimate, not measured RSS.
    let cap = available
        .map(|bytes| bytes.saturating_sub(GIB / 2) / 6)
        .unwrap_or(64 * 1024 * 1024)
        .min(GIB);
    let (action, reason) = if pressure == Some(MemoryPressure::Critical) {
        (PreviewAction::Release, Some("critical_memory_pressure"))
    } else if available.is_some_and(|bytes| bytes <= GIB / 2) {
        (PreviewAction::Release, Some("low_available_memory"))
    } else if pressure == Some(MemoryPressure::Warning) {
        (PreviewAction::Pause, Some("memory_pressure_warning"))
    } else if available.is_some_and(|bytes| bytes < (total / 10).max(GIB)) {
        (PreviewAction::Pause, Some("low_available_memory"))
    } else {
        (PreviewAction::Allow, None)
    };
    PreviewResourcePolicy {
        action,
        reason,
        memory_pressure: pressure,
        poll_interval_ms: if pressure.is_none() {
            interval.max(5_000)
        } else {
            interval
        },
        max_snapshot_bytes: cap,
    }
}

pub(crate) fn runtime_summary(
    project: Option<&Path>,
) -> Result<Option<RuntimeResourceSummary>, String> {
    let Some(project) = project else {
        return Ok(None);
    };
    let Some(profile) =
        splat_project::load_execution_profile(project).map_err(|_| "无法读取本次运行资源配置。")?
    else {
        return Ok(None);
    };
    let requested_preset = read_requested_preset(project);
    Ok(Some(RuntimeResourceSummary {
        requested_preset,
        colmap_backend: if profile.platform == RuntimePlatform::Macos {
            "CPU".into()
        } else {
            format!("{:?}", profile.colmap.feature_backend)
        },
        brush_backend: format!("{:?}", profile.brush.backend),
        device_name: profile.brush.probe_result.device_name,
        training_budget_bytes: profile.memory.training_budget_bytes,
        recommended_working_set_bytes: profile.memory.available_working_set_bytes,
        effective_training: profile.effective_training,
    }))
}

fn read_requested_preset(project: &Path) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Settings {
        preset: String,
    }
    #[derive(serde::Deserialize)]
    struct Project {
        settings: Settings,
    }
    let file = std::fs::File::open(project.join("project.json")).ok()?;
    serde_json::from_reader::<_, Project>(file.take(1024 * 1024))
        .ok()
        .map(|project| project.settings.preset)
}

pub(crate) fn process_memory(system: &System, root: u32) -> Vec<ProcessMemory> {
    let root = Pid::from_u32(root);
    let mut result = Vec::new();
    for (pid, process) in system.processes() {
        let mut ancestor = Some(*pid);
        let mut visited = HashSet::new();
        while let Some(current) = ancestor {
            if !visited.insert(current) {
                break;
            }
            if current == root {
                let name = process.name().to_string_lossy().to_ascii_lowercase();
                let role = if *pid == root {
                    Some("application")
                } else if name.contains("brush") {
                    Some("brush")
                } else if name.contains("colmap") {
                    Some("colmap")
                } else if name.contains("webkit") {
                    Some("webkit")
                } else {
                    None
                };
                if let Some(role) = role.filter(|_| process.memory() > 0) {
                    result.push(ProcessMemory {
                        pid: pid.as_u32(),
                        role,
                        resident_bytes: process.memory(),
                    });
                }
                break;
            }
            ancestor = system.process(current).and_then(|parent| parent.parent());
        }
    }
    result.sort_by_key(|entry| entry.pid);
    result
}

#[cfg(target_os = "macos")]
fn native_pressure() -> Option<MemoryPressure> {
    use std::ffi::{c_char, c_void};
    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            old: *mut c_void,
            old_len: *mut usize,
            new: *mut c_void,
            new_len: usize,
        ) -> i32;
    }
    let mut value: i32 = 0;
    let mut length = std::mem::size_of::<i32>();
    // SAFETY: immutable NUL-terminated name, initialized scalar output with an
    // exact in/out byte count, and null new-value pointer make this read-only.
    let result = unsafe {
        sysctlbyname(
            c"kern.memorystatus_vm_pressure_level".as_ptr(),
            (&mut value as *mut i32).cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 || length != std::mem::size_of::<i32>() {
        return None;
    }
    match value {
        1 => Some(MemoryPressure::Normal),
        2 => Some(MemoryPressure::Warning),
        4 => Some(MemoryPressure::Critical),
        _ => None,
    }
}
#[cfg(not(target_os = "macos"))]
fn native_pressure() -> Option<MemoryPressure> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_pages_do_not_erase_reclaimable_headroom() {
        // Real 2026-10-27 04:23:16 UTC sample. The former sysinfo formula
        // (free + inactive + purgeable - compressor) saturated to zero.
        let observation = apple_availability(32 * GIB, 16_384, 163_558, 486_543, 695_555).unwrap();
        assert_eq!(observation.available_bytes, 10_651_254_784);
        assert_eq!(observation.compressed_bytes, 11_395_973_120);
        assert!(observation.compressed_bytes > observation.available_bytes);
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(observation.available_bytes),
                Some(MemoryPressure::Normal)
            )
            .action,
            PreviewAction::Allow
        );
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(observation.available_bytes),
                Some(MemoryPressure::Warning)
            )
            .action,
            PreviewAction::Pause
        );
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(observation.available_bytes),
                Some(MemoryPressure::Critical)
            )
            .action,
            PreviewAction::Release
        );
    }

    #[test]
    fn reclaimable_estimate_is_bounded_and_missing_observations_stay_unknown() {
        assert!(apple_availability(0, 16_384, 1, 2, 3).is_none());
        assert!(apple_availability(32 * GIB, 0, 1, 2, 3).is_none());
        assert!(apple_availability(32 * GIB, u64::MAX, 2, 1, 0).is_none());
        assert_eq!(
            apple_availability(GIB, 16_384, 100_000, 100_000, 1)
                .unwrap()
                .available_bytes,
            GIB
        );
        // The existing low-headroom and critical-pressure gates are unchanged.
        let low = apple_availability(32 * GIB, 16_384, 10_000, 10_000, 0).unwrap();
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(low.available_bytes),
                Some(MemoryPressure::Normal)
            )
            .action,
            PreviewAction::Release
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires real host metric access and METORIGIN_RESOURCE_EVIDENCE, optional METORIGIN_RESOURCE_PROJECT and METORIGIN_RESOURCE_APP_PID"]
    fn records_real_host_resource_observations() {
        let output = std::path::PathBuf::from(
            std::env::var_os("METORIGIN_RESOURCE_EVIDENCE").expect("evidence output"),
        );
        let project = std::env::var_os("METORIGIN_RESOURCE_PROJECT").map(std::path::PathBuf::from);
        let observed_pid = std::env::var("METORIGIN_RESOURCE_APP_PID")
            .ok()
            .map(|s| s.parse::<u32>().unwrap());
        let mut samples = Vec::new();
        for _ in 0..3 {
            let metrics = super::super::collect_resource_metrics(project.as_deref());
            assert!(
                metrics.memory_total_bytes > 0,
                "real physical memory must be measured"
            );
            assert_eq!(metrics.memory.kind, "unified");
            let external_processes = observed_pid.map(|pid| {
                let processes = System::new_all();
                serde_json::json!({"pid_present": processes.process(Pid::from_u32(pid)).is_some(),
                    "processes": process_memory(&processes,pid)})
            });
            samples.push(
                serde_json::json!({"metrics":metrics,"explicit_app_processes":external_processes}),
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(output)
            .unwrap();
        serde_json::to_writer_pretty(file,&serde_json::json!({
            "schema_version":1,"scope":"Current physical host observation only; not a 16 GB acceptance run. Default process observations describe the test collector unless an explicit app PID is supplied.",
            "rss_caveat":"RSS may include shared pages; values are never summed. Unattributed XPC WebKit processes are excluded.",
            "samples":samples
        })).unwrap();
    }

    #[test]
    fn pressure_stops_new_frames_before_releasing_current_model() {
        assert_eq!(
            preview_policy(true, 32 * GIB, Some(10 * GIB), Some(MemoryPressure::Normal)).action,
            PreviewAction::Allow
        );
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(10 * GIB),
                Some(MemoryPressure::Warning)
            )
            .action,
            PreviewAction::Pause
        );
        assert_eq!(
            preview_policy(
                true,
                32 * GIB,
                Some(10 * GIB),
                Some(MemoryPressure::Critical)
            )
            .action,
            PreviewAction::Release
        );
        assert_eq!(
            preview_policy(true, 32 * GIB, Some(2 * GIB), None).action,
            PreviewAction::Pause
        );
        assert_eq!(
            preview_policy(true, 32 * GIB, Some(100 * 1024 * 1024), None).action,
            PreviewAction::Release
        );
        assert_eq!(
            preview_policy(false, 32 * GIB, Some(0), Some(MemoryPressure::Critical)).action,
            PreviewAction::Allow
        );
    }
    #[test]
    fn unknown_metrics_remain_unknown_and_use_conservative_preview_bounds() {
        let policy = preview_policy(true, 0, None, None);
        assert_eq!(policy.memory_pressure, None);
        assert_eq!(policy.max_snapshot_bytes, 64 * 1024 * 1024);
        assert_eq!(policy.poll_interval_ms, 10_000);
        assert_eq!(
            preview_policy(true, 16 * GIB, Some(8 * GIB), Some(MemoryPressure::Normal))
                .poll_interval_ms,
            5_000
        );
        assert_eq!(
            preview_policy(true, 32 * GIB, Some(16 * GIB), Some(MemoryPressure::Normal))
                .poll_interval_ms,
            2_000
        );
    }
    #[test]
    fn runtime_summary_is_read_only_and_does_not_invent_missing_evidence() {
        let root = std::env::temp_dir().join(format!("resource-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir(&root).unwrap();
        assert!(runtime_summary(Some(&root)).unwrap().is_none());
        let profile = splat_domain::ExecutionProfile::from_json(include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../schemas/examples/execution-profile/macos.valid.json"
        )))
        .unwrap();
        splat_project::save_execution_profile(&root, &profile).unwrap();
        std::fs::write(
            root.join("project.json"),
            b"{\"settings\":{\"preset\":\"quality\"}}",
        )
        .unwrap();
        let summary = runtime_summary(Some(&root)).unwrap().unwrap();
        assert_eq!(summary.requested_preset.as_deref(), Some("quality"));
        assert_eq!(summary.effective_training.iterations, 300);
        assert_eq!(summary.colmap_backend, "CPU");
        assert_eq!(summary.brush_backend, "Metal");
        std::fs::remove_dir_all(root).unwrap();
    }
}
