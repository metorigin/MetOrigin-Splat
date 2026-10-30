//! AppKit's native `terminate:` path bypasses Tauri's RequestExit event.
//!
//! Muda's predefined Quit item (including Cmd-Q) and the Dock use that path.
//! Tao 0.35's delegate implements applicationWillTerminate but does not provide
//! applicationShouldTerminate. Add the veto at that native delegate boundary,
//! retaining its existing launch/reopen/window behavior and delegate identity.
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

use tauri::Manager;

use super::{request_safe_exit, ExitState};

type Object = *mut c_void;
type Selector = *mut c_void;
type Implementation = unsafe extern "C" fn();

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Object;
    fn objc_retain(object: Object) -> Object;
    fn objc_release(object: Object);
    fn object_getClass(object: Object) -> Object;
    fn sel_registerName(name: *const c_char) -> Selector;
    fn class_getInstanceMethod(class: Object, selector: Selector) -> Object;
    fn class_addMethod(
        class: Object,
        selector: Selector,
        implementation: Implementation,
        types: *const c_char,
    ) -> bool;
    fn objc_msgSend();
}

/// Install once from Tauri setup, on AppKit's main thread and before admitting
/// any user work. Fail startup if this runtime already supplies a termination
/// method; do not silently replace an unknown platform delegate implementation.
pub(super) fn install(app: &tauri::AppHandle) -> Result<(), String> {
    // SAFETY: AppKit is initialized by Tauri before setup. Both messages take no
    // explicit arguments and return Objective-C objects. The existing delegate
    // receives a temporary retain while refreshing AppKit's delegate cache.
    unsafe {
        let send: unsafe extern "C" fn(Object, Selector) -> Object =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let application_class = objc_getClass(c"NSApplication".as_ptr());
        if application_class.is_null() {
            return Err("无法安装 macOS 安全退出保护：NSApplication 不可用。".into());
        }
        let application = send(
            application_class,
            sel_registerName(c"sharedApplication".as_ptr()),
        );
        let delegate = send(application, sel_registerName(c"delegate".as_ptr()));
        if delegate.is_null() {
            return Err("无法安装 macOS 安全退出保护：应用代理不可用。".into());
        }
        let class = object_getClass(delegate);
        let selector = sel_registerName(c"applicationShouldTerminate:".as_ptr());
        if !class_getInstanceMethod(class, selector).is_null() {
            return Err("macOS 运行时的退出代理已变化，请更新安全退出集成。".into());
        }
        APP.set(app.clone())
            .map_err(|_| "macOS 退出保护已初始化。".to_string())?;
        // NSApplicationTerminateReply is NSUInteger: Q on 64-bit macOS.
        // The arguments are the receiver, selector, and NSApplication object.
        let implementation = std::mem::transmute::<
            extern "C" fn(Object, Selector, Object) -> usize,
            Implementation,
        >(should_terminate);
        if !class_addMethod(class, selector, implementation, c"Q@:@".as_ptr()) {
            return Err("无法注册 macOS 安全退出回调。".into());
        }
        // AppKit may cache optional delegate selectors when setDelegate: runs.
        // Tao set the delegate before setup, so refresh those flags after adding
        // the method. Keep the exact same instance alive throughout this change.
        let set_delegate: unsafe extern "C" fn(Object, Selector, Object) =
            std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
        let set_delegate_selector = sel_registerName(c"setDelegate:".as_ptr());
        objc_retain(delegate);
        set_delegate(application, set_delegate_selector, std::ptr::null_mut());
        set_delegate(application, set_delegate_selector, delegate);
        objc_release(delegate);
    }
    Ok(())
}

fn termination_reply(allowed: bool, request: impl FnOnce()) -> usize {
    if allowed {
        1 // NSTerminateNow
    } else {
        request();
        0 // NSTerminateCancel; successful async cleanup calls AppHandle::exit.
    }
}

extern "C" fn should_terminate(_: Object, _: Selector, _: Object) -> usize {
    // Never unwind over the Objective-C ABI. If dispatch fails, keep the app
    // alive instead of allowing AppKit to orphan engines or lose editor work.
    catch_unwind(AssertUnwindSafe(|| {
        let Some(app) = APP.get() else { return 0 };
        let allowed = app
            .state::<ExitState>()
            .allowed
            .load(std::sync::atomic::Ordering::SeqCst);
        termination_reply(allowed, || request_safe_exit(app))
    }))
    .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn native_termination_is_cancelled_until_cleanup_authorizes_exit() {
        let requests = AtomicUsize::new(0);
        for _ in 0..3 {
            assert_eq!(
                termination_reply(false, || {
                    requests.fetch_add(1, Ordering::SeqCst);
                }),
                0
            );
        }
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        assert_eq!(
            termination_reply(true, || panic!(
                "authorized exit must not request cleanup again"
            )),
            1
        );
    }
}
