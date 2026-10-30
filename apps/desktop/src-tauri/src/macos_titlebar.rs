//! Keep AppKit's real window buttons on the 48-point desktop header centerline.
//!
//! Tao/Wry's traffic-light inset only resizes the titlebar container; AppKit can
//! lay its buttons back out at the default top inset. Position the actual button
//! frames after layout instead, with no competing `trafficLightPosition` config.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowDidUpdateNotification, NSWindowStyleMask};
use objc2_foundation::{NSNotificationCenter, NSObjectProtocol, NSPoint};
use tauri::Manager;

// Matches DesktopTitlebar's h-12 at the application's 16px base size.
const HEADER_HEIGHT: f64 = 48.0;

thread_local! {
    static UPDATE_OBSERVER: std::cell::RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { std::cell::RefCell::new(None) };
}

pub(crate) fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let generation = Arc::new(AtomicU64::new(0));
    install_update_observer(&window, &generation);
    schedule_alignment(&window, &generation);
    let observed = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            // Cancel queued work before a detached WKWebView loses its window.
            generation.store(u64::MAX, Ordering::Relaxed);
            DispatchQueue::main().exec_async(remove_update_observer);
            return;
        }
        if matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(_)
                | tauri::WindowEvent::ThemeChanged(_)
        ) {
            schedule_alignment(&observed, &generation);
        }
    });
}

fn install_update_observer(window: &tauri::WebviewWindow, generation: &Arc<AtomicU64>) {
    let Some(_main_thread) = MainThreadMarker::new() else {
        return;
    };
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    // SAFETY: Tauri's setup supplies its live NSWindow on the main thread.
    let Some(native) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
        return;
    };
    let observed = window.clone();
    let generation = Arc::clone(generation);
    let block = RcBlock::new(move |_| {
        if generation.load(Ordering::Relaxed) != u64::MAX && needs_alignment(&observed) {
            schedule_alignment(&observed, &generation);
        }
    });
    // AppKit may re-layout standard buttons after Tauri's resize/focus event.
    // Observe this window's completed native updates, rather than polling.
    // SAFETY: The object is an NSWindow, the block only captures Send handles,
    // and it only schedules work; actual AppKit access stays on the main queue.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidUpdateNotification),
            Some(native),
            None,
            &block,
        )
    };
    UPDATE_OBSERVER.with(|slot| *slot.borrow_mut() = Some(observer));
}

fn remove_update_observer() {
    UPDATE_OBSERVER.with(|slot| {
        if let Some(observer) = slot.borrow_mut().take() {
            // SAFETY: This token was returned by this notification center.
            let token: &objc2::runtime::AnyObject = (*observer).as_ref();
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(token) };
        }
    });
}

fn schedule_alignment(window: &tauri::WebviewWindow, generation: &Arc<AtomicU64>) {
    let Ok(previous) = generation.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        value.checked_add(1)
    }) else {
        return; // Destroyed is a permanent terminal state, including notifications.
    };
    let current = previous + 1;
    let generation = Arc::clone(generation);
    let window = window.clone();
    // A main queue async block really defers; Tauri's run_on_main_thread may
    // execute immediately when called from a main-thread window event.
    DispatchQueue::main().exec_async(move || {
        if generation.load(Ordering::Relaxed) != current {
            return;
        }
        align_buttons(&window);
        #[cfg(debug_assertions)]
        schedule_debug_readback(window, generation, current);
    });
}

fn needs_alignment(window: &tauri::WebviewWindow) -> bool {
    let Some(_main_thread) = MainThreadMarker::new() else {
        return false;
    };
    let Ok(pointer) = window.ns_window() else {
        return false;
    };
    // SAFETY: Called on AppKit's main thread, never after our Destroyed guard.
    let Some(native) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
        return false;
    };
    if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return false;
    }
    let Some(content) = native.contentView() else {
        return false;
    };
    let bounds = content.bounds();
    let target = center_from_top(bounds.origin.y, bounds.size.height, content.isFlipped());
    [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .filter_map(|kind| native.standardWindowButton(kind))
    .any(|button| {
        let rect = button.convertRect_toView(button.bounds(), Some(&content));
        (rect.origin.y + rect.size.height / 2.0 - target).abs() > 0.01
    })
}

/// Opt-in build-time diagnostic for native layout regressions. Read the actual
/// frames after a quiet second, independently of the positioning calculation.
#[cfg(debug_assertions)]
fn schedule_debug_readback(window: tauri::WebviewWindow, generation: Arc<AtomicU64>, current: u64) {
    let Some(directory) = option_env!("METORIGIN_TITLEBAR_AUDIT_DIR") else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        DispatchQueue::main().exec_async(move || {
            if generation.load(Ordering::Relaxed) != current {
                return;
            }
            let Some(_main_thread) = MainThreadMarker::new() else {
                return;
            };
            let Ok(pointer) = window.ns_window() else {
                return;
            };
            // SAFETY: Same main-thread, live-window boundary as align_buttons.
            let Some(native) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
                return;
            };
            let Some(content) = native.contentView() else {
                return;
            };
            let bounds = content.bounds();
            let buttons: Vec<_> = [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ]
            .into_iter()
            .filter_map(|kind| {
                let button = native.standardWindowButton(kind)?;
                let rect = button.convertRect_toView(button.bounds(), Some(&content));
                let center_y = rect.origin.y + rect.size.height / 2.0;
                let from_top = if content.isFlipped() {
                    center_y - bounds.origin.y
                } else {
                    bounds.origin.y + bounds.size.height - center_y
                };
                // SAFETY: Read-only traversal of this live button's ancestors.
                let mut parent = unsafe { button.superview() };
                let mut ancestors = Vec::new();
                while let Some(view) = parent {
                    let frame = view.frame();
                    ancestors
                        .push(serde_json::json!({"y":frame.origin.y,"height":frame.size.height}));
                    if ancestors.len() == 8 {
                        break;
                    }
                    parent = unsafe { view.superview() };
                }
                Some(serde_json::json!({
                    "center_from_content_top": from_top,
                    "center_x": rect.origin.x + rect.size.width / 2.0,
                    "width": rect.size.width,
                    "height": rect.size.height,
                    "hidden": button.isHidden(),
                    "ancestors": ancestors,
                }))
            })
            .collect();
            let receipt = serde_json::json!({
                "pid": std::process::id(),
                "generation": current,
                "delay_ms": 1000,
                "window_width": native.frame().size.width,
                "window_height": native.frame().size.height,
                "content_height": bounds.size.height,
                "fullscreen": native.styleMask().contains(NSWindowStyleMask::FullScreen),
                "buttons": buttons,
            });
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::path::Path::new(directory).join("native-geometry.jsonl"))
            {
                let _ = writeln!(file, "{receipt}");
            }
        });
    });
}

fn align_buttons(window: &tauri::WebviewWindow) {
    let Some(_main_thread) = MainThreadMarker::new() else {
        return;
    };
    let Ok(pointer) = window.ns_window() else {
        return;
    };
    // SAFETY: Tauri supplies its live NSWindow, and this callback only runs on
    // AppKit's main thread. No native pointer is stored or sent across threads.
    let Some(native) = (unsafe { pointer.cast::<NSWindow>().as_ref() }) else {
        return;
    };
    // Fullscreen traffic lights belong to the system's revealable titlebar.
    if native.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }
    let Some(content) = native.contentView() else {
        return;
    };
    let bounds = content.bounds();
    // Convert through each button's actual parent. The AppKit titlebar ancestor
    // hierarchy varies by OS version; do not resize an assumed two-level parent.
    let target_y = center_from_top(bounds.origin.y, bounds.size.height, content.isFlipped());
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        let Some(button) = native.standardWindowButton(kind) else {
            continue;
        };
        // SAFETY: The standard button remains attached to its AppKit superview.
        let Some(parent) = (unsafe { button.superview() }) else {
            continue;
        };
        let button_bounds = button.bounds();
        let mut target = button.convertPoint_toView(
            NSPoint::new(
                button_bounds.origin.x + button_bounds.size.width / 2.0,
                button_bounds.origin.y + button_bounds.size.height / 2.0,
            ),
            Some(&content),
        );
        target.y = target_y;
        let center = parent.convertPoint_fromView(target, Some(&content));
        let mut button_frame = button.frame();
        button_frame.origin.y = center.y - button_frame.size.height / 2.0;
        // Preserve AppKit's horizontal positions, sizes, hit regions and actions.
        if (button.frame().origin.y - button_frame.origin.y).abs() > 0.01 {
            button.setFrameOrigin(button_frame.origin);
        }
    }
}

fn center_from_top(origin_y: f64, height: f64, flipped: bool) -> f64 {
    if flipped {
        origin_y + HEADER_HEIGHT / 2.0
    } else {
        origin_y + height - HEADER_HEIGHT / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_center_uses_content_coordinates_in_both_view_orientations() {
        assert_eq!(center_from_top(0.0, 885.0, false), 861.0);
        assert_eq!(center_from_top(0.0, 885.0, true), 24.0);
        assert_eq!(center_from_top(10.0, 768.0, false), 754.0);
        assert_eq!(center_from_top(10.0, 768.0, true), 34.0);
    }
}
