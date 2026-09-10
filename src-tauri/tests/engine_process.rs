#![cfg(windows)]

#[path = "../src/engine_process.rs"]
mod engine_process;

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use engine_process::{OwnedProcess, ProcessExit, ProcessSpec, ProcessSupervisor};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

fn python_exe() -> PathBuf {
    let path = if let Some(configured) = std::env::var_os("PDF_SEARCH_TEST_PYTHON") {
        require_python_executable(PathBuf::from(configured), "PDF_SEARCH_TEST_PYTHON")
    } else {
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("SystemRoot is unset; cannot locate trusted py.exe"));
        assert!(
            system_root.is_absolute() && system_root.is_dir(),
            "SystemRoot must be an existing absolute directory: {}",
            system_root.display()
        );
        let launcher = require_python_executable(system_root.join("py.exe"), "SystemRoot/py.exe");
        let output = Command::new(&launcher)
            .args([
                "-3.12",
                "-E",
                "-s",
                "-c",
                "import sys; print(sys.executable)",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .unwrap_or_else(|error| panic!("failed to run {}: {error}", launcher.display()));
        assert!(
            output.status.success(),
            "{} -3.12 failed: {}",
            launcher.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        let output = String::from_utf8(output.stdout)
            .unwrap_or_else(|error| panic!("py.exe returned non-UTF-8 executable path: {error}"));
        require_python_executable(PathBuf::from(output.trim()), "py.exe -3.12 result")
    };
    assert_python312(&path);
    path
}

fn require_python_executable(path: PathBuf, source: &str) -> PathBuf {
    assert!(
        path.is_absolute(),
        "{source} must point to an absolute executable path: {}",
        path.display()
    );
    assert!(
        path.is_file(),
        "{source} must point to an existing executable: {}",
        path.display()
    );
    assert!(
        path.extension()
            .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe")),
        "{source} must point to a .exe: {}",
        path.display()
    );
    path
}

fn assert_python312(path: &Path) {
    let output = Command::new(path)
        .args([
            "-E",
            "-s",
            "-c",
            "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .unwrap_or_else(|error| panic!("failed to verify {}: {error}", path.display()));
    assert!(
        output.status.success(),
        "Python version check failed for {}: {}",
        path.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    assert_eq!(
        version,
        "3.12",
        "process tests require Python 3.12, got {version} from {}",
        path.display()
    );
}

fn python_spec(script: &str, args: &[&str], pipe_stderr: bool) -> ProcessSpec {
    let program = python_exe();
    ProcessSpec {
        program,
        args: std::iter::once(OsString::from("-c"))
            .chain(std::iter::once(OsString::from(script)))
            .chain(args.iter().copied().map(OsString::from))
            .collect(),
        env: vec![(
            OsString::from("PYTHONIOENCODING"),
            Some(OsString::from("utf-8")),
        )],
        cwd: None,
        pipe_stderr,
    }
}

fn wait_success(mut process: OwnedProcess) -> ProcessExit {
    let mut stdout = process.stdout.take().expect("stdout should be piped");
    let mut output = Vec::new();
    stdout
        .read_to_end(&mut output)
        .expect("stdout should close");
    let exit = process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish");
    assert!(exit.success(), "unexpected exit code: {}", exit.code);
    exit
}

#[test]
fn process_spec_rejects_non_absolute_programs() {
    let supervisor = ProcessSupervisor::new(1, 0);
    let spec = ProcessSpec {
        program: PathBuf::from("python.exe"),
        args: Vec::new(),
        env: Vec::new(),
        cwd: None,
        pipe_stderr: false,
    };

    let error = supervisor
        .spawn(spec, Duration::from_millis(1))
        .expect_err("relative program path must be rejected");
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn python_process_round_trips_stdin_and_unicode_quoted_arguments() {
    let spec = python_spec(
        "import sys; data=sys.stdin.read(); sys.stdout.write(sys.argv[1]+'|'+data); sys.stdout.flush()",
        &[r#"前 空格 "引号" \尾"#],
        true,
    );

    let supervisor = ProcessSupervisor::new(3, 32);
    let mut process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("Python process should spawn");
    let mut stdin = process.stdin.take().expect("stdin should be piped");
    stdin
        .write_all("输入内容-中文\n".as_bytes())
        .expect("stdin should accept bytes");
    drop(stdin);

    let mut stdout = process.stdout.take().expect("stdout should be piped");
    let mut output = String::new();
    stdout
        .read_to_string(&mut output)
        .expect("stdout should be valid UTF-8");
    let exit = process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish");

    assert_eq!(
        output.replace("\r\n", "\n"),
        "前 空格 \"引号\" \\尾|输入内容-中文\n"
    );
    assert!(exit.success());
}

#[test]
fn windows_crt_quoting_preserves_empty_space_quote_and_backslash_edges() {
    let program = python_exe();
    let values = vec![
        "".to_string(),
        " ".to_string(),
        "\"".to_string(),
        r#"反斜杠\"引号"#.to_string(),
        r#"尾部\"#.to_string(),
    ];
    let mut args = vec![
        OsString::from("-c"),
        OsString::from("import json,sys; print(json.dumps(sys.argv[1:],ensure_ascii=False))"),
    ];
    args.extend(values.iter().cloned().map(OsString::from));
    let spec = ProcessSpec {
        program,
        args,
        env: vec![(
            OsString::from("PYTHONIOENCODING"),
            Some(OsString::from("utf-8")),
        )],
        cwd: None,
        pipe_stderr: false,
    };
    let supervisor = ProcessSupervisor::new(3, 32);
    let mut process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("quoting process should spawn");
    let mut output = String::new();
    process
        .stdout
        .take()
        .expect("stdout should be piped")
        .read_to_string(&mut output)
        .expect("stdout should be readable");
    let decoded: Vec<String> = serde_json::from_str(output.trim()).expect("JSON should parse");
    assert_eq!(decoded, values);
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish")
        .success());
}

#[test]
fn stderr_is_optional_and_captured_when_requested() {
    let spec = python_spec(
        "import sys; sys.stderr.write('错误'+chr(10)); sys.stderr.flush()",
        &[],
        true,
    );

    let supervisor = ProcessSupervisor::new(3, 32);
    let mut process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("Python process should spawn");
    let mut stderr = process.stderr.take().expect("stderr should be captured");
    let mut output = String::new();
    stderr
        .read_to_string(&mut output)
        .expect("stderr should be valid UTF-8");
    assert_eq!(output.replace("\r\n", "\n"), "错误\n");
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish")
        .success());
}

#[test]
fn environment_changes_override_and_remove_case_insensitively() {
    let program = python_exe();
    let script = "import os; values=[v for k,v in os.environ.items() if k.lower()=='pdf_search_case']; print(values[0] if values else 'missing')";
    let mut spec = ProcessSpec {
        program: program.clone(),
        args: vec![OsString::from("-c"), OsString::from(script)],
        env: vec![
            (
                OsString::from("PDF_SEARCH_CASE"),
                Some(OsString::from("first")),
            ),
            (
                OsString::from("pdf_search_case"),
                Some(OsString::from("second")),
            ),
            (
                OsString::from("PYTHONIOENCODING"),
                Some(OsString::from("utf-8")),
            ),
        ],
        cwd: None,
        pipe_stderr: false,
    };
    let supervisor = ProcessSupervisor::new(3, 32);
    let mut process = supervisor
        .spawn(spec.clone(), Duration::from_secs(1))
        .expect("environment override process should spawn");
    let mut output = String::new();
    process
        .stdout
        .take()
        .expect("stdout should be piped")
        .read_to_string(&mut output)
        .expect("stdout should be readable");
    assert_eq!(output.trim(), "second");
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish")
        .success());

    spec.env[1] = (OsString::from("pdf_search_case"), None);
    let mut process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("environment removal process should spawn");
    let mut output = String::new();
    process
        .stdout
        .take()
        .expect("stdout should be piped")
        .read_to_string(&mut output)
        .expect("stdout should be readable");
    assert_eq!(output.trim(), "missing");
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("process should finish")
        .success());
}

#[test]
fn wait_timeout_is_bounded_and_reports_later_success() {
    let spec = python_spec("import time; time.sleep(0.35)", &[], false);

    let supervisor = ProcessSupervisor::new(3, 32);
    let process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("Python process should spawn");
    assert!(process
        .try_wait()
        .expect("non-blocking wait should succeed")
        .is_none());
    assert!(process
        .wait_timeout(Duration::from_millis(20))
        .expect("short wait should succeed")
        .is_none());
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("long wait should succeed")
        .expect("process should finish")
        .success());
}

#[test]
fn wait_reports_the_real_still_active_exit_code() {
    let spec = python_spec("import sys; sys.exit(259)", &[], false);
    let supervisor = ProcessSupervisor::new(3, 32);
    let process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("Python process should spawn");
    let exit = process
        .wait_timeout(Duration::from_secs(5))
        .expect("process wait should succeed")
        .expect("exit code 259 must still be reported after the handle is signaled");
    assert_eq!(exit.code, 259);
    assert!(!exit.success());
}

#[test]
fn supervisor_enforces_slots_and_waiter_bound() {
    let long_spec = python_spec("import time; time.sleep(1.0)", &[], false);
    let supervisor = ProcessSupervisor::new(1, 1);
    let first = supervisor
        .spawn(long_spec.clone(), Duration::from_secs(1))
        .expect("first slot should be available");

    let queued_supervisor = supervisor.clone();
    let (tx, rx) = mpsc::channel();
    let waiter = thread::spawn(move || {
        tx.send(
            queued_supervisor
                .spawn(long_spec, Duration::from_secs(5))
                .map(|process| process.id()),
        )
        .expect("waiter result should be sent");
    });
    thread::sleep(Duration::from_millis(50));

    let third_spec = python_spec("import time; time.sleep(0.1)", &[], false);
    let error = supervisor
        .spawn(third_spec, Duration::from_millis(20))
        .expect_err("second waiter must exceed the queue bound");
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);

    drop(first);
    let second_id = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("queued spawn should wake after slot release")
        .expect("queued spawn should succeed");
    assert!(second_id > 0);
    waiter.join().expect("waiter should finish");
}

#[test]
fn shutdown_wakes_waiters_and_rejects_new_processes() {
    let long_spec = python_spec("import time; time.sleep(10)", &[], false);
    let supervisor = ProcessSupervisor::new(1, 1);
    let first = supervisor
        .spawn(long_spec.clone(), Duration::from_secs(1))
        .expect("first process should spawn");
    let waiting_supervisor = Arc::new(supervisor.clone());
    let (tx, rx) = mpsc::channel();
    let thread_supervisor = Arc::clone(&waiting_supervisor);
    let waiter = thread::spawn(move || {
        tx.send(thread_supervisor.spawn(long_spec, Duration::from_secs(10)))
            .expect("waiter result should be sent");
    });
    thread::sleep(Duration::from_millis(50));

    let started = Instant::now();
    waiting_supervisor.shutdown();
    assert!(started.elapsed() < Duration::from_secs(3));
    let error = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("shutdown should wake the queued waiter")
        .expect_err("queued spawn should be rejected after shutdown");
    assert!(matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::Interrupted
    ));
    assert!(first
        .wait_timeout(Duration::from_secs(2))
        .expect("shutdown process wait should succeed")
        .is_some());
    waiter.join().expect("waiter should finish");
    drop(first);
}

#[test]
fn failed_spawn_releases_its_reserved_slot() {
    let supervisor = ProcessSupervisor::new(1, 0);
    let bad = ProcessSpec {
        program: PathBuf::from(r"C:\pdf-search-no-such-process-5b2d.exe"),
        args: Vec::new(),
        env: Vec::new(),
        cwd: None,
        pipe_stderr: false,
    };
    assert!(supervisor.spawn(bad, Duration::from_millis(100)).is_err());

    let spec = python_spec("pass", &[], false);
    let process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("failed spawn must release its slot");
    let _ = wait_success(process);
}

#[test]
fn terminate_tree_is_idempotent_and_drop_reclaims_owned_process() {
    let spec = python_spec("import time; time.sleep(10)", &[], false);
    let supervisor = ProcessSupervisor::new(3, 32);
    let process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("process should spawn");
    let control = process.control();
    control
        .terminate_tree()
        .expect("first termination should succeed");
    control
        .terminate_tree()
        .expect("repeated termination should be harmless");
    let exit = process
        .wait_timeout(Duration::from_secs(5))
        .expect("wait should succeed")
        .expect("terminated process should finish");
    assert!(!exit.success());
    drop(process);

    let short_spec = python_spec("pass", &[], false);
    let process = supervisor
        .spawn(short_spec, Duration::from_secs(1))
        .expect("permit should be reclaimed after drop");
    let _ = wait_success(process);
}

#[test]
fn terminate_tree_reclaims_a_python_descendant() {
    let spec = python_spec(
        "import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); print(child.pid,flush=True); time.sleep(30)",
        &[],
        false,
    );
    let supervisor = ProcessSupervisor::new(3, 32);
    let mut process = supervisor
        .spawn(spec, Duration::from_secs(1))
        .expect("parent process should spawn");
    let stdout = process.stdout.take().expect("stdout should be piped");
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .expect("descendant pid should be readable");
    let descendant_pid = line.trim().parse::<u32>().expect("pid should be numeric");
    process
        .control()
        .terminate_tree()
        .expect("job termination should succeed");
    assert!(process
        .wait_timeout(Duration::from_secs(5))
        .expect("parent wait should succeed")
        .is_some());

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && tasklist_contains_pid(descendant_pid) {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        !tasklist_contains_pid(descendant_pid),
        "descendant process {descendant_pid} survived job termination"
    );
}

#[test]
fn job_is_reclaimed_when_host_exits() {
    const HELPER_MARKER: &str = "PDF_SEARCH_PROCESS_HELPER_PID_FILE";
    if let Some(marker) = std::env::var_os(HELPER_MARKER) {
        let spec = python_spec(
            "import subprocess,sys,time; child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); print(child.pid,flush=True); time.sleep(30)",
            &[],
            false,
        );
        let supervisor = ProcessSupervisor::new(3, 32);
        let mut process = match supervisor.spawn(spec, Duration::from_secs(1)) {
            Ok(process) => process,
            Err(_) => std::process::exit(3),
        };
        let Some(stdout) = process.stdout.take() else {
            std::process::exit(4);
        };
        let mut line = String::new();
        if BufReader::new(stdout).read_line(&mut line).is_err() {
            std::process::exit(5);
        }
        if std::fs::write(PathBuf::from(marker), line.trim()).is_err() {
            std::process::exit(6);
        }
        // Exit without running Rust destructors.  Closing the host process's
        // last Job handle must still reclaim the Python process tree.
        std::process::exit(0);
    }

    let marker = std::env::temp_dir().join(format!(
        "pdf-search-engine-process-helper-{}.pid",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let helper = Command::new(std::env::current_exe().expect("test executable path"))
        .args(["--exact", "job_is_reclaimed_when_host_exits", "--nocapture"])
        .env(HELPER_MARKER, &marker)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("host-exit helper should start");
    assert!(
        helper.status.success(),
        "host-exit helper failed: {}",
        String::from_utf8_lossy(&helper.stderr)
    );
    let pid = std::fs::read_to_string(&marker)
        .expect("host-exit helper should publish descendant PID")
        .trim()
        .parse::<u32>()
        .expect("descendant PID should be numeric");
    let _ = std::fs::remove_file(&marker);

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && tasklist_contains_pid(pid) {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !tasklist_contains_pid(pid),
        "descendant process {pid} survived host Job-handle close"
    );
}

fn tasklist_contains_pid(pid: u32) -> bool {
    let filter = format!("PID eq {pid}");
    let output = Command::new("tasklist.exe")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("tasklist.exe should be available for process-tree verification");
    assert!(
        output.status.success(),
        "tasklist.exe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line.contains(&format!("\"{pid}\"")))
}
