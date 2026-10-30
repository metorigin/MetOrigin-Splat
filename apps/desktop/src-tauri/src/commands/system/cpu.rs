//! macOS CPU usage needs two observations from the same sysinfo instance.
//! Keep this CPU-only state separate from the fresh memory/process snapshot.

use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use sysinfo::{System, MINIMUM_CPU_UPDATE_INTERVAL};

struct CpuSampler {
    system: System,
    interval: CpuInterval,
}

#[derive(Default)]
struct CpuInterval {
    last_refresh: Option<Instant>,
    baseline_ready: bool,
    last_percent: Option<f32>,
}

struct CpuReading {
    sampled_at: Instant,
    percent: Option<f32>,
}

impl CpuInterval {
    fn sample(&mut self, now: Instant, refresh: impl FnOnce() -> CpuReading) -> Option<f32> {
        if self.last_refresh.is_some_and(|previous| {
            now.checked_duration_since(previous)
                .is_none_or(|elapsed| elapsed <= MINIMUM_CPU_UPDATE_INTERVAL)
        }) {
            return self.last_percent;
        }

        let had_baseline = self.baseline_ready;
        let reading = refresh();
        // sysinfo 0.33.1/apple/cpu.rs requires strictly more than 200 ms since
        // its internal refresh. Record our time AFTER that operation, not before.
        self.last_refresh = Some(reading.sampled_at);
        let percent = reading
            .percent
            .filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
        self.baseline_ready = percent.is_some();
        // A new macOS sysinfo instance returns the ratio of cumulative ticks.
        // Discard that first value; only a later delta is an interval observation.
        self.last_percent = if had_baseline { percent } else { None };
        self.last_percent
    }
}

pub(super) fn observe_cpu_usage() -> Option<f32> {
    static SAMPLER: OnceLock<Mutex<CpuSampler>> = OnceLock::new();
    let sampler = SAMPLER.get_or_init(|| {
        Mutex::new(CpuSampler {
            system: System::new(),
            interval: CpuInterval::default(),
        })
    });
    let mut sampler = sampler.lock().ok()?;
    let CpuSampler { system, interval } = &mut *sampler;
    interval.sample(Instant::now(), || {
        system.refresh_cpu_usage();
        CpuReading {
            sampled_at: Instant::now(),
            percent: (!system.cpus().is_empty()).then(|| system.global_cpu_usage()),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn reading(sampled_at: Instant, percent: Option<f32>) -> CpuReading {
        CpuReading {
            sampled_at,
            percent,
        }
    }

    #[test]
    fn first_observation_establishes_baseline_without_publishing_cumulative_usage() {
        let mut interval = CpuInterval::default();
        let now = Instant::now();
        let mut refreshes = 0;
        assert_eq!(
            interval.sample(now, || {
                refreshes += 1;
                reading(now, Some(15.0))
            }),
            None
        );
        assert_eq!(refreshes, 1);
        assert!(interval.baseline_ready);
    }

    #[test]
    fn refresh_requires_strict_minimum_interval_and_reuses_last_valid_value() {
        let mut interval = CpuInterval::default();
        let start = Instant::now();
        assert_eq!(interval.sample(start, || reading(start, Some(15.0))), None);
        for elapsed in [Duration::ZERO, MINIMUM_CPU_UPDATE_INTERVAL] {
            assert_eq!(
                interval.sample(start + elapsed, || panic!("refreshed too soon")),
                None
            );
        }
        let next = start + MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_nanos(1);
        assert_eq!(
            interval.sample(next, || reading(next, Some(72.0))),
            Some(72.0)
        );
        for elapsed in [Duration::ZERO, MINIMUM_CPU_UPDATE_INTERVAL] {
            assert_eq!(
                interval.sample(next + elapsed, || panic!("refreshed cached interval")),
                Some(72.0)
            );
        }
    }

    #[test]
    fn consecutive_intervals_publish_new_values_including_real_zero() {
        let mut interval = CpuInterval::default();
        let start = Instant::now();
        let step = MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_millis(1);
        let mut refreshes = 0;
        for (index, (observed, expected)) in [
            (15.0, None),
            (80.0, Some(80.0)),
            (0.0, Some(0.0)),
            (23.5, Some(23.5)),
        ]
        .into_iter()
        .enumerate()
        {
            let now = start + step * index as u32;
            assert_eq!(
                interval.sample(now, || {
                    refreshes += 1;
                    reading(now, Some(observed))
                }),
                expected
            );
        }
        assert_eq!(refreshes, 4);
    }

    #[test]
    fn minimum_interval_is_measured_after_refresh_finishes() {
        let mut interval = CpuInterval::default();
        let start = Instant::now();
        let finished = start + Duration::from_millis(50);
        assert_eq!(
            interval.sample(start, || reading(finished, Some(15.0))),
            None
        );
        assert_eq!(
            interval.sample(finished + MINIMUM_CPU_UPDATE_INTERVAL, || {
                panic!("refresh time incorrectly counted as part of interval")
            }),
            None
        );
        let next = finished + MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_nanos(1);
        assert_eq!(
            interval.sample(next, || reading(next, Some(40.0))),
            Some(40.0)
        );
    }

    #[test]
    fn unavailable_or_invalid_observations_require_a_new_baseline() {
        let start = Instant::now();
        let step = MINIMUM_CPU_UPDATE_INTERVAL + Duration::from_millis(1);
        for unavailable in [
            None,
            Some(f32::NAN),
            Some(f32::INFINITY),
            Some(-1.0),
            Some(101.0),
        ] {
            let mut interval = CpuInterval::default();
            assert_eq!(interval.sample(start, || reading(start, Some(15.0))), None);
            let valid = start + step;
            assert_eq!(
                interval.sample(valid, || reading(valid, Some(20.0))),
                Some(20.0)
            );
            let failed = valid + step;
            assert_eq!(
                interval.sample(failed, || reading(failed, unavailable)),
                None
            );
            let baseline = failed + step;
            assert_eq!(
                interval.sample(baseline, || reading(baseline, Some(30.0))),
                None
            );
            let recovered = baseline + step;
            assert_eq!(
                interval.sample(recovered, || reading(recovered, Some(0.0))),
                Some(0.0)
            );
        }
    }
}
