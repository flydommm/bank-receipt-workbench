//! Shared, bounded process ownership for the Tauri host.
//!
//! The Windows implementation deliberately uses `CreateProcessW` with an
//! extended startup attribute list.  A per-process Job is attached as part of
//! process creation, so there is no suspended-process window in which a host
//! crash could leave an unassigned child behind.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct ProcessSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, Option<OsString>)>,
    pub cwd: Option<PathBuf>,
    pub pipe_stderr: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProcessExit {
    pub code: u32,
}

impl ProcessExit {
    pub fn success(self) -> bool {
        self.code == 0
    }
}

#[derive(Clone)]
pub struct ProcessSupervisor {
    shared: Arc<SupervisorShared>,
}

struct SupervisorShared {
    state: Mutex<SupervisorState>,
    wake: Condvar,
    max_processes: usize,
    max_waiters: usize,
}

struct SupervisorState {
    active: usize,
    waiters: usize,
    shutting_down: bool,
    registry: Vec<Weak<ProcessInner>>,
}

struct PermitToken {
    supervisor: Weak<SupervisorShared>,
}

impl Drop for PermitToken {
    fn drop(&mut self) {
        let Some(supervisor) = self.supervisor.upgrade() else {
            return;
        };
        let lock_result = supervisor.state.lock();
        if let Ok(mut state) = lock_result {
            if state.active > 0 {
                state.active -= 1;
            }
            supervisor.wake.notify_all();
        }
    }
}

struct ResourceLease {
    _inner: Arc<ProcessInner>,
    resources: AtomicUsize,
    permit: Mutex<Option<PermitToken>>,
}

impl ResourceLease {
    fn new(inner: Arc<ProcessInner>, permit: PermitToken) -> Self {
        Self {
            _inner: inner,
            resources: AtomicUsize::new(1),
            permit: Mutex::new(Some(permit)),
        }
    }

    fn add_resource(&self) {
        self.resources.fetch_add(1, Ordering::Relaxed);
    }

    fn release_resource(&self) {
        if self.resources.fetch_sub(1, Ordering::AcqRel) == 1 {
            if let Ok(mut permit) = self.permit.lock() {
                permit.take();
            }
        }
    }
}

struct ResourceGuard {
    lease: Arc<ResourceLease>,
}

impl Drop for ResourceGuard {
    fn drop(&mut self) {
        self.lease.release_resource();
    }
}

struct LeaseReader {
    reader: Box<dyn Read + Send>,
    _guard: ResourceGuard,
}

impl Read for LeaseReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.reader.read(buffer)
    }
}

struct LeaseWriter {
    writer: Box<dyn Write + Send>,
    _guard: ResourceGuard,
}

impl Write for LeaseWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.writer.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

pub struct OwnedProcess {
    pub stdin: Option<Box<dyn Write + Send>>,
    pub stdout: Option<Box<dyn Read + Send>>,
    #[allow(dead_code)]
    pub stderr: Option<Box<dyn Read + Send>>,
    inner: Arc<ProcessInner>,
    lease: Arc<ResourceLease>,
    owner_released: AtomicBool,
}

impl fmt::Debug for OwnedProcess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OwnedProcess")
            .field("id", &self.id())
            .finish_non_exhaustive()
    }
}

impl OwnedProcess {
    pub fn id(&self) -> u32 {
        self.inner.id
    }

    pub fn try_wait(&self) -> io::Result<Option<ProcessExit>> {
        self.inner.try_wait()
    }

    pub fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<ProcessExit>> {
        self.inner.wait_timeout(timeout)
    }

    pub fn control(&self) -> ProcessControl {
        ProcessControl {
            inner: Arc::downgrade(&self.inner),
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if !self.owner_released.swap(true, Ordering::AcqRel) {
            // The process and its descendants must be stopped before the
            // owning handle is dropped.  A bounded wait keeps Drop safe even
            // when a child has misbehaved around its standard handles.
            let _ = self.inner.terminate_tree();
            let _ = self.inner.wait_timeout(Duration::from_secs(2));
            self.lease.release_resource();
        }
    }
}

#[derive(Clone)]
pub struct ProcessControl {
    inner: Weak<ProcessInner>,
}

impl ProcessControl {
    pub fn terminate_tree(&self) -> io::Result<()> {
        let Some(inner) = self.inner.upgrade() else {
            return Ok(());
        };
        inner.terminate_tree()
    }
}

struct ProcessInner {
    id: u32,
    state: PlatformState,
    exit: Mutex<Option<ProcessExit>>,
}

impl ProcessInner {
    fn try_wait(&self) -> io::Result<Option<ProcessExit>> {
        if let Some(exit) = self.cached_exit() {
            return Ok(Some(exit));
        }
        let result = platform::try_wait(&self.state)?;
        if let Some(exit) = result {
            self.cache_exit(exit);
        }
        Ok(result)
    }

    fn wait_timeout(&self, timeout: Duration) -> io::Result<Option<ProcessExit>> {
        if let Some(exit) = self.cached_exit() {
            return Ok(Some(exit));
        }
        let result = platform::wait_timeout(&self.state, timeout)?;
        if let Some(exit) = result {
            self.cache_exit(exit);
        }
        Ok(result)
    }

    fn terminate_tree(&self) -> io::Result<()> {
        platform::terminate_tree(&self.state)
    }

    fn cached_exit(&self) -> Option<ProcessExit> {
        self.exit.lock().ok().and_then(|exit| *exit)
    }

    fn cache_exit(&self, exit: ProcessExit) {
        if let Ok(mut cached) = self.exit.lock() {
            cached.get_or_insert(exit);
        }
    }
}

struct Spawned {
    id: u32,
    state: PlatformState,
    stdin: Option<Box<dyn Write + Send>>,
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
}

#[cfg(windows)]
type PlatformState = platform::State;

#[cfg(not(windows))]
type PlatformState = platform::State;

impl ProcessSupervisor {
    pub fn new(max_processes: usize, max_waiters: usize) -> Self {
        Self {
            shared: Arc::new(SupervisorShared {
                state: Mutex::new(SupervisorState {
                    active: 0,
                    waiters: 0,
                    shutting_down: false,
                    registry: Vec::new(),
                }),
                wake: Condvar::new(),
                max_processes: max_processes.max(1),
                max_waiters,
            }),
        }
    }

    pub fn spawn(&self, spec: ProcessSpec, wait_timeout: Duration) -> io::Result<OwnedProcess> {
        platform::validate_spec(&spec)?;

        let deadline = Instant::now().checked_add(wait_timeout);
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| io::Error::other("process supervisor lock poisoned"))?;
        let mut registered_waiter = false;

        loop {
            if state.shutting_down {
                if registered_waiter {
                    state.waiters = state.waiters.saturating_sub(1);
                }
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "process supervisor is shut down",
                ));
            }
            if state.active < self.shared.max_processes {
                state.active += 1;
                if registered_waiter {
                    state.waiters = state.waiters.saturating_sub(1);
                }
                break;
            }
            if !registered_waiter {
                if state.waiters >= self.shared.max_waiters {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "process supervisor waiter limit reached",
                    ));
                }
                state.waiters += 1;
                registered_waiter = true;
            }

            let Some(deadline) = deadline else {
                state.waiters = state.waiters.saturating_sub(1);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "process supervisor wait deadline overflowed",
                ));
            };
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                state.waiters = state.waiters.saturating_sub(1);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for a process slot",
                ));
            };
            let (next_state, timed_out) = self
                .shared
                .wake
                .wait_timeout(state, remaining)
                .map_err(|_| io::Error::other("process supervisor lock poisoned"))?;
            state = next_state;
            if timed_out.timed_out() && state.active >= self.shared.max_processes {
                state.waiters = state.waiters.saturating_sub(1);
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for a process slot",
                ));
            }
        }

        // Keep the supervisor lock through the OS creation and registry
        // insertion.  shutdown() therefore cannot close an empty Job between
        // reservation and the process becoming owned by this supervisor.
        let spawned = match platform::spawn(spec) {
            Ok(spawned) => spawned,
            Err(error) => {
                state.active = state.active.saturating_sub(1);
                self.shared.wake.notify_all();
                return Err(error);
            }
        };
        let Spawned {
            id,
            state: platform_state,
            stdin,
            stdout,
            stderr,
        } = spawned;
        let inner = Arc::new(ProcessInner {
            id,
            state: platform_state,
            exit: Mutex::new(None),
        });
        state.registry.retain(|process| process.strong_count() > 0);
        state.registry.push(Arc::downgrade(&inner));
        let permit = PermitToken {
            supervisor: Arc::downgrade(&self.shared),
        };
        drop(state);

        let lease = Arc::new(ResourceLease::new(inner.clone(), permit));
        Ok(OwnedProcess {
            stdin: stdin.map(|pipe| attach_writer(pipe, &lease)),
            stdout: stdout.map(|pipe| attach_reader(pipe, &lease)),
            stderr: stderr.map(|pipe| attach_reader(pipe, &lease)),
            inner,
            lease,
            owner_released: AtomicBool::new(false),
        })
    }

    pub fn shutdown(&self) {
        let processes = {
            let Ok(mut state) = self.shared.state.lock() else {
                return;
            };
            state.shutting_down = true;
            state.registry.retain(|process| process.strong_count() > 0);
            let processes = state
                .registry
                .iter()
                .filter_map(Weak::upgrade)
                .collect::<Vec<_>>();
            self.shared.wake.notify_all();
            processes
        };

        for process in processes {
            let _ = process.terminate_tree();
            let _ = process.wait_timeout(Duration::from_secs(2));
        }
    }
}

fn attach_reader(reader: Box<dyn Read + Send>, lease: &Arc<ResourceLease>) -> Box<dyn Read + Send> {
    lease.add_resource();
    Box::new(LeaseReader {
        reader,
        _guard: ResourceGuard {
            lease: Arc::clone(lease),
        },
    })
}

fn attach_writer(
    writer: Box<dyn Write + Send>,
    lease: &Arc<ResourceLease>,
) -> Box<dyn Write + Send> {
    lease.add_resource();
    Box::new(LeaseWriter {
        writer,
        _guard: ResourceGuard {
            lease: Arc::clone(lease),
        },
    })
}

#[cfg(windows)]
mod platform {
    use super::{io, OsStr, OsString, ProcessExit, ProcessSpec, Spawned};
    use std::collections::BTreeMap;
    use std::ffi::c_void;
    use std::io::{Read, Write};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_BROKEN_PIPE, HANDLE, HANDLE_FLAG_INHERIT,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, STARTUPINFOW_FLAGS,
    };

    const TRUE: i32 = 1;
    const FALSE: i32 = 0;

    pub(super) struct State {
        process: Handle,
        job: Handle,
    }

    pub(super) fn validate_spec(spec: &ProcessSpec) -> io::Result<()> {
        if !spec.program.is_absolute() {
            return Err(invalid_input("process program must be an absolute path"));
        }
        if !spec
            .program
            .extension()
            .map(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
        {
            return Err(invalid_input("Windows process program must be an .exe"));
        }
        validate_os_string(spec.program.as_os_str(), "process program")?;
        for argument in &spec.args {
            validate_os_string(argument, "process argument")?;
        }
        for (key, value) in &spec.env {
            validate_env_key(key)?;
            if let Some(value) = value {
                validate_os_string(value, "environment value")?;
            }
        }
        if let Some(cwd) = &spec.cwd {
            validate_os_string(cwd.as_os_str(), "process working directory")?;
        }
        Ok(())
    }

    pub(super) fn spawn(spec: ProcessSpec) -> io::Result<Spawned> {
        let job = create_job()?;
        let security = inheritable_security_attributes();

        let (stdin_child, stdin_parent) = create_pipe(&security)?;
        set_not_inheritable(stdin_parent.as_raw(), "stdin parent pipe")?;
        let (stdout_parent, stdout_child) = create_pipe(&security)?;
        set_not_inheritable(stdout_parent.as_raw(), "stdout parent pipe")?;
        let (stderr_parent, stderr_child) = if spec.pipe_stderr {
            let (parent, child) = create_pipe(&security)?;
            set_not_inheritable(parent.as_raw(), "stderr parent pipe")?;
            (Some(parent), child)
        } else {
            (None, create_nul_handle(&security)?)
        };

        let child_handles = [
            stdin_child.as_raw(),
            stdout_child.as_raw(),
            stderr_child.as_raw(),
        ];
        let job_handles = [job.as_raw()];
        let mut attributes = AttributeList::new(2)?;
        // SAFETY: Each entry is a valid inheritable child-side HANDLE owned by
        // the corresponding local `Handle`. `child_handles` is declared before
        // `attributes`, so it remains alive until `AttributeList::drop` calls
        // DeleteProcThreadAttributeList; the pointed-to values are therefore
        // valid for the complete lifetime required by the attribute list.
        unsafe {
            attributes.update(
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                child_handles.as_ptr().cast(),
                size_of_val(&child_handles),
            )?;
        }
        // SAFETY: The array contains the valid Job HANDLE owned by `job` and
        // is declared before `attributes`, so it also remains alive through
        // DeleteProcThreadAttributeList in `AttributeList::drop`.
        unsafe {
            attributes.update(
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                job_handles.as_ptr().cast(),
                size_of_val(&job_handles),
            )?;
        }

        let program = wide_null(spec.program.as_os_str())?;
        let mut command_line = command_line(spec.program.as_os_str(), &spec.args)?;
        let environment = environment_block(&spec.env)?;
        let cwd = spec
            .cwd
            .as_deref()
            .map(|path| wide_null(path.as_os_str()))
            .transpose()?;
        let cwd_ptr = cwd.as_ref().map_or(null(), |value| value.as_ptr());

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES as STARTUPINFOW_FLAGS;
        startup.StartupInfo.hStdInput = stdin_child.as_raw();
        startup.StartupInfo.hStdOutput = stdout_child.as_raw();
        startup.StartupInfo.hStdError = stderr_child.as_raw();
        startup.lpAttributeList = attributes.as_raw();

        let mut process_info = PROCESS_INFORMATION::default();
        let creation_flags =
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
        // SAFETY: All UTF-16 buffers are NUL-terminated and contain no
        // interior NUL. `command_line` is mutable and remains alive for the
        // call; `startup` points to initialized standard handles and an
        // initialized attribute list. Every HANDLE in the handle and Job
        // arrays is valid and owned until CreateProcessW returns, while the
        // output pointer `process_info` points to live writable storage.
        let created = unsafe {
            CreateProcessW(
                program.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                TRUE,
                creation_flags,
                environment.as_ptr().cast::<c_void>(),
                cwd_ptr,
                (&startup as *const STARTUPINFOEXW).cast::<STARTUPINFOW>(),
                &mut process_info,
            )
        };
        if created == FALSE {
            return Err(last_error());
        }

        // The primary thread is not needed by the owner and must be closed
        // immediately.  The child-side stdio handles are closed in the host
        // as soon as CreateProcessW has consumed them.
        // SAFETY: A successful CreateProcessW call returns a valid primary
        // thread HANDLE in `process_info.hThread`, uniquely owned by this
        // function until this immediate CloseHandle call.
        unsafe {
            CloseHandle(process_info.hThread);
        }
        // The raw attribute arrays remain in scope until this explicit drop,
        // and the child HANDLE owners are closed only afterward. This makes
        // the pointer and HANDLE lifetime promised by AttributeList::update
        // true on the successful path as well as on failure cleanup.
        drop(attributes);
        drop(stdin_child);
        drop(stdout_child);
        drop(stderr_child);

        let state = State {
            process: Handle::from_raw(process_info.hProcess)?,
            job,
        };
        let stdin = Some(Box::new(PipeWriter::new(stdin_parent)) as Box<dyn Write + Send>);
        let stdout = Some(Box::new(PipeReader::new(stdout_parent)) as Box<dyn Read + Send>);
        let stderr =
            stderr_parent.map(|handle| Box::new(PipeReader::new(handle)) as Box<dyn Read + Send>);
        Ok(Spawned {
            id: process_info.dwProcessId,
            state,
            stdin,
            stdout,
            stderr,
        })
    }

    pub(super) fn try_wait(state: &State) -> io::Result<Option<ProcessExit>> {
        wait_for_process(state.process.as_raw(), 0)
    }

    pub(super) fn wait_timeout(
        state: &State,
        timeout: Duration,
    ) -> io::Result<Option<ProcessExit>> {
        wait_for_process(state.process.as_raw(), timeout_millis(timeout))
    }

    pub(super) fn terminate_tree(state: &State) -> io::Result<()> {
        // SAFETY: `state.job` is a live, uniquely owned Job HANDLE kept open
        // by `State`; the scalar exit code is valid for TerminateJobObject.
        let terminated = unsafe { TerminateJobObject(state.job.as_raw(), 1) };
        if terminated == FALSE {
            // SAFETY: GetLastError reads the calling thread's error slot and
            // takes no pointers or borrowed resources.
            let error = unsafe { GetLastError() };
            // A process that exited between a status check and this call is
            // already safely stopped; make repeated cancellation idempotent.
            if error != windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE {
                return Err(io::Error::from_raw_os_error(error as i32));
            }
        }
        Ok(())
    }

    fn create_job() -> io::Result<Handle> {
        // SAFETY: A null security descriptor and name request a private,
        // unnamed Job object; both null pointers are explicitly accepted by
        // CreateJobObjectW. The returned HANDLE is immediately wrapped by
        // Handle for single-owner RAII cleanup.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        let job = Handle::from_raw(raw)?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `job` is valid and live; `limits` is fully initialized, and
        // its pointer and exact structure size remain valid for this call.
        let ok = unsafe {
            SetInformationJobObject(
                job.as_raw(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == FALSE {
            return Err(last_error());
        }
        Ok(job)
    }

    fn inheritable_security_attributes() -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: TRUE,
        }
    }

    fn create_pipe(security: &SECURITY_ATTRIBUTES) -> io::Result<(Handle, Handle)> {
        let mut read = null_mut();
        let mut write = null_mut();
        // SAFETY: `read` and `write` are live writable HANDLE output slots,
        // and `security` points to the initialized SECURITY_ATTRIBUTES that
        // remains borrowed for the duration of CreatePipe.
        let ok = unsafe { CreatePipe(&mut read, &mut write, security, 0) };
        if ok == FALSE {
            return Err(last_error());
        }
        // Wrap both outputs before checking either one so an unusual partial
        // API failure still closes every returned kernel handle.
        let read = Handle::owned(read);
        let write = Handle::owned(write);
        if !read.is_valid() || !write.is_valid() {
            let error = last_error();
            drop(read);
            drop(write);
            return Err(error);
        }
        Ok((read, write))
    }

    fn create_nul_handle(security: &SECURITY_ATTRIBUTES) -> io::Result<Handle> {
        let path = wide_null(OsStr::new("NUL"))?;
        // SAFETY: `path` is a live NUL-terminated UTF-16 string, `security`
        // points to initialized attributes, and the null template handle is
        // valid for CreateFileW. The returned HANDLE is wrapped immediately.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                security,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            )
        };
        Handle::from_raw(raw)
    }

    fn set_not_inheritable(handle: HANDLE, name: &str) -> io::Result<()> {
        // SAFETY: The HANDLE was produced and is still owned by a `Handle`
        // in the caller; it is valid while this configuration call executes.
        let ok = unsafe {
            windows_sys::Win32::Foundation::SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0)
        };
        if ok == FALSE {
            return Err(io::Error::other(format!("failed to configure {name}")));
        }
        Ok(())
    }

    fn wait_for_process(handle: HANDLE, milliseconds: u32) -> io::Result<Option<ProcessExit>> {
        // SAFETY: `handle` is a live process HANDLE borrowed from `State` for
        // this call, and `milliseconds` is a valid finite wait value.
        let result = unsafe { WaitForSingleObject(handle, milliseconds) };
        if result == WAIT_TIMEOUT {
            return Ok(None);
        }
        if result != WAIT_OBJECT_0 {
            return Err(last_error());
        }
        let mut code = 0u32;
        // SAFETY: `handle` is the live process HANDLE used by the successful
        // wait, and `code` is a writable local u32 output slot.
        let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
        if ok == FALSE {
            return Err(last_error());
        }
        Ok(Some(ProcessExit { code }))
    }

    fn timeout_millis(timeout: Duration) -> u32 {
        timeout.as_millis().min(u32::MAX.saturating_sub(1) as u128) as u32
    }

    fn last_error() -> io::Error {
        // SAFETY: GetLastError reads only the calling thread's error slot.
        io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
    }

    fn invalid_input(message: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    fn validate_os_string(value: &OsStr, what: &str) -> io::Result<()> {
        if value.encode_wide().any(|unit| unit == 0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{what} contains NUL"),
            ));
        }
        Ok(())
    }

    fn validate_env_key(key: &OsStr) -> io::Result<()> {
        validate_os_string(key, "environment key")?;
        if key.is_empty() || key.encode_wide().any(|unit| unit == b'=' as u16) {
            return Err(invalid_input(
                "environment key must be non-empty and cannot contain '='",
            ));
        }
        Ok(())
    }

    fn wide_null(value: &OsStr) -> io::Result<Vec<u16>> {
        validate_os_string(value, "Windows string")?;
        let mut result = value.encode_wide().collect::<Vec<_>>();
        result.push(0);
        Ok(result)
    }

    fn command_line(program: &OsStr, args: &[OsString]) -> io::Result<Vec<u16>> {
        let mut result = Vec::new();
        append_quoted(&mut result, program)?;
        for argument in args {
            result.push(' ' as u16);
            append_quoted(&mut result, argument)?;
        }
        result.push(0);
        Ok(result)
    }

    /// Quote an argument using the Microsoft CRT parsing rules when quoting is
    /// needed. Arguments without whitespace or quotes stay bare so launchers
    /// such as `py.exe` receive option tokens like `-3.12` unchanged.
    fn append_quoted(output: &mut Vec<u16>, value: &OsStr) -> io::Result<()> {
        let value = wide_null(value)?;
        let body = &value[..value.len() - 1];
        if !body.is_empty()
            && !body
                .iter()
                .any(|&unit| matches!(unit, 9 | 10 | 11 | 12 | 13 | 32 | 34))
        {
            output.extend(body);
            return Ok(());
        }
        output.push('"' as u16);
        let mut backslashes = 0usize;
        for &unit in body {
            match unit {
                92 => backslashes += 1,
                34 => {
                    output.extend(std::iter::repeat_n(92, backslashes * 2 + 1));
                    output.push(unit);
                    backslashes = 0;
                }
                _ => {
                    output.extend(std::iter::repeat_n(92, backslashes));
                    output.push(unit);
                    backslashes = 0;
                }
            }
        }
        output.extend(std::iter::repeat_n(92, backslashes * 2));
        output.push('"' as u16);
        Ok(())
    }

    fn environment_block(changes: &[(OsString, Option<OsString>)]) -> io::Result<Vec<u16>> {
        let mut values = BTreeMap::<String, (Vec<u16>, Vec<u16>)>::new();
        for (key, value) in std::env::vars_os() {
            if key.encode_wide().any(|unit| unit == 0) || value.encode_wide().any(|unit| unit == 0)
            {
                continue;
            }
            let key_wide = key.encode_wide().collect::<Vec<_>>();
            let value_wide = value.encode_wide().collect::<Vec<_>>();
            values.insert(normalized_env_key(&key_wide), (key_wide, value_wide));
        }
        for (key, value) in changes {
            validate_env_key(key)?;
            let key_wide = key.encode_wide().collect::<Vec<_>>();
            let normalized = normalized_env_key(&key_wide);
            match value {
                Some(value) => {
                    validate_os_string(value, "environment value")?;
                    values.insert(
                        normalized,
                        (key_wide, value.encode_wide().collect::<Vec<_>>()),
                    );
                }
                None => {
                    values.remove(&normalized);
                }
            }
        }

        let mut block = Vec::new();
        for (_, (key, value)) in values {
            block.extend(key);
            block.push('=' as u16);
            block.extend(value);
            block.push(0);
        }
        if block.is_empty() {
            block.push(0);
        }
        block.push(0);
        Ok(block)
    }

    fn normalized_env_key(key: &[u16]) -> String {
        String::from_utf16_lossy(key).to_lowercase()
    }

    struct Handle(HANDLE);

    impl Handle {
        fn owned(raw: HANDLE) -> Self {
            Self(raw)
        }

        fn from_raw(raw: HANDLE) -> io::Result<Self> {
            let handle = Self::owned(raw);
            if !handle.is_valid() {
                let error = last_error();
                drop(handle);
                return Err(error);
            }
            Ok(handle)
        }

        fn is_valid(&self) -> bool {
            !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE
        }

        fn as_raw(&self) -> HANDLE {
            self.0
        }
    }

    // SAFETY: `Handle` owns one valid kernel HANDLE and closes it exactly once
    // in Drop. Win32 HANDLE values are process-wide and the operations used by
    // this module (wait, exit-code query, pipe I/O, Job termination) are safe
    // to issue from another thread while that owner remains alive.
    unsafe impl Send for Handle {}
    // SAFETY: Shared references only expose the immutable HANDLE value; the
    // kernel serializes the documented operations on the referenced object,
    // and Drop remains the sole owner-side CloseHandle operation.
    unsafe impl Sync for Handle {}

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: `self.0` was validated when this Handle was created,
                // and this unique owner has not closed it elsewhere. Drop is
                // the single CloseHandle call for the kernel object.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    struct PipeReader {
        handle: Handle,
    }

    impl PipeReader {
        fn new(handle: Handle) -> Self {
            Self { handle }
        }
    }

    impl Read for PipeReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let requested = buffer.len().min(u32::MAX as usize) as u32;
            let mut read = 0u32;
            // SAFETY: The owned pipe HANDLE is valid, `buffer` is writable
            // for `requested` bytes, `read` is a live output slot, and a null
            // OVERLAPPED pointer requests synchronous I/O on this pipe.
            let ok = unsafe {
                ReadFile(
                    self.handle.as_raw(),
                    buffer.as_mut_ptr(),
                    requested,
                    &mut read,
                    null_mut(),
                )
            };
            if ok == FALSE {
                // SAFETY: GetLastError reads only the calling thread's error
                // slot and takes no pointer or borrowed resource.
                let error = unsafe { GetLastError() };
                if error == ERROR_BROKEN_PIPE {
                    return Ok(0);
                }
                return Err(io::Error::from_raw_os_error(error as i32));
            }
            Ok(read as usize)
        }
    }

    struct PipeWriter {
        handle: Handle,
    }

    impl PipeWriter {
        fn new(handle: Handle) -> Self {
            Self { handle }
        }
    }

    impl Write for PipeWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            let requested = buffer.len().min(u32::MAX as usize) as u32;
            let mut written = 0u32;
            // SAFETY: The owned pipe HANDLE is valid, `buffer` is readable
            // for `requested` bytes, `written` is a live output slot, and a
            // null OVERLAPPED pointer requests synchronous I/O.
            let ok = unsafe {
                WriteFile(
                    self.handle.as_raw(),
                    buffer.as_ptr(),
                    requested,
                    &mut written,
                    null_mut(),
                )
            };
            if ok == FALSE {
                return Err(last_error());
            }
            Ok(written as usize)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    struct AttributeList {
        storage: Vec<std::mem::MaybeUninit<usize>>,
        list: *mut c_void,
        initialized: bool,
    }

    impl AttributeList {
        fn new(attribute_count: u32) -> io::Result<Self> {
            let mut bytes = 0usize;
            // SAFETY: This documented sizing probe passes a null list pointer
            // and a live writable size slot; Windows uses it only to report
            // the allocation size needed for `attribute_count` attributes.
            unsafe {
                InitializeProcThreadAttributeList(null_mut(), attribute_count, 0, &mut bytes);
            }
            if bytes == 0 {
                return Err(last_error());
            }
            let word_count = bytes
                .checked_add(size_of::<usize>() - 1)
                .ok_or_else(|| invalid_input("attribute list size overflow"))?
                / size_of::<usize>();
            let mut storage = Vec::<std::mem::MaybeUninit<usize>>::with_capacity(word_count);
            // SAFETY: `word_count` is no greater than the vector capacity and
            // MaybeUninit<usize> permits leaving each allocated word unset.
            unsafe {
                storage.set_len(word_count);
            }
            let list = storage.as_mut_ptr().cast::<c_void>();
            // SAFETY: `list` points to aligned storage with at least `bytes`
            // bytes, `bytes` is a live writable size slot, and the storage
            // remains owned by this AttributeList until its Drop cleanup.
            let initialized =
                unsafe { InitializeProcThreadAttributeList(list, attribute_count, 0, &mut bytes) };
            if initialized == FALSE {
                return Err(last_error());
            }
            Ok(Self {
                storage,
                list,
                initialized: true,
            })
        }

        fn as_raw(&self) -> *mut c_void {
            self.list
        }

        /// Update one attribute in this initialized list.
        ///
        /// # Safety
        ///
        /// `self` must be an initialized list that has not been deleted.
        /// `value` must point to at least `size` bytes of valid attribute data
        /// for the entire period during which the list may use it, through
        /// `DeleteProcThreadAttributeList` in `Drop`. The caller must keep
        /// any HANDLEs or arrays referenced by `value` alive and unchanged
        /// until that deletion has completed.
        unsafe fn update(
            &mut self,
            attribute: u32,
            value: *const c_void,
            size: usize,
        ) -> io::Result<()> {
            // SAFETY: The function's safety contract guarantees an initialized
            // list and a live, correctly sized attribute value pointer.
            let ok = unsafe {
                UpdateProcThreadAttribute(
                    self.list,
                    0,
                    attribute as usize,
                    value,
                    size,
                    null_mut(),
                    null(),
                )
            };
            if ok == FALSE {
                return Err(last_error());
            }
            Ok(())
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            if self.initialized {
                // SAFETY: `self.list` was successfully initialized against
                // `self.storage` and has not been deleted before this Drop;
                // the storage field remains alive throughout this call.
                unsafe {
                    DeleteProcThreadAttributeList(self.list);
                }
            }
            let _ = &self.storage;
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{io, OsStr, ProcessExit, ProcessSpec, Spawned};
    use std::io::{Read, Write};
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

    pub(super) struct State {
        child: Mutex<Child>,
    }

    pub(super) fn validate_spec(spec: &ProcessSpec) -> io::Result<()> {
        if !spec.program.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process program must be an absolute path",
            ));
        }
        if spec.program.as_os_str().to_string_lossy().contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process program contains NUL",
            ));
        }
        for argument in &spec.args {
            if argument.to_string_lossy().contains('\0') {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "process argument contains NUL",
                ));
            }
        }
        for (key, value) in &spec.env {
            if key.is_empty()
                || key.to_string_lossy().contains('\0')
                || key.to_string_lossy().contains('=')
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid environment key",
                ));
            }
            if value
                .as_ref()
                .is_some_and(|value| value.to_string_lossy().contains('\0'))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "environment value contains NUL",
                ));
            }
        }
        if spec
            .cwd
            .as_ref()
            .is_some_and(|cwd| cwd.to_string_lossy().contains('\0'))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process working directory contains NUL",
            ));
        }
        Ok(())
    }

    pub(super) fn spawn(spec: ProcessSpec) -> io::Result<Spawned> {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args);
        for (key, value) in &spec.env {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::piped()).stdout(Stdio::piped());
        if spec.pipe_stderr {
            command.stderr(Stdio::piped());
        } else {
            command.stderr(Stdio::null());
        }
        let mut child = command.spawn()?;
        let id = child.id();
        let stdin = child
            .stdin
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Write + Send>);
        let stdout = child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>);
        let stderr = child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>);
        Ok(Spawned {
            id,
            state: State {
                child: Mutex::new(child),
            },
            stdin,
            stdout,
            stderr,
        })
    }

    pub(super) fn try_wait(state: &State) -> io::Result<Option<ProcessExit>> {
        let mut child = state
            .child
            .lock()
            .map_err(|_| io::Error::other("child lock poisoned"))?;
        Ok(child.try_wait()?.map(process_exit))
    }

    pub(super) fn wait_timeout(
        state: &State,
        timeout: Duration,
    ) -> io::Result<Option<ProcessExit>> {
        let deadline = Instant::now().checked_add(timeout);
        loop {
            if let Some(exit) = try_wait(state)? {
                return Ok(Some(exit));
            }
            let Some(deadline) = deadline else {
                return Ok(None);
            };
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return Ok(None);
            };
            thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }

    pub(super) fn terminate_tree(state: &State) -> io::Result<()> {
        let mut child = state
            .child
            .lock()
            .map_err(|_| io::Error::other("child lock poisoned"))?;
        match child.kill() {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::InvalidInput | io::ErrorKind::NotFound
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn process_exit(status: std::process::ExitStatus) -> ProcessExit {
        ProcessExit {
            code: status
                .code()
                .and_then(|code| u32::try_from(code).ok())
                .unwrap_or(1),
        }
    }

    #[allow(dead_code)]
    fn _os_str_is_used(value: &OsStr) -> bool {
        !value.is_empty()
    }
}
