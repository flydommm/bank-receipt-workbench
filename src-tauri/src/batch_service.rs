//! App-owned task lifecycle. Management calls never share a computation lock.

use crate::batch_protocol::{read_event, EventSession, WorkerEvent, MAX_FRAME_BYTES};
use crate::engine_process::OwnedProcess;
use crate::{call_engine, engine_process_spec, EngineRuntime};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Sink = Arc<dyn Fn(Value) + Send + Sync>;
const UNIT_TIMEOUT: Duration = Duration::from_secs(120);
const CANCEL_GRACE: Duration = Duration::from_secs(2);

pub struct BatchService {
    runtime: EngineRuntime,
    database: PathBuf,
    owner: String,
    _host_lock: File,
    initialized: Mutex<bool>,
    active: Mutex<Option<Arc<Active>>>,
    stopped: AtomicBool,
    emit: Sink,
}

struct Active {
    job: String,
    generation: u64,
    cancel_at: Mutex<Option<Instant>>,
    shutdown: AtomicBool,
    outcome: Mutex<Option<MonitorOutcome>>,
    settling: AtomicBool,
}

fn open_lock(path: &Path) -> Result<File, String> {
    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.is_file() || crate::metadata_is_reparse_point(&metadata) {
            return Err("任务锁文件无效".into());
        }
    }
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| "无法打开任务锁文件".into())
}

pub fn validate_request(request: &Value) -> Result<&str, String> {
    let object = request.as_object().ok_or("任务请求无效")?;
    let op = object
        .get("op")
        .and_then(Value::as_str)
        .ok_or("任务请求无效")?;
    let fields: &[&str] = match op {
        "batch_create" => &["name", "sources", "criteria", "match_mode"],
        "batch_start" => &["job_id", "generation"],
        "batch_snapshot" => &["job_id"],
        "batch_list" => &["offset", "limit"],
        "batch_control" => &["job_id", "generation", "command_id", "action"],
        "batch_results_page" => &["job_id", "result_revision", "offset", "limit"],
        "batch_relocate" => &["job_id", "source_id", "new_path"],
        "batch_prepare_review" => &["job_id", "result_revision"],
        "batch_cleanup_plan" => &["job_id"],
        "batch_cleanup_execute" => &["cleanup_id", "delete_review"],
        "batch_cleanup_list" => &["offset", "limit"],
        "batch_storage_usage" | "batch_storage_maintain" => &[],
        _ => return Err("不支持的任务操作".into()),
    };
    if object.len() != fields.len() + 1 || fields.iter().any(|key| !object.contains_key(*key)) {
        return Err("任务请求字段无效".into());
    }
    // Python performs the detailed schema checks. These limits also bound the
    // serialized host request; private DB/owner/compute writes have no UI entry.
    if serde_json::to_vec(request)
        .map_err(|_| "任务请求无效")?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("任务请求过大".into());
    }
    if op == "batch_start"
        && (object["job_id"]
            .as_str()
            .is_none_or(|id| id.is_empty() || id.len() > 128)
            || object["generation"]
                .as_u64()
                .is_none_or(|value| value >= (1 << 53) - 1))
    {
        return Err("任务标识无效".into());
    }
    Ok(op)
}

impl BatchService {
    pub fn new(runtime: EngineRuntime, directory: &Path, emit: Sink) -> Result<Arc<Self>, String> {
        let metadata = std::fs::symlink_metadata(directory).map_err(|_| "任务目录不可用")?;
        if !directory.is_absolute()
            || !metadata.is_dir()
            || crate::metadata_is_reparse_point(&metadata)
        {
            return Err("任务目录不可用".into());
        }
        let host_lock = open_lock(&directory.join("batch-host.lock"))?;
        host_lock
            .try_lock()
            .map_err(|_| "另一个应用窗口正在管理任务，请在原窗口中继续".to_string())?;
        let owner = format!(
            "host-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "系统时间无效")?
                .as_nanos()
        );
        Ok(Arc::new(Self {
            runtime,
            database: directory.join("batch-tasks.sqlite3"),
            owner,
            _host_lock: host_lock,
            initialized: Mutex::new(false),
            active: Mutex::new(None),
            stopped: AtomicBool::new(false),
            emit,
        }))
    }

    fn call(&self, mut request: Value) -> Result<Value, String> {
        if matches!(
            request["op"].as_str(),
            Some("batch_prepare_review" | "batch_cleanup_plan" | "batch_cleanup_execute")
        ) {
            request["review_database_path"] =
                json!(self.database.with_file_name("pdf-search.sqlite3"));
        }
        request["database_path"] = json!(self.database);
        call_engine(&self.runtime, request)
    }

    // Only the native preview allocator can register a path. Neither this
    // operation nor preview_root belongs to the webview batch request schema.
    pub fn register_preview(&self, job_id: &str, token: &str, root: &Path) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire) {
            return Err("应用正在关闭".into());
        }
        self.initialize()?;
        let response = self.call(json!({"op":"batch_register_preview", "job_id":job_id,
            "token":token, "preview_root":root}))?;
        require_ok(&response)
    }

    pub fn release_preview(&self, token: &str) -> Result<(), String> {
        let response = self.call(json!({"op":"batch_release_preview", "token":token}))?;
        require_ok(&response)
    }

    fn initialize(&self) -> Result<(), String> {
        let mut initialized = self.initialized.lock().map_err(|_| "任务初始化不可用")?;
        if *initialized {
            return Ok(());
        }
        let _worker_lock = self.worker_lock()?;
        // The old worker cannot still hold its SQLite connection while this
        // lease is held. A delayed old start subsequently fails its owner CAS.
        let result = self.call(json!({"op":"batch_activate", "owner":self.owner}))?;
        require_ok(&result)?;
        *initialized = true;
        Ok(())
    }

    fn worker_lock(&self) -> Result<File, String> {
        let worker_lock = open_lock(&self.database.with_file_name("batch-worker.lock"))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if worker_lock.try_lock().is_ok() {
                break;
            }
            if Instant::now() >= deadline || self.stopped.load(Ordering::Acquire) {
                return Err("上一后台任务尚未停止，请稍后重试".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
        Ok(worker_lock)
    }

    pub fn request(self: &Arc<Self>, request: Value) -> Result<Value, String> {
        let op = validate_request(&request)?.to_owned();
        if self.stopped.load(Ordering::Acquire) {
            return Err("应用正在关闭".into());
        }
        self.initialize()?;
        self.recover_finished();
        if op == "batch_start" {
            return self.start(request);
        }
        if matches!(
            op.as_str(),
            "batch_cleanup_plan" | "batch_cleanup_execute" | "batch_storage_maintain"
        ) {
            // Reserve the same slot used by start before taking the OS lease.
            // A DB terminal state alone does not prove the worker and its pipes
            // have exited, especially while durable stop settlement retries.
            let slot = self.active.lock().map_err(|_| "后台任务不可用")?;
            if slot.is_some() {
                return Err("请先停止后台任务，等待状态更新后再清理".into());
            }
            let _worker_lock = self.worker_lock()?;
            let response = self.call(request);
            drop(slot);
            return response;
        }
        let result = self.call(request.clone())?;
        if op == "batch_control"
            && result["status"] == "ok"
            && result["data"]["state"] == "cancel_requested"
        {
            if let Some(active) = self.active.lock().map_err(|_| "后台任务不可用")?.as_ref()
            {
                if request["job_id"] == active.job && request["generation"] == active.generation {
                    let mut cancel = active.cancel_at.lock().map_err(|_| "后台任务不可用")?;
                    cancel.get_or_insert(Instant::now() + CANCEL_GRACE);
                }
            }
        }
        // No long worker mutex is held during any short management command.
        Ok(result)
    }

    fn start(self: &Arc<Self>, mut request: Value) -> Result<Value, String> {
        let active = Arc::new(Active {
            job: request["job_id"].as_str().ok_or("任务标识无效")?.into(),
            generation: request["generation"].as_u64().ok_or("任务代次无效")? + 1,
            cancel_at: Mutex::new(None),
            shutdown: AtomicBool::new(false),
            outcome: Mutex::new(None),
            settling: AtomicBool::new(false),
        });
        {
            let mut slot = self.active.lock().map_err(|_| "后台任务不可用")?;
            if slot.is_some() {
                return Err("请先暂停或取消当前后台任务".into());
            }
            *slot = Some(active.clone());
        }
        request["owner"] = json!(self.owner);
        let mut failed_start_stopped = true;
        let mut start_rejected = false;
        let started = (|| {
            let result = self.call(request)?;
            start_rejected = result["status"] == "error";
            require_ok(&result)?;
            let spec = engine_process_spec(
                &self.runtime,
                vec![
                    "--batch-worker".into(),
                    "--batch-database".into(),
                    self.database.as_os_str().into(),
                    "--batch-job".into(),
                    active.job.clone().into(),
                    "--batch-generation".into(),
                    active.generation.to_string().into(),
                    "--batch-owner".into(),
                    self.owner.clone().into(),
                ],
                true,
            )?;
            let process = self
                .runtime
                .supervisor
                .spawn(spec, Duration::from_secs(15))
                .map_err(|_| "后台任务启动失败")?;
            let service = self.clone();
            let running = active.clone();
            launch_monitor(
                process,
                Box::new(move |process| {
                    let outcome = supervise(process, &running, service.emit.clone(), UNIT_TIMEOUT);
                    if let Ok(mut saved) = running.outcome.lock() {
                        *saved = Some(outcome);
                    }
                    service.recover_finished();
                }),
                |operation| {
                    thread::Builder::new()
                        .name("batch-supervisor".into())
                        .spawn(operation)
                        .map(|_| ())
                        .map_err(|_| ())
                },
            )
            .map_err(|stopped| {
                failed_start_stopped = stopped;
                "无法启动任务监管线程"
            })?;
            Ok(result)
        })();
        if start_rejected {
            self.clear(&active);
            return started;
        }
        if started.is_err() {
            if let Ok(mut saved) = active.outcome.lock() {
                *saved = Some(MonitorOutcome {
                    complete: false,
                    stopped: failed_start_stopped,
                    reason: Some("worker_start_failed"),
                });
            }
            self.recover_finished();
        }
        started
    }

    fn clear(&self, running: &Arc<Active>) {
        if let Ok(mut slot) = self.active.lock() {
            if slot
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, running))
            {
                *slot = None;
            }
        }
    }

    fn recover_finished(&self) {
        let active = self.active.lock().ok().and_then(|slot| slot.clone());
        if let Some(active) = active {
            let outcome = active.outcome.lock().ok().and_then(|outcome| *outcome);
            if let Some(outcome) = outcome {
                self.recover_candidate(&active, outcome);
            }
        }
    }

    fn recover_candidate(&self, active: &Arc<Active>, outcome: MonitorOutcome) {
        if !active.settling.swap(true, Ordering::AcqRel) {
            let current = self.active.lock().is_ok_and(|slot| {
                slot.as_ref()
                    .is_some_and(|candidate| Arc::ptr_eq(candidate, active))
            });
            if !current {
                active.settling.store(false, Ordering::Release);
                return;
            }
            if self.settle(active, outcome) {
                self.clear(active);
            }
            active.settling.store(false, Ordering::Release);
        }
    }

    fn settle(&self, active: &Active, outcome: MonitorOutcome) -> bool {
        if self.stopped.load(Ordering::Acquire) {
            return false;
        }
        let worker_lock = if outcome.stopped {
            self.worker_lock().ok()
        } else {
            None
        };
        if worker_lock.is_none() {
            (self.emit)(
                json!({"kind":"settled", "jobId":active.job, "generation":active.generation,
                "complete":false, "reason":"worker_stop_unconfirmed", "snapshot":null}),
            );
            return false;
        }
        // Re-read the durable winner after all child handles and pipes stop.
        // A published ready revision must never be replaced by cancellation.
        let result = (|| {
            let mut result = self.call(json!({"op":"batch_snapshot", "job_id":active.job}))?;
            require_ok(&result)?;
            if result["data"]["generation"] != active.generation {
                return Ok(result);
            }
            let state = result["data"]["state"].as_str().unwrap_or("");
            if matches!(
                state,
                "validating" | "running" | "pause_requested" | "cancel_requested" | "finalizing"
            ) {
                result = self.call(json!({"op":"batch_finish_stop", "job_id":active.job,
                    "generation":active.generation, "owner":self.owner, "cancelled":state == "cancel_requested"}))?;
            }
            Ok::<_, String>(result)
        })();
        let settled = result.as_ref().is_ok_and(|value| value["status"] == "ok");
        (self.emit)(
            json!({"kind":"settled", "jobId":active.job, "generation":active.generation,
            "complete":outcome.complete && settled,
            "reason":if settled { outcome.reason } else { Some("worker_settlement_failed") }, "snapshot":result.ok()}),
        );
        settled
    }

    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(slot) = self.active.lock() {
            if let Some(active) = slot.as_ref() {
                active.shutdown.store(true, Ordering::Release);
            }
        }
    }
}

/// Retain the process in a parent-owned handoff until the monitor thread has
/// actually started. Builder failure must yield observed termination evidence.
fn launch_monitor(
    process: OwnedProcess,
    operation: Box<dyn FnOnce(OwnedProcess) + Send>,
    spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), ()>,
) -> Result<(), bool> {
    let handoff = Arc::new(Mutex::new(Some(process)));
    let worker = handoff.clone();
    if spawn(Box::new(move || {
        if let Ok(mut slot) = worker.lock() {
            if let Some(process) = slot.take() {
                drop(slot);
                operation(process);
            }
        }
    }))
    .is_err()
    {
        let process = handoff.lock().ok().and_then(|mut slot| slot.take());
        let stopped = process.is_some_and(|process| {
            let _ = process.control().terminate_tree();
            process.wait_timeout(CANCEL_GRACE).ok().flatten().is_some()
        });
        return Err(stopped);
    }
    Ok(())
}

fn require_ok(result: &Value) -> Result<(), String> {
    if result["status"] == "ok" {
        Ok(())
    } else {
        Err(result["message"]
            .as_str()
            .unwrap_or("任务操作未完成")
            .to_owned())
    }
}

enum PipeMessage {
    Event(WorkerEvent),
    Failed,
    End,
}

fn accept_worker_event(
    session: &mut EventSession,
    event: &WorkerEvent,
    now: Instant,
) -> Result<(), &'static str> {
    if session.timed_out(now) {
        return Err("worker_timeout");
    }
    session
        .accept(event, now)
        .map_err(|_| "worker_protocol_failed")
}

#[derive(Clone, Copy)]
struct MonitorOutcome {
    complete: bool,
    stopped: bool,
    reason: Option<&'static str>,
}

fn supervise(
    mut process: OwnedProcess,
    active: &Active,
    emit: Sink,
    timeout: Duration,
) -> MonitorOutcome {
    let control = process.control();
    let mut session = match EventSession::new(
        active.job.clone(),
        active.generation,
        Instant::now(),
        timeout,
    ) {
        Ok(session) => session,
        Err(_) => {
            let _ = control.terminate_tree();
            let stopped = process.wait_timeout(CANCEL_GRACE).ok().flatten().is_some();
            return MonitorOutcome {
                complete: false,
                stopped,
                reason: Some("worker_protocol_failed"),
            };
        }
    };
    let (sender, receiver) = mpsc::sync_channel(64);
    let pipe_failed = Arc::new(AtomicBool::new(false));
    let mut readers = Vec::new();
    let reader_start = (|| {
        let stdout = process.stdout.take().ok_or(())?;
        let messages = sender.clone();
        let event_failed = pipe_failed.clone();
        readers.push(
            thread::Builder::new()
                .name("batch-events".into())
                .spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    loop {
                        let message = match read_event(&mut reader) {
                            Ok(Some(event)) => PipeMessage::Event(event),
                            Ok(None) => {
                                let _ = messages.send(PipeMessage::End);
                                break;
                            }
                            Err(_) => {
                                event_failed.store(true, Ordering::Release);
                                let _ = messages.send(PipeMessage::Failed);
                                break;
                            }
                        };
                        if messages.send(message).is_err() {
                            break;
                        }
                    }
                })
                .map_err(|_| ())?,
        );
        let mut stderr = process.stderr.take().ok_or(())?;
        let error_failed = pipe_failed.clone();
        readers.push(
            thread::Builder::new()
                .name("batch-errors".into())
                .spawn(move || {
                    let mut bytes = [0_u8; 4096];
                    let mut total = 0;
                    loop {
                        match stderr.read(&mut bytes) {
                            Ok(0) => break,
                            Ok(count) if total + count <= MAX_FRAME_BYTES => total += count,
                            _ => {
                                error_failed.store(true, Ordering::Release);
                                let _ = sender.send(PipeMessage::Failed);
                                break;
                            }
                        }
                    }
                })
                .map_err(|_| ())?,
        );
        Ok::<_, ()>(())
    })();
    let mut reason = reader_start.err().map(|_| "worker_start_failed");
    let mut exit = None;
    let mut eof = false;
    while reason.is_none() {
        let now = Instant::now();
        if active.shutdown.load(Ordering::Acquire) {
            reason = Some("app_closing");
            break;
        }
        if active
            .cancel_at
            .lock()
            .is_ok_and(|cancel| cancel.is_some_and(|at| now >= at))
        {
            reason = Some("cancelled");
            break;
        }
        if session.timed_out(now) {
            reason = Some("worker_timeout");
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(PipeMessage::Event(event)) => {
                if let Err(failure) = accept_worker_event(&mut session, &event, Instant::now()) {
                    reason = Some(failure);
                } else {
                    emit(json!({"kind":"worker", "event":event}));
                }
            }
            Ok(PipeMessage::Failed) => reason = Some("worker_protocol_failed"),
            Ok(PipeMessage::End) => eof = true,
            Err(mpsc::RecvTimeoutError::Disconnected) => eof = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        match process.try_wait() {
            Ok(Some(status)) => {
                exit = Some(status);
                // No descendant should outlive a completed worker, including
                // descendants retaining an inherited stdout/stderr handle.
                let _ = control.terminate_tree();
                if eof {
                    break;
                }
            }
            Ok(None) => {}
            Err(_) => {
                reason = Some("worker_process_failed");
            }
        }
    }
    let _ = control.terminate_tree();
    drop(receiver); // Unblock any bounded channel sender before joining.
    drop(process.stdin.take());
    if exit.is_none() {
        exit = process.wait_timeout(CANCEL_GRACE).ok().flatten();
    }
    drop(process); // Close the owned Job before waiting for final pipe EOF.
    for reader in readers {
        if reader.join().is_err() {
            pipe_failed.store(true, Ordering::Release);
        }
    }
    if pipe_failed.load(Ordering::Acquire) {
        reason.get_or_insert("worker_protocol_failed");
    }
    let complete =
        reason.is_none() && session.completed() && exit.is_some_and(|status| status.success());
    MonitorOutcome {
        complete,
        stopped: exit.is_some(),
        reason: reason.or(if complete {
            None
        } else {
            Some("worker_process_failed")
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_cannot_inject_private_paths_owner_or_compute_operations() {
        for request in [
            json!({"op":"batch_activate","owner":"other"}),
            json!({"op":"batch_commit_page"}),
            json!({"op":"batch_list","offset":0,"limit":50,"database_path":"x"}),
            json!({"op":"batch_start","job_id":"j","generation":0,"owner":"other"}),
            json!({"op":"batch_prepare_review","job_id":"j","result_revision":"r","review_database_path":"x"}),
            json!({"op":"batch_prepare_review","job_id":"j","result_revision":"r","originals":[]}),
            json!({"op":"batch_register_preview","job_id":"j","token":"preview-owned-000001","preview_root":"x"}),
            json!({"op":"batch_release_preview","token":"preview-owned-000001"}),
            json!({"op":"batch_cleanup_plan","job_id":"j","preview_identities":[]}),
            json!({"op":"batch_cleanup_execute","cleanup_id":"c","delete_review":true,"review_database_path":"x"}),
            json!({"op":"batch_storage_maintain","database_path":"x"}),
        ] {
            assert!(validate_request(&request).is_err());
        }
        assert!(validate_request(&json!({"op":"batch_list","offset":0,"limit":50})).is_ok());
        assert!(validate_request(
            &json!({"op":"batch_prepare_review","job_id":"j","result_revision":"r"})
        )
        .is_ok());
        for request in [
            json!({"op":"batch_cleanup_plan","job_id":"j"}),
            json!({"op":"batch_cleanup_execute","cleanup_id":"c","delete_review":false}),
            json!({"op":"batch_cleanup_list","offset":0,"limit":20}),
            json!({"op":"batch_storage_usage"}),
            json!({"op":"batch_storage_maintain"}),
        ] {
            assert!(validate_request(&request).is_ok());
        }
    }

    #[cfg(windows)]
    fn synthetic_python_executable() -> PathBuf {
        if let Some(configured) = std::env::var_os("PDF_SEARCH_TEST_PYTHON") {
            let path = PathBuf::from(configured);
            assert!(
                path.is_absolute(),
                "PDF_SEARCH_TEST_PYTHON must point to an absolute executable path: {}",
                path.display()
            );
            assert!(
                path.is_file(),
                "PDF_SEARCH_TEST_PYTHON must point to an existing executable: {}",
                path.display()
            );
            assert!(
                path.extension()
                    .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe")),
                "PDF_SEARCH_TEST_PYTHON must point to a .exe: {}",
                path.display()
            );
            path
        } else {
            crate::trusted_system_binary("py.exe").unwrap()
        }
    }

    #[cfg(windows)]
    fn synthetic_runtime(script: &str) -> EngineRuntime {
        let root = std::env::temp_dir().join(format!(
            "pdf-search-batch-monitor-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let script_path = root.join("synthetic.py");
        std::fs::write(&script_path, script).unwrap();
        EngineRuntime {
            script_path,
            python_executable: synthetic_python_executable(),
            private_temp_root: root,
            supervisor: crate::engine_process::ProcessSupervisor::new(3, 32),
        }
    }

    #[cfg(windows)]
    fn synthetic_process(script: &str) -> OwnedProcess {
        let runtime = synthetic_runtime(script);
        let spec = engine_process_spec(&runtime, Vec::new(), true).unwrap();
        runtime
            .supervisor
            .spawn(spec, Duration::from_secs(2))
            .unwrap()
    }

    #[cfg(windows)]
    fn active() -> Active {
        Active {
            job: "job".into(),
            generation: 1,
            cancel_at: Mutex::new(None),
            shutdown: AtomicBool::new(false),
            outcome: Mutex::new(None),
            settling: AtomicBool::new(false),
        }
    }

    #[cfg(windows)]
    const EVENTS: &str = "import json,sys,time\nseq=0\ndef emit(kind,payload):\n global seq\n seq+=1\n print(json.dumps(dict(protocol=2,jobId='job',generation=1,seq=seq,type=kind,payload=payload)),flush=True)\n";

    #[test]
    #[cfg(windows)]
    fn synthetic_launcher_starts_python() {
        let mut process = synthetic_process("print('synthetic-worker',flush=True)");
        let mut output = String::new();
        process
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let mut error = String::new();
        process
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut error)
            .unwrap();
        let status = process
            .wait_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        assert!(
            status.success(),
            "synthetic exit={} stderr={error}",
            status.code
        );
        assert_eq!(output.trim(), "synthetic-worker");
    }

    #[test]
    #[cfg(windows)]
    fn real_monitor_accepts_completed_worker_and_closes_inherited_child_pipes() {
        let script = format!("{EVENTS}\nimport subprocess\nsubprocess.Popen([sys.executable,'-c','import time;time.sleep(20)'])\nemit('snapshot',dict(state='running'))\nemit('completed',dict(state='paused'))\n");
        let process = synthetic_process(&script);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let outcome = supervise(
            process,
            &active(),
            Arc::new(move |event| captured.lock().unwrap().push(event)),
            Duration::from_secs(3),
        );
        assert!(outcome.complete && outcome.stopped);
        assert_eq!(events.lock().unwrap().len(), 2);
    }

    #[test]
    #[cfg(windows)]
    fn real_heartbeat_cannot_extend_a_page_deadline() {
        let script = format!("{EVENTS}\nemit('progress',dict(phase='unit_start',unit_id='u',stage='page'))\nwhile True:\n emit('progress',dict(phase='heartbeat'))\n time.sleep(.01)\n");
        let process = synthetic_process(&script);
        let began = Instant::now();
        let outcome = supervise(
            process,
            &active(),
            Arc::new(|_| {}),
            Duration::from_millis(250),
        );
        assert_eq!(outcome.reason, Some("worker_timeout"));
        assert!(outcome.stopped && began.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn event_received_at_deadline_is_a_timeout() {
        let began = Instant::now();
        let timeout = Duration::from_millis(250);
        let mut session = EventSession::new("job".into(), 1, began, timeout).unwrap();
        let start: WorkerEvent = serde_json::from_value(json!({
            "protocol": 2, "jobId": "job", "generation": 1, "seq": 1,
            "type": "progress",
            "payload": {"phase": "unit_start", "unit_id": "u", "stage": "page"}
        }))
        .unwrap();
        assert_eq!(accept_worker_event(&mut session, &start, began), Ok(()));
        let heartbeat: WorkerEvent = serde_json::from_value(json!({
            "protocol": 2, "jobId": "job", "generation": 1, "seq": 2,
            "type": "progress", "payload": {"phase": "heartbeat"}
        }))
        .unwrap();
        assert_eq!(
            accept_worker_event(&mut session, &heartbeat, began + timeout),
            Err("worker_timeout")
        );

        let mut live_session = EventSession::new("job".into(), 1, began, timeout).unwrap();
        assert_eq!(
            accept_worker_event(&mut live_session, &heartbeat, began),
            Err("worker_protocol_failed")
        );
    }

    #[test]
    #[cfg(windows)]
    fn real_cancel_stops_a_worker_that_is_not_reading_controls() {
        let process = synthetic_process("import time;time.sleep(20)");
        let active = active();
        *active.cancel_at.lock().unwrap() = Some(Instant::now() + Duration::from_millis(100));
        let outcome = supervise(process, &active, Arc::new(|_| {}), Duration::from_secs(5));
        assert_eq!(outcome.reason, Some("cancelled"));
        assert!(outcome.stopped && !outcome.complete);
    }

    #[test]
    #[cfg(windows)]
    fn real_bad_event_and_excess_stderr_stop_the_owned_worker() {
        for script in [
            "import time;print('invalid',flush=True);time.sleep(20)",
            "import sys,time;sys.stderr.write('x'*70000);sys.stderr.flush();time.sleep(20)",
        ] {
            let process = synthetic_process(script);
            let outcome = supervise(process, &active(), Arc::new(|_| {}), Duration::from_secs(3));
            assert_eq!(outcome.reason, Some("worker_protocol_failed"));
            assert!(outcome.stopped && !outcome.complete);
        }
    }

    #[test]
    #[cfg(windows)]
    fn delayed_stderr_failure_is_counted_even_after_stdout_and_process_exit() {
        struct DelayedLastByte {
            inner: Box<dyn Read + Send>,
            bytes: usize,
        }
        impl Read for DelayedLastByte {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.bytes == MAX_FRAME_BYTES {
                    thread::sleep(Duration::from_millis(300));
                }
                let limit = if self.bytes < MAX_FRAME_BYTES {
                    buffer.len().min(MAX_FRAME_BYTES - self.bytes)
                } else {
                    buffer.len()
                };
                let count = self.inner.read(&mut buffer[..limit])?;
                self.bytes += count;
                Ok(count)
            }
        }
        let mut process = synthetic_process(&format!("{EVENTS}\nemit('completed',dict(state='paused'))\nsys.stderr.write('x'*65537)\nsys.stderr.flush()\n"));
        process.stderr = Some(Box::new(DelayedLastByte {
            inner: process.stderr.take().unwrap(),
            bytes: 0,
        }));
        let outcome = supervise(process, &active(), Arc::new(|_| {}), Duration::from_secs(3));
        assert!(outcome.stopped && !outcome.complete);
        assert_eq!(outcome.reason, Some("worker_protocol_failed"));
    }

    #[test]
    #[cfg(windows)]
    fn monitor_thread_failure_reclaims_the_process_and_observes_exit() {
        let process = synthetic_process("import time;time.sleep(20)");
        let result = launch_monitor(
            process,
            Box::new(|_| panic!("monitor must not run")),
            |_| Err(()),
        );
        assert_eq!(result, Err(true));
    }

    #[test]
    #[cfg(windows)]
    fn failed_settlement_remains_retryable_and_rejected_start_does_not_occupy_slot() {
        let script = format!("{EVENTS}\nfrom pathlib import Path\nflag=Path(__file__).with_name('fail-settlement')\nif '--batch-worker' in sys.argv:\n emit('completed',dict(state='paused'))\nelse:\n request=json.loads(sys.stdin.readline())\n op=request['op']\n if op=='batch_start' and request['job_id']=='missing':\n  reply=dict(status='error',message='unknown job')\n elif op=='batch_snapshot' and flag.exists():\n  reply=dict(status='error',message='synthetic read failure')\n else:\n  reply=dict(status='ok',data=dict(id='job',generation=1,state='validating' if op=='batch_snapshot' else 'interrupted'))\n print(json.dumps(reply),flush=True)\n");
        let runtime = synthetic_runtime(&script);
        let root = runtime.private_temp_root.clone();
        let flag = root.join("fail-settlement");
        std::fs::write(&flag, "synthetic").unwrap();
        let (sender, events) = mpsc::channel();
        let service = BatchService::new(
            runtime,
            &root,
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();
        assert!(service
            .request(json!({"op":"batch_start", "job_id":"missing", "generation":0}))
            .is_err());
        assert!(service.active.lock().unwrap().is_none());
        service
            .request(json!({"op":"batch_start", "job_id":"job", "generation":0}))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if event["reason"] == "worker_settlement_failed" {
                break;
            }
        }
        assert!(service.active.lock().unwrap().is_some());
        assert!(service
            .request(json!({"op":"batch_cleanup_plan", "job_id":"job"}))
            .is_err());
        assert!(service
            .request(
                json!({"op":"batch_cleanup_execute", "cleanup_id":"cleanup", "delete_review":false})
            )
            .is_err());
        assert!(service
            .request(json!({"op":"batch_storage_maintain"}))
            .is_err());
        std::fs::remove_file(flag).unwrap(); // This test's disposable marker only.
        let deadline = Instant::now() + Duration::from_secs(3);
        while service.active.lock().unwrap().is_some() && Instant::now() < deadline {
            service
                .request(json!({"op":"batch_list", "offset":0, "limit":50}))
                .unwrap();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(service.active.lock().unwrap().is_none());
    }

    #[test]
    #[cfg(windows)]
    fn captured_old_recovery_cannot_take_the_new_workers_lifecycle_lock() {
        let runtime = synthetic_runtime("raise RuntimeError('must not run')");
        let root = runtime.private_temp_root.clone();
        let service = BatchService::new(
            runtime,
            &root,
            Arc::new(|_| panic!("stale recovery must not emit")),
        )
        .unwrap();
        let old = Arc::new(active());
        *service.active.lock().unwrap() = Some(old.clone());
        // A completed recovery cleared old, then a new start reserved the
        // slot, while another reader still retained its captured old Arc.
        let next = Arc::new(Active {
            job: "next".into(),
            ..active()
        });
        *service.active.lock().unwrap() = Some(next.clone());
        let lease = service.worker_lock().unwrap();
        let began = Instant::now();
        service.recover_candidate(
            &old,
            MonitorOutcome {
                complete: true,
                stopped: true,
                reason: None,
            },
        );
        assert!(began.elapsed() < Duration::from_millis(250));
        assert!(Arc::ptr_eq(
            service.active.lock().unwrap().as_ref().unwrap(),
            &next
        ));
        assert!(!old.settling.load(Ordering::Acquire));
        drop(lease);
    }

    #[test]
    #[cfg(windows)]
    fn rust_lock_conflicts_with_python_worker_lease_until_process_exit() {
        let root = std::env::temp_dir().join(format!(
            "pdf-search-cross-lease-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let lease = open_lock(&root.join("batch-worker.lock")).unwrap();
        lease.try_lock().unwrap();
        let engine_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let script = format!("import sys\nsys.path.insert(0,{})\nfrom pathlib import Path\nfrom engine.batch_lease import worker_lease\nwith worker_lease(Path({})):\n print('locked',flush=True)\n",
            serde_json::to_string(&engine_root).unwrap(), serde_json::to_string(&root.join("batch.sqlite3")).unwrap());
        let rejected = synthetic_process(&script);
        let status = rejected
            .wait_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        assert!(!status.success());
        drop(rejected);
        drop(lease);
        let accepted = synthetic_process(&script);
        let status = accepted
            .wait_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap();
        assert!(status.success());
    }
}
