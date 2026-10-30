//! A run-scoped macOS idle-sleep assertion. This never changes system settings.
//!
//! Hold the returned guard inside the background pipeline future. Completion,
//! failure, cancellation and task abortion then release the assertion by drop.
//! The setting must be explicit and default to false. The assertion allows the
//! display to sleep and does not prevent lid-close, user-requested or low-battery
//! sleep. Non-macOS hosts return `None` without calling a platform API.

#[must_use = "Keep the guard alive until the pipeline task ends"]
pub(crate) struct MacosActivityGuard {
    assertion_id: Option<u32>,
    release: fn(u32) -> Result<(), String>,
}

impl MacosActivityGuard {
    pub(crate) fn acquire(enabled: bool) -> Result<Option<Self>, String> {
        #[cfg(target_os = "macos")]
        {
            Self::acquire_with(enabled, platform::create, platform::release)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = enabled;
            Ok(None)
        }
    }

    #[cfg(any(target_os = "macos", test))]
    fn acquire_with(
        enabled: bool,
        create: impl FnOnce() -> Result<u32, String>,
        release: fn(u32) -> Result<(), String>,
    ) -> Result<Option<Self>, String> {
        if !enabled {
            return Ok(None);
        }
        Ok(Some(Self {
            assertion_id: Some(create()?),
            release,
        }))
    }
}

impl Drop for MacosActivityGuard {
    fn drop(&mut self) {
        // Taking the ID first guarantees one release attempt, including on errors.
        if let Some(id) = self.assertion_id.take() {
            if let Err(error) = (self.release)(id) {
                // Drop cannot report an error to the completed task. Keep the
                // diagnostic; macOS also removes assertions when the owner exits.
                eprintln!("Unable to release MetOrigin idle-sleep assertion: {error}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr::NonNull;

    const UTF8: u32 = 0x0800_0100;
    const ASSERTION_LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: *const c_void,
            level: u32,
            name: *const c_void,
            assertion_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion_id: u32) -> i32;
        #[cfg(test)]
        fn IOPMAssertionCopyProperties(assertion_id: u32) -> *const c_void;
    }

    struct OwnedCfString(NonNull<c_void>);

    impl OwnedCfString {
        fn new(text: &CStr) -> Result<Self, String> {
            // SAFETY: NUL-terminated static text, valid UTF-8 encoding identifier,
            // and the default CF allocator. Create returns an owned reference.
            let value = unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) };
            NonNull::new(value.cast_mut())
                .map(Self)
                .ok_or_else(|| "macOS could not allocate an activity assertion string".into())
        }

        fn as_ptr(&self) -> *const c_void {
            self.0.as_ptr().cast_const()
        }
    }

    impl Drop for OwnedCfString {
        fn drop(&mut self) {
            // SAFETY: The Create-rule reference is owned and released once here.
            unsafe { CFRelease(self.as_ptr()) };
        }
    }

    pub(super) fn create() -> Result<u32, String> {
        // IOPMLib.h: permits display sleep and user/lid/low-battery sleep. This
        // assertion only prevents automatic system sleep due to user inactivity.
        let kind = OwnedCfString::new(c"PreventUserIdleSystemSleep")?;
        let reason = OwnedCfString::new(c"MetOrigin Gaussian generation")?;
        let mut id = 0;
        // SAFETY: Both CFStrings outlive this call; id is a valid output pointer.
        let status = unsafe {
            IOPMAssertionCreateWithName(kind.as_ptr(), ASSERTION_LEVEL_ON, reason.as_ptr(), &mut id)
        };
        if status != 0 {
            return Err(format!(
                "macOS could not prevent idle sleep (IOKit 0x{:08x})",
                status as u32
            ));
        }
        Ok(id)
    }

    pub(super) fn release(id: u32) -> Result<(), String> {
        // SAFETY: The guard owns this process-local ID from a successful Create.
        let status = unsafe { IOPMAssertionRelease(id) };
        if status == 0 {
            Ok(())
        } else {
            Err(format!("IOKit 0x{:08x}", status as u32))
        }
    }

    #[cfg(test)]
    pub(super) fn exists(id: u32) -> bool {
        // SAFETY: CopyProperties accepts an assertion ID; a null result means the
        // ID is no longer active. A returned dictionary follows the Copy rule.
        let properties = unsafe { IOPMAssertionCopyProperties(id) };
        if properties.is_null() {
            false
        } else {
            unsafe { CFRelease(properties) };
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::MacosActivityGuard;
    use std::cell::{Cell, RefCell};

    thread_local! {
        static RELEASED: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    }

    fn release(id: u32) -> Result<(), String> {
        RELEASED.with(|calls| calls.borrow_mut().push(id));
        Ok(())
    }

    fn released() -> Vec<u32> {
        RELEASED.with(|calls| std::mem::take(&mut *calls.borrow_mut()))
    }

    #[test]
    fn disabled_option_makes_no_platform_calls() {
        let guard = MacosActivityGuard::acquire_with(
            false,
            || panic!("disabled setting must not acquire an assertion"),
            release,
        )
        .unwrap();
        assert!(guard.is_none());
        assert!(released().is_empty());
        assert!(MacosActivityGuard::acquire(false).unwrap().is_none());
    }

    #[test]
    fn scope_exit_releases_exactly_once() {
        let creates = Cell::new(0);
        {
            let _guard = MacosActivityGuard::acquire_with(
                true,
                || {
                    creates.set(creates.get() + 1);
                    Ok(42)
                },
                release,
            )
            .unwrap();
            assert_eq!(creates.get(), 1);
            assert!(released().is_empty());
        }
        assert_eq!(released(), vec![42]);
        assert!(released().is_empty());
    }

    #[test]
    fn failed_acquisition_does_not_release_an_unowned_id() {
        let result = MacosActivityGuard::acquire_with(true, || Err("denied".into()), release);
        assert!(matches!(result, Err(error) if error == "denied"));
        assert!(released().is_empty());
    }

    #[test]
    fn early_error_releases_the_guard() {
        fn task() -> Result<(), String> {
            let _guard = MacosActivityGuard::acquire_with(true, || Ok(43), release)?;
            Err("pipeline failed".into())
        }
        assert!(task().is_err());
        assert_eq!(released(), vec![43]);
    }

    #[test]
    fn unwinding_releases_the_guard() {
        let result = std::panic::catch_unwind(|| {
            let _guard = MacosActivityGuard::acquire_with(true, || Ok(44), release).unwrap();
            panic!("pipeline panic");
        });
        assert!(result.is_err());
        assert_eq!(released(), vec![44]);
    }

    #[test]
    fn dropping_a_pending_pipeline_future_releases_the_guard() {
        use std::future::Future;
        use std::task::{Context, Poll, Waker};
        let mut task = Box::pin(async {
            let _guard = MacosActivityGuard::acquire_with(true, || Ok(46), release).unwrap();
            std::future::pending::<()>().await;
        });
        let mut context = Context::from_waker(Waker::noop());
        assert_eq!(task.as_mut().poll(&mut context), Poll::Pending);
        assert!(released().is_empty());
        drop(task);
        assert_eq!(released(), vec![46]);
    }

    #[test]
    fn release_failure_does_not_panic_or_double_release() {
        fn failed_release(id: u32) -> Result<(), String> {
            release(id)?;
            Err("release failed".into())
        }
        let guard = MacosActivityGuard::acquire_with(true, || Ok(45), failed_release).unwrap();
        drop(guard);
        assert_eq!(released(), vec![45]);
    }

    #[test]
    fn guard_can_move_with_a_background_future() {
        fn assert_send<T: Send>() {}
        assert_send::<MacosActivityGuard>();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "creates and immediately releases one real idle-sleep assertion; never sleeps the system"]
    fn actual_macos_assertion_is_removed_on_drop() {
        let guard = MacosActivityGuard::acquire(true)
            .unwrap()
            .expect("macOS guard");
        let id = guard.assertion_id.unwrap();
        assert!(super::platform::exists(id));
        drop(guard);
        assert!(!super::platform::exists(id));
    }
}
