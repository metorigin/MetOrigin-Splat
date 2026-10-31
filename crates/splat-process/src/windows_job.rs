//! Per-engine kernel ownership. The job handle is never inherited by children:
//! Windows closes the last owner handle on application termination, including
//! forced termination, and kills every process still inside this unnamed job.
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};

use tokio::process::Child;
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetProcessIdOfThread, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME,
};

pub(crate) const OWNED_CREATION_FLAGS: u32 = CREATE_NO_WINDOW | CREATE_SUSPENDED;

#[derive(Debug)]
pub(crate) struct WindowsJob {
    handle: OwnedHandle,
}

impl WindowsJob {
    pub(crate) fn new() -> io::Result<Self> {
        // SAFETY: null security/name creates an unnamed non-inheritable job.
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObject returned one new owned kernel handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // No breakaway flag is allowed. Ordinary CreateProcess descendants must
        // remain owned even when the immediate engine leader exits first.
        // SAFETY: handle is live and the initialized C struct matches its class.
        if unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    /// The child must have been created suspended. It cannot execute user code
    /// or launch descendants until assignment succeeds and this resumes it.
    pub(crate) fn assign_and_resume(&self, child: &Child) -> io::Result<()> {
        self.assign_and_resume_using(child, |job, process| {
            // SAFETY: both handles remain owned/live; the child is suspended.
            if unsafe { AssignProcessToJobObject(job, process) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        })
    }

    fn assign_and_resume_using(
        &self,
        child: &Child,
        assign: impl FnOnce(*mut std::ffi::c_void, *mut std::ffi::c_void) -> io::Result<()>,
    ) -> io::Result<()> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("Suspended child has exited"))?;
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Suspended child handle is unavailable"))?;
        let thread = suspended_primary_thread(pid)?;
        assign(self.handle.as_raw_handle(), process)?;
        // SAFETY: OpenThread captured the sole suspended thread of this child;
        // GetProcessIdOfThread verified it while the child handle stayed live.
        let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
        if previous != 1 {
            return Err(if previous == u32::MAX {
                io::Error::last_os_error()
            } else {
                io::Error::other("Unexpected primary-thread suspension count")
            });
        }
        Ok(())
    }

    fn active_processes(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: output has the exact initialized ABI/size for this class.
        if unsafe {
            QueryInformationJobObject(
                self.handle.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    pub(crate) async fn terminate(&self) -> Result<(), String> {
        if self.active_processes().map_err(|error| error.to_string())? == 0 {
            return Ok(());
        }
        // SAFETY: the job object identifies only this engine and its children;
        // it never targets a PID that the OS could have reused after reaping.
        if unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) } == 0 {
            let error = io::Error::last_os_error();
            if self.active_processes().map_err(|error| error.to_string())? != 0 {
                return Err(error.to_string());
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if self.active_processes().map_err(|error| error.to_string())? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "Owned Windows job still has active processes after termination".into(),
                );
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

#[cfg(test)]
mod tests;

fn suspended_primary_thread(pid: u32) -> io::Result<OwnedHandle> {
    // Stable Rust cannot expose PROCESS_INFORMATION.hThread yet. Documented
    // ToolHelp APIs recover it while CREATE_SUSPENDED prevents child execution.
    // SAFETY: thread snapshot does not dereference application memory.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful snapshot creates one independently owned handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut threads = Vec::new();
    // SAFETY: entry has the required size and remains valid for enumeration.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            threads.push(entry.th32ThreadID);
        }
        // SAFETY: the snapshot and initialized entry are still live.
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
        return Err(error);
    }
    if threads.len() != 1 {
        return Err(io::Error::other(
            "Suspended child does not have exactly one primary thread",
        ));
    }
    // SAFETY: requesting only resume/query rights, with inheritance disabled.
    let raw = unsafe {
        OpenThread(
            THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
            0,
            threads[0],
        )
    };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenThread returned an independently owned handle.
    let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: query uses the captured thread handle, never an unverified TID.
    if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
        return Err(io::Error::other(
            "Primary-thread ownership changed before resume",
        ));
    }
    Ok(thread)
}
