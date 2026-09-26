//! One bounded, app-owned JSONL engine for frequent read operations.
//!
//! Audited read data may be retained by content fingerprint; handlers still validate each source and
//! open/close their own PDF or database. Writes and long inspections keep the
//! existing one-shot process path. No requests are pipelined on stdout.

use crate::engine_process::{OwnedProcess, ProcessControl, ProcessSpec, ProcessSupervisor};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{mpsc, Condvar, Mutex};
use std::time::{Duration, Instant};

const MAX_WAITERS: usize = 8;
const SPAWN_WAIT: Duration = Duration::from_secs(15);
const STOP_WAIT: Duration = Duration::from_secs(2);

pub struct EngineReadService {
    state: Mutex<State>,
    wake: Condvar,
    max_waiters: usize,
}

#[derive(Default)]
struct State {
    busy: bool,
    waiters: usize,
    stopped: bool,
    active: Option<ProcessControl>,
    session: Option<Session>,
}

struct Session {
    process: OwnedProcess,
    io: Option<SessionIo>,
}

struct SessionIo {
    stdin: Box<dyn Write + Send>,
    stdout: BufReader<Box<dyn Read + Send>>,
}

// The lease releases admission even if spawning/encoding/I/O fails. The
// process is returned to the pool only after a complete valid response.
struct RequestLease<'a> {
    service: &'a EngineReadService,
    session: Option<Session>,
    reusable: bool,
}

impl Default for EngineReadService {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            max_waiters: MAX_WAITERS,
        }
    }
}

impl EngineReadService {
    pub fn supports(request: &Value) -> bool {
        matches!(
            request.get("op").and_then(Value::as_str),
            Some("render_page" | "inspect_pdf" | "batch_snapshot" | "batch_receipt_review_page")
        )
    }

    pub fn request(
        &self,
        supervisor: &ProcessSupervisor,
        spec: ProcessSpec,
        request: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !Self::supports(&request) {
            return Err("operation is not allowed on the read engine".into());
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or("local engine operation timed out")?;
        let mut request_line = serde_json::to_vec(&request)
            .map_err(|_| "local engine request could not be encoded")?;
        if request_line.len() >= crate::ENGINE_IO_LIMIT_BYTES {
            return Err("local engine request exceeded the size limit".into());
        }
        request_line.push(b'\n');
        let mut lease = self.acquire(deadline)?;
        if let Some(session) = &lease.session {
            // A process that died while idle must not receive the next request.
            if session.process.try_wait().ok().flatten().is_some() {
                lease.session.take();
            }
        }
        if lease.session.is_none() {
            let mut process = supervisor
                .spawn(spec, remaining(deadline)?.min(SPAWN_WAIT))
                .map_err(|error| format!("local engine could not start: {error}"))?;
            let stdin = process
                .stdin
                .take()
                .ok_or("local engine stdin is unavailable")?;
            let stdout = process
                .stdout
                .take()
                .ok_or("local engine stdout is unavailable")?;
            lease.session = Some(Session {
                process,
                io: Some(SessionIo {
                    stdin,
                    stdout: BufReader::new(stdout),
                }),
            });
        }
        let session = lease
            .session
            .as_mut()
            .expect("read engine session initialized");
        let control = session.process.control();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "read engine is unavailable")?;
            if state.stopped {
                return Err("local engine is shutting down".into());
            }
            state.active = Some(control.clone());
        }
        let mut io = session
            .io
            .take()
            .ok_or("local engine pipes are unavailable")?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("preview-engine-io".into())
            .spawn(move || {
                let result = io
                    .stdin
                    .write_all(&request_line)
                    .and_then(|_| io.stdin.flush())
                    .map_err(|_| "local engine request failed".to_string())
                    .and_then(|_| read_frame(&mut io.stdout, crate::ENGINE_IO_LIMIT_BYTES))
                    .and_then(|value| {
                        if io.stdout.buffer().is_empty() {
                            Ok(value)
                        } else {
                            Err("local engine returned unsolicited data".into())
                        }
                    });
                let _ = sender.send((io, result));
            })
            .map_err(|_| "local engine I/O worker could not start")?;
        // This deadline covers queueing, startup, blocked pipe writes, reads,
        // and JSON parsing. A timed-out stream is never reused.
        let received = remaining(deadline).and_then(|duration| {
            receiver
                .recv_timeout(duration)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        "local engine operation timed out".to_string()
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        "local engine response worker stopped".to_string()
                    }
                })
        });
        if !matches!(&received, Ok((_, Ok(_)))) {
            let _ = control.terminate_tree();
            let _ = session.process.wait_timeout(STOP_WAIT);
        }
        let _ = worker.join();
        let (io, result) = received?;
        session.io = Some(io);
        let value = result?;
        lease.reusable = session.process.try_wait().is_ok_and(|exit| exit.is_none());
        Ok(value)
    }

    fn acquire(&self, deadline: Instant) -> Result<RequestLease<'_>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "read engine is unavailable")?;
        let mut waiting = false;
        loop {
            if state.stopped {
                state.waiters = state.waiters.saturating_sub(usize::from(waiting));
                return Err("local engine is shutting down".into());
            }
            let duration = match remaining(deadline) {
                Ok(duration) => duration,
                Err(error) => {
                    state.waiters = state.waiters.saturating_sub(usize::from(waiting));
                    return Err(error);
                }
            };
            if !state.busy {
                state.busy = true;
                state.waiters = state.waiters.saturating_sub(usize::from(waiting));
                return Ok(RequestLease {
                    service: self,
                    session: state.session.take(),
                    reusable: false,
                });
            }
            if !waiting {
                if state.waiters >= self.max_waiters {
                    return Err("local engine read queue is full".into());
                }
                state.waiters += 1;
                waiting = true;
            }
            state = self
                .wake
                .wait_timeout(state, duration)
                .map_err(|_| "read engine is unavailable")?
                .0;
        }
    }

    pub fn shutdown(&self) {
        let (session, active) = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            state.stopped = true;
            self.wake.notify_all();
            (state.session.take(), state.active.clone())
        };
        if let Some(active) = active {
            let _ = active.terminate_tree();
        }
        // OwnedProcess drops the whole tree and waits; never hold admission
        // while terminating, so queued requests can observe shutdown promptly.
        drop(session);
    }
}

impl Drop for EngineReadService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Drop for RequestLease<'_> {
    fn drop(&mut self) {
        if !self.reusable {
            self.session.take();
        }
        let session = {
            let Ok(mut state) = self.service.state.lock() else {
                return;
            };
            state.active = None;
            state.busy = false;
            if !state.stopped {
                state.session = self.session.take();
            }
            self.service.wake.notify_all();
            self.session.take()
        };
        drop(session);
    }
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "local engine operation timed out".into())
}

fn read_frame(reader: &mut impl BufRead, max_bytes: usize) -> Result<Value, String> {
    let mut frame = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .map_err(|_| "local engine response could not be read")?;
        if available.is_empty() {
            return Err("local engine response ended before a complete frame".into());
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(available.len(), |position| position + 1);
        if frame.len().saturating_add(length) > max_bytes {
            return Err("local engine response exceeded the size limit".into());
        }
        frame.extend_from_slice(&available[..length]);
        reader.consume(length);
        if newline.is_some() {
            break;
        }
    }
    let value: Value =
        serde_json::from_slice(&frame).map_err(|_| "local engine returned invalid JSON")?;
    if !value.is_object() || !matches!(value["status"].as_str(), Some("ok" | "error")) {
        return Err("local engine returned an invalid response".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn only_short_read_operations_are_admitted() {
        for op in [
            "render_page",
            "inspect_pdf",
            "batch_snapshot",
            "batch_receipt_review_page",
        ] {
            assert!(EngineReadService::supports(&json!({"op": op})));
        }
        for op in [
            "inspect_pages",
            "batch_start",
            "batch_control",
            "batch_receipt_calibration_preview",
            "batch_save_receipt_review",
            "export_pdf",
            "health",
            "",
        ] {
            assert!(!EngineReadService::supports(&json!({"op": op})), "{op}");
        }
        assert!(!EngineReadService::supports(&json!(null)));
    }

    #[test]
    fn frame_reader_preserves_next_frame_and_accepts_fragmented_crlf() {
        let mut reader = BufReader::with_capacity(
            3,
            Cursor::new(b"{\"status\":\"ok\"}\r\n{\"status\":\"error\"}\n"),
        );
        assert_eq!(read_frame(&mut reader, 64).unwrap()["status"], "ok");
        assert_eq!(read_frame(&mut reader, 64).unwrap()["status"], "error");
    }

    #[test]
    fn frame_reader_rejects_oversize_truncation_invalid_json_and_envelopes() {
        assert!(read_frame(&mut Cursor::new(b"{\"status\":\"ok\"}\n"), 8)
            .unwrap_err()
            .contains("size limit"));
        for bytes in [
            b"{\"status\":\"ok\"}".as_slice(),
            b"",
            b"no-json\n",
            b"[]\n",
            b"{\"status\":\"other\"}\n",
        ] {
            assert!(read_frame(&mut Cursor::new(bytes), 64).is_err());
        }
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "condition did not become true");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn admission_is_bounded_and_shutdown_wakes_waiters() {
        let mut service = EngineReadService::default();
        service.max_waiters = 1;
        let service = Arc::new(service);
        let active = service
            .acquire(Instant::now() + Duration::from_secs(5))
            .unwrap();
        let waiting_service = service.clone();
        let waiting = thread::spawn(move || {
            waiting_service
                .acquire(Instant::now() + Duration::from_secs(5))
                .err()
                .unwrap()
        });
        wait_until(|| service.state.lock().unwrap().waiters == 1);
        assert_eq!(
            service
                .acquire(Instant::now() + Duration::from_secs(5))
                .err()
                .unwrap(),
            "local engine read queue is full"
        );
        service.shutdown();
        assert!(waiting.join().unwrap().contains("shutting down"));
        drop(active);
        assert_eq!(service.state.lock().unwrap().waiters, 0);
        assert!(service
            .acquire(Instant::now() + Duration::from_secs(5))
            .is_err());
    }

    #[test]
    fn admission_timeout_does_not_leave_a_waiter_or_block_later_work() {
        let service = EngineReadService::default();
        let active = service
            .acquire(Instant::now() + Duration::from_secs(5))
            .unwrap();
        assert!(service
            .acquire(Instant::now() + Duration::from_millis(20))
            .err()
            .unwrap()
            .contains("timed out"));
        assert_eq!(service.state.lock().unwrap().waiters, 0);
        drop(active);
        assert!(service
            .acquire(Instant::now() + Duration::from_secs(1))
            .is_ok());
    }

    #[cfg(windows)]
    struct Fixture {
        root: std::path::PathBuf,
        spec: ProcessSpec,
        supervisor: ProcessSupervisor,
        service: Arc<EngineReadService>,
    }

    #[cfg(windows)]
    impl Fixture {
        fn new(script: &str, slots: usize) -> Self {
            let root = std::env::temp_dir().join(format!(
                "pdf-search-read-service-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir(&root).unwrap();
            let script_path = root.join("fake-engine.py");
            std::fs::write(&script_path, script).unwrap();
            let program = std::env::var_os("PDF_SEARCH_TEST_PYTHON")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| crate::trusted_system_binary("py.exe").unwrap());
            let mut args = Vec::new();
            if program
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("py.exe"))
            {
                args.push("-3.12".into());
            }
            args.extend([
                "-B".into(),
                "-E".into(),
                "-s".into(),
                "-X".into(),
                "utf8".into(),
                script_path.into_os_string(),
                "--serve".into(),
            ]);
            Self {
                root,
                spec: ProcessSpec {
                    program,
                    args,
                    env: Vec::new(),
                    cwd: None,
                    pipe_stderr: false,
                },
                supervisor: ProcessSupervisor::new(slots, 8),
                service: Arc::new(EngineReadService::default()),
            }
        }

        fn request(&self, value: Value) -> Result<Value, String> {
            self.service.request(
                &self.supervisor,
                self.spec.clone(),
                value,
                Duration::from_secs(5),
            )
        }
    }

    #[cfg(windows)]
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.service.shutdown();
            self.supervisor.shutdown();
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[cfg(windows)]
    const ECHO: &str = "import sys,json,os,time\ncount=0\nfor line in sys.stdin:\n request=json.loads(line)\n count+=1\n time.sleep(request.get('delay',0))\n print(json.dumps(dict(status='ok',pid=os.getpid(),count=count,echo=request)),flush=True)\n";

    #[cfg(windows)]
    #[test]
    fn read_operations_reuse_one_process_without_waiting_for_eof() {
        let fixture = Fixture::new(ECHO, 1);
        let mut pid = None;
        for (index, op) in [
            "render_page",
            "inspect_pdf",
            "batch_snapshot",
            "batch_receipt_review_page",
            "render_page",
        ]
        .iter()
        .enumerate()
        {
            let request = json!({"op": op, "value": index});
            let response = fixture.request(request.clone()).unwrap();
            assert_eq!(response["echo"], request);
            assert_eq!(response["count"], index + 1);
            if let Some(pid) = pid {
                assert_eq!(response["pid"], pid);
            }
            pid = Some(response["pid"].clone());
        }
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_requests_are_serialized_and_responses_keep_their_caller() {
        let fixture = Fixture::new(ECHO, 1);
        let handles = (0..6)
            .map(|index| {
                let service = fixture.service.clone();
                let supervisor = fixture.supervisor.clone();
                let spec = fixture.spec.clone();
                thread::spawn(move || {
                    let response = service
                        .request(
                            &supervisor,
                            spec,
                            json!({"op":"render_page", "value":index, "delay":0.01}),
                            Duration::from_secs(5),
                        )
                        .unwrap();
                    assert_eq!(response["echo"]["value"], index);
                    response["pid"].clone()
                })
            })
            .collect::<Vec<_>>();
        let pids = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>();
        assert!(pids.iter().all(|pid| *pid == pids[0]));
    }

    #[cfg(windows)]
    #[test]
    fn timeout_kills_and_releases_the_session_before_next_request() {
        let fixture = Fixture::new(ECHO, 1);
        let pid = fixture.request(json!({"op":"render_page"})).unwrap()["pid"].clone();
        let started = Instant::now();
        let error = fixture
            .service
            .request(
                &fixture.supervisor,
                fixture.spec.clone(),
                json!({"op":"render_page", "delay":30}),
                Duration::from_millis(100),
            )
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(4));
        let next = fixture.request(json!({"op":"render_page"})).unwrap();
        assert_ne!(next["pid"], pid);
        assert_eq!(next["count"], 1);
    }

    #[cfg(windows)]
    #[test]
    fn malformed_response_and_crash_do_not_poison_the_next_request() {
        let script = "import sys,json,os\nfor line in sys.stdin:\n r=json.loads(line)\n if r.get('crash'): os._exit(1)\n if r.get('invalid'): print('not-json',flush=True)\n else: print(json.dumps(dict(status='ok',pid=os.getpid())),flush=True)\n";
        let fixture = Fixture::new(script, 1);
        for error_field in ["invalid", "crash"] {
            let before = fixture.request(json!({"op":"inspect_pdf"})).unwrap()["pid"].clone();
            let mut request = json!({"op":"inspect_pdf"});
            request[error_field] = json!(true);
            assert!(fixture.request(request).is_err());
            let after = fixture.request(json!({"op":"inspect_pdf"})).unwrap()["pid"].clone();
            assert_ne!(before, after);
        }
    }

    #[cfg(windows)]
    #[test]
    fn idle_child_exit_is_detected_and_restarted() {
        let fixture = Fixture::new(ECHO, 1);
        let before = fixture.request(json!({"op":"inspect_pdf"})).unwrap()["pid"].clone();
        {
            let state = fixture.service.state.lock().unwrap();
            let process = &state.session.as_ref().unwrap().process;
            process.control().terminate_tree().unwrap();
            assert!(process.wait_timeout(STOP_WAIT).unwrap().is_some());
        }
        let after = fixture.request(json!({"op":"inspect_pdf"})).unwrap()["pid"].clone();
        assert_ne!(before, after);
    }

    #[cfg(windows)]
    #[test]
    fn warm_reader_leaves_two_process_slots_and_shutdown_releases_its_slot() {
        let fixture = Fixture::new(ECHO, 3);
        let before = fixture.request(json!({"op":"inspect_pdf"})).unwrap()["pid"].clone();
        let first = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        let second = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        assert!(fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(20))
            .is_err());
        assert_eq!(
            fixture.request(json!({"op":"render_page"})).unwrap()["pid"],
            before
        );
        fixture.service.shutdown();
        let replacement = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        drop((first, second, replacement));
        assert!(fixture
            .request(json!({"op":"inspect_pdf"}))
            .unwrap_err()
            .contains("shutting down"));
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_interrupts_an_active_pipe_read() {
        let fixture = Fixture::new(ECHO, 1);
        fixture.request(json!({"op":"render_page"})).unwrap();
        let service = fixture.service.clone();
        let supervisor = fixture.supervisor.clone();
        let spec = fixture.spec.clone();
        let pending = thread::spawn(move || {
            service.request(
                &supervisor,
                spec,
                json!({"op":"render_page", "delay":30}),
                Duration::from_secs(35),
            )
        });
        wait_until(|| fixture.service.state.lock().unwrap().active.is_some());
        let started = Instant::now();
        fixture.service.shutdown();
        assert!(pending.join().unwrap().is_err());
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!fixture.service.state.lock().unwrap().busy);
        let replacement = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        drop(replacement);
    }

    #[cfg(windows)]
    #[test]
    fn shutdown_during_spawn_wait_reaps_the_new_process() {
        let fixture = Fixture::new(ECHO, 1);
        let blocker = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        let service = fixture.service.clone();
        let supervisor = fixture.supervisor.clone();
        let spec = fixture.spec.clone();
        let pending = thread::spawn(move || {
            service.request(
                &supervisor,
                spec,
                json!({"op":"inspect_pdf"}),
                Duration::from_secs(5),
            )
        });
        wait_until(|| fixture.service.state.lock().unwrap().busy);
        fixture.service.shutdown();
        drop(blocker);
        assert!(pending
            .join()
            .unwrap()
            .unwrap_err()
            .contains("shutting down"));
        assert!(!fixture.service.state.lock().unwrap().busy);
        let replacement = fixture
            .supervisor
            .spawn(fixture.spec.clone(), Duration::from_millis(100))
            .unwrap();
        drop(replacement);
    }

    #[cfg(windows)]
    #[test]
    fn unsolicited_buffered_frame_discards_the_session() {
        let fixture = Fixture::new("import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n if r.get('extra'): sys.stdout.write('{\"status\":\"ok\"}\\n{\"status\":\"ok\"}\\n')\n else: sys.stdout.write('{\"status\":\"ok\"}\\n')\n sys.stdout.flush()\n", 1);
        assert!(fixture
            .request(json!({"op":"render_page", "extra":true}))
            .unwrap_err()
            .contains("unsolicited"));
        assert_eq!(
            fixture.request(json!({"op":"render_page"})).unwrap()["status"],
            "ok"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires PDF_SEARCH_TEST_ENGINE and PDF_SEARCH_TEST_PYTHON with PyMuPDF"]
    fn real_engine_reuses_imports_but_revalidates_sources_and_database_reads() {
        let engine = std::path::PathBuf::from(
            std::env::var_os("PDF_SEARCH_TEST_ENGINE")
                .expect("set PDF_SEARCH_TEST_ENGINE to engine/engine.py"),
        );
        assert!(engine.is_absolute() && engine.is_file());
        let helper = r#"import sys,json,sqlite3
from pathlib import Path
r=json.loads(sys.stdin.readline())
sys.path.insert(0,r['engine_root'])
import pymupdf
from engine.batch_store import BatchStore
root=Path(r['root'])
pdf=root/'synthetic.pdf'
database=root/'synthetic.sqlite3'
if r['phase']=='create':
    document=pymupdf.open()
    document.new_page().insert_text((30,30),'Synthetic page one')
    document.new_page().insert_text((30,30),'Synthetic page two')
    document.save(pdf)
    document.close()
    with BatchStore(database) as store:
        job=store.create_job('before',[dict(source_path=str(pdf),name='Synthetic')],dict(include=['Synthetic'],includeMode='all',exclude=[]),'exact','test-v1')
    print(json.dumps(dict(status='ok',job=job['id'])),flush=True)
else:
    with sqlite3.connect(database) as connection:
        connection.execute('UPDATE batch_jobs SET name=? WHERE id=?',('after',r['job']))
    document=pymupdf.open()
    document.new_page().insert_text((30,30),'Changed source')
    changed=root/'changed.pdf'
    document.save(changed)
    document.close()
    changed.replace(pdf)
    print(json.dumps(dict(status='ok')),flush=True)
"#;
        let fixture = Fixture::new(helper, 3);
        let private_temp_root = fixture.root.join("engine-temp");
        std::fs::create_dir(&private_temp_root).unwrap();
        let helper_runtime = crate::EngineRuntime {
            script_path: fixture.root.join("fake-engine.py"),
            python_executable: fixture.spec.program.clone(),
            private_temp_root: private_temp_root.clone(),
            supervisor: fixture.supervisor.clone(),
            read_service: fixture.service.clone(),
        };
        let mut runtime = helper_runtime.clone();
        runtime.script_path = engine.clone();
        let engine_root = engine.parent().unwrap().parent().unwrap();
        let setup = crate::call_engine_with_timeout(
            &helper_runtime,
            json!({"phase":"create", "root":fixture.root, "engine_root":engine_root}),
            Duration::from_secs(15),
        )
        .unwrap();
        assert_eq!(setup["status"], "ok");
        let pdf = fixture.root.join("synthetic.pdf");
        let original = std::fs::read(&pdf).unwrap();
        let inspected =
            crate::call_engine(&runtime, json!({"op":"inspect_pdf", "path":pdf})).unwrap();
        assert_eq!(inspected["status"], "ok");
        assert_eq!(inspected["page_count"], 2);
        let first_pid = fixture
            .service
            .state
            .lock()
            .unwrap()
            .session
            .as_ref()
            .unwrap()
            .process
            .id();
        for page in [1, 2] {
            let request = json!({"op":"render_page", "path":pdf, "page":page,
                "source_sha256":inspected["source_sha256"]});
            let fresh =
                crate::call_engine_with_timeout(&runtime, request.clone(), Duration::from_secs(15))
                    .unwrap();
            let reused = crate::call_engine(&runtime, request).unwrap();
            assert_eq!(
                reused, fresh,
                "a warm process must preserve the exact page response"
            );
            assert_eq!(reused["status"], "ok");
        }
        assert_eq!(std::fs::read(&pdf).unwrap(), original);
        let snapshot = json!({"op":"batch_snapshot", "database_path":fixture.root.join("synthetic.sqlite3"), "job_id":setup["job"]});
        assert_eq!(
            crate::call_engine(&runtime, snapshot.clone()).unwrap()["data"]["name"],
            "before"
        );
        crate::call_engine_with_timeout(&helper_runtime,
            json!({"phase":"change", "root":fixture.root, "engine_root":engine_root, "job":setup["job"]}), Duration::from_secs(15)).unwrap();
        assert_eq!(
            crate::call_engine(&runtime, snapshot).unwrap()["data"]["name"],
            "after"
        );
        let changed = crate::call_engine(
            &runtime,
            json!({"op":"render_page", "path":pdf, "page":1,
            "source_sha256":inspected["source_sha256"]}),
        )
        .unwrap();
        assert_eq!(changed["status"], "error");
        assert_eq!(changed["code"], "source_changed");
        assert_eq!(
            fixture
                .service
                .state
                .lock()
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .process
                .id(),
            first_pid
        );
        fixture.service.shutdown();
    }
}
