#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::{fs::MetadataExt, process::CommandExt};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, RunEvent};

mod batch_protocol;
mod batch_service;
mod engine_process;
mod export_bundle;
mod feedback;
mod review_v2;
use engine_process::{ProcessSpec, ProcessSupervisor};

const ENGINE_RESOURCE_DIRECTORY_NAME: &str = "engine";
const ENGINE_SCRIPT_FILE_NAME: &str = "engine.py";
#[cfg(any(test, all(target_os = "windows", not(debug_assertions))))]
const ENGINE_RUNTIME_DIRECTORY_NAME: &str = "runtime";
#[cfg(any(test, all(target_os = "windows", not(debug_assertions))))]
const ENGINE_PYTHON_EXECUTABLE_FILE_NAME: &str = "python.exe";
#[cfg(any(test, all(target_os = "windows", not(debug_assertions))))]
const BUNDLED_ENGINE_RUNTIME_ERROR: &str =
    "本地引擎运行时缺失：安装包未包含 runtime/python.exe，请重新安装完整版本";
const ENGINE_STARTUP_ERROR_TITLE: &str = "银行回单工作台无法启动";
const ENGINE_STARTUP_ERROR_MESSAGE: &str = "应用无法启动，请重新安装完整安装包。";
const ENGINE_PRIVATE_TEMP_DIRECTORY_NAME: &str = "engine-temp";
const ENGINE_PRIVATE_TEMP_ENV: &str = "PDF_SEARCH_PRIVATE_TEMP";
const ENGINE_IO_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const ENGINE_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ENGINE_PATH_BYTES: usize = 32 * 1024;
const MAX_ENGINE_KEYWORD_BYTES: usize = 16 * 1024;
const MAX_ENGINE_TASK_ID_BYTES: usize = 1024;
const MAX_ENGINE_SELECTIONS: usize = 500;
const MAX_ENGINE_MATCHES: usize = 10_000;
const MAX_ENGINE_SEGMENTS: usize = 50_000;
const MAX_ENGINE_ROWS: usize = 50_000;
const MAX_ENGINE_SEARCH_CLAUSES: usize = 32;
const MAX_ENGINE_SEARCH_CLAUSE_ID_CHARS: usize = 64;
const MAX_ENGINE_SEARCH_CLAUSE_KEYWORD_CHARS: usize = 512;
const MAX_ENGINE_SEARCH_QUERIES_BYTES: usize = 128 * 1024;
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PDF_SEARCH_MAX_FILES_ENV: &str = "PDF_SEARCH_MAX_FILES";
const DEFAULT_MAX_PDF_FILES: usize = 500;
const EXPORT_PREVIEW_DIRECTORY_NAME: &str = "export-previews";
const MAX_PREVIEW_CLEANUP_ENTRIES: usize = 4096;
const MAX_PDF_SCAN_DEPTH: usize = 64;
const MAX_PDF_SCAN_ENTRIES: usize = 100_000;
#[cfg(target_os = "windows")]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Clone)]
struct EngineRuntime {
    script_path: PathBuf,
    python_executable: PathBuf,
    private_temp_root: PathBuf,
    supervisor: ProcessSupervisor,
}

struct BatchServiceState(Result<std::sync::Arc<batch_service::BatchService>, String>);

#[tauri::command]
async fn export_bundle_command(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    export_bundle::validate_request(&request)?;
    run_engine_blocking("export_bundle", move || {
        export_bundle::execute(&app, request)
    })
    .await
}

#[tauri::command]
async fn batch_command(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    batch_service::validate_request(&request)?;
    let service = app
        .try_state::<BatchServiceState>()
        .ok_or("任务服务不可用")?
        .0
        .clone()?;
    run_engine_blocking("batch_command", move || {
        if request["op"].as_str().is_some_and(|op| {
            matches!(
                op,
                "batch_cleanup_plan" | "batch_cleanup_execute" | "batch_storage_maintain"
            )
        }) {
            let lifecycle = app
                .try_state::<PreviewLifecycle>()
                .ok_or("预览生命周期不可用")?;
            let _operation = lifecycle
                .operation
                .lock()
                .map_err(|_| "预览生命周期不可用")?;
            if !lifecycle
                .task_tokens
                .lock()
                .map_err(|_| "预览生命周期不可用")?
                .is_empty()
            {
                return Err("请先退出 PDF 导出预览，再清理历史任务".into());
            }
            service.request(request)
        } else {
            service.request(request)
        }
    })
    .await
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn direct_resource_child(parent: &Path, candidate: &Path, expected_name: &str) -> bool {
    candidate.parent().is_some_and(|candidate_parent| {
        paths_equal(candidate_parent, parent)
            && candidate
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    #[cfg(target_os = "windows")]
                    {
                        name.eq_ignore_ascii_case(expected_name)
                    }
                    #[cfg(not(target_os = "windows"))]
                    {
                        name == expected_name
                    }
                })
    })
}

fn resolve_bundled_engine_script(resource_dir: &Path) -> Result<PathBuf, String> {
    if !resource_dir.is_absolute()
        || resource_dir
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("local engine resources are unavailable".to_string());
    }

    let root_metadata = std::fs::symlink_metadata(resource_dir)
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    if !root_metadata.is_dir() || metadata_is_reparse_point(&root_metadata) {
        return Err("local engine resources are unavailable".to_string());
    }
    let root = resource_dir
        .canonicalize()
        .map_err(|_| "local engine resources are unavailable".to_string())?;

    let engine_dir_path = resource_dir.join(ENGINE_RESOURCE_DIRECTORY_NAME);
    let engine_metadata = std::fs::symlink_metadata(&engine_dir_path)
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    if !engine_metadata.is_dir() || metadata_is_reparse_point(&engine_metadata) {
        return Err("local engine resources are unavailable".to_string());
    }
    let engine_dir = engine_dir_path
        .canonicalize()
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    if !direct_resource_child(&root, &engine_dir, ENGINE_RESOURCE_DIRECTORY_NAME) {
        return Err("local engine resources are unavailable".to_string());
    }

    let script_path = engine_dir_path.join(ENGINE_SCRIPT_FILE_NAME);
    let script_metadata = std::fs::symlink_metadata(&script_path)
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    if !script_metadata.is_file() || metadata_is_reparse_point(&script_metadata) {
        return Err("local engine resources are unavailable".to_string());
    }
    let script = script_path
        .canonicalize()
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    if !direct_resource_child(&engine_dir, &script, ENGINE_SCRIPT_FILE_NAME) {
        return Err("local engine resources are unavailable".to_string());
    }
    Ok(script)
}

#[cfg(any(test, all(target_os = "windows", not(debug_assertions))))]
fn resolve_bundled_engine_python(resource_dir: &Path) -> Result<PathBuf, String> {
    let unavailable = || BUNDLED_ENGINE_RUNTIME_ERROR.to_string();
    if !resource_dir.is_absolute()
        || resource_dir
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(unavailable());
    }

    let root_metadata = std::fs::symlink_metadata(resource_dir).map_err(|_| unavailable())?;
    if !root_metadata.is_dir() || metadata_is_reparse_point(&root_metadata) {
        return Err(unavailable());
    }
    let root = resource_dir.canonicalize().map_err(|_| unavailable())?;

    let runtime_dir_path = resource_dir.join(ENGINE_RUNTIME_DIRECTORY_NAME);
    let runtime_metadata =
        std::fs::symlink_metadata(&runtime_dir_path).map_err(|_| unavailable())?;
    if !runtime_metadata.is_dir() || metadata_is_reparse_point(&runtime_metadata) {
        return Err(unavailable());
    }
    let runtime_dir = runtime_dir_path.canonicalize().map_err(|_| unavailable())?;
    if !direct_resource_child(&root, &runtime_dir, ENGINE_RUNTIME_DIRECTORY_NAME) {
        return Err(unavailable());
    }

    let python_path = runtime_dir_path.join(ENGINE_PYTHON_EXECUTABLE_FILE_NAME);
    let python_metadata = std::fs::symlink_metadata(&python_path).map_err(|_| unavailable())?;
    if !python_metadata.is_file() || metadata_is_reparse_point(&python_metadata) {
        return Err(unavailable());
    }
    let python = python_path.canonicalize().map_err(|_| unavailable())?;
    if !direct_resource_child(&runtime_dir, &python, ENGINE_PYTHON_EXECUTABLE_FILE_NAME) {
        return Err(unavailable());
    }
    Ok(python)
}

fn ensure_engine_private_temp_directory(app_cache_dir: &Path) -> Result<PathBuf, String> {
    if !app_cache_dir.is_absolute()
        || app_cache_dir
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("local engine private cache is unavailable".to_string());
    }

    match std::fs::symlink_metadata(app_cache_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_reparse_point(&metadata) => {}
        Ok(_) => return Err("local engine private cache is unavailable".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(app_cache_dir)
                .map_err(|_| "local engine private cache is unavailable".to_string())?;
        }
        Err(_) => return Err("local engine private cache is unavailable".to_string()),
    }
    let resolved_cache = app_cache_dir
        .canonicalize()
        .map_err(|_| "local engine private cache is unavailable".to_string())?;
    let private_temp_path = app_cache_dir.join(ENGINE_PRIVATE_TEMP_DIRECTORY_NAME);
    match std::fs::symlink_metadata(&private_temp_path) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_reparse_point(&metadata) => {}
        Ok(_) => return Err("local engine private cache is unavailable".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&private_temp_path)
                .map_err(|_| "local engine private cache is unavailable".to_string())?;
        }
        Err(_) => return Err("local engine private cache is unavailable".to_string()),
    }
    let resolved_temp = private_temp_path
        .canonicalize()
        .map_err(|_| "local engine private cache is unavailable".to_string())?;
    if !direct_resource_child(
        &resolved_cache,
        &resolved_temp,
        ENGINE_PRIVATE_TEMP_DIRECTORY_NAME,
    ) {
        return Err("local engine private cache is unavailable".to_string());
    }
    Ok(resolved_temp)
}

fn initialize_engine_runtime(app: &tauri::AppHandle) -> Result<EngineRuntime, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| "local engine resources are unavailable".to_string())?;
    let python_executable = resolve_engine_python(&resource_dir)?;
    let script_path = resolve_bundled_engine_script(&resource_dir)?;
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| "local engine private cache is unavailable".to_string())?;
    let private_temp_root = ensure_engine_private_temp_directory(&app_cache_dir)?;
    Ok(EngineRuntime {
        script_path,
        python_executable,
        private_temp_root,
        supervisor: ProcessSupervisor::new(3, 32),
    })
}

fn show_engine_startup_error() {
    rfd::MessageDialog::new()
        .set_title(ENGINE_STARTUP_ERROR_TITLE)
        .set_description(ENGINE_STARTUP_ERROR_MESSAGE)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

fn engine_runtime(app: &tauri::AppHandle) -> Result<EngineRuntime, String> {
    app.try_state::<EngineRuntime>()
        .map(|runtime| runtime.inner().clone())
        .ok_or_else(|| "local engine runtime is unavailable".to_string())
}

fn operation_timed_out(start: Instant, now: Instant, timeout: Duration) -> bool {
    now.saturating_duration_since(start) >= timeout
}

fn read_bounded_engine_response<R: Read>(
    mut reader: R,
    max_bytes: usize,
) -> Result<String, String> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("local engine response could not be read: {error}"))?;
        if read == 0 {
            break;
        }
        let line_end = buffer[..read]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(read);
        if response.len().saturating_add(line_end) > max_bytes {
            return Err("local engine response exceeded the size limit".to_string());
        }
        response.extend_from_slice(&buffer[..line_end]);
        if line_end < read || response.last() == Some(&b'\n') {
            break;
        }
    }
    if response.last() == Some(&b'\n') {
        response.pop();
        if response.last() == Some(&b'\r') {
            response.pop();
        }
    }
    if response.is_empty() {
        return Err("local engine returned no response".to_string());
    }
    String::from_utf8(response).map_err(|_| "local engine returned non-UTF-8 response".to_string())
}

fn review_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("review database directory is unavailable: {error}"))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("review database directory could not be created: {error}"))?;
    Ok(directory.join("pdf-search.sqlite3"))
}

#[cfg(all(target_os = "windows", debug_assertions))]
fn is_python_launcher(program: &Path) -> bool {
    program
        .file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("py.exe"))
        .unwrap_or(false)
}

fn engine_process_spec(
    runtime: &EngineRuntime,
    arguments: Vec<OsString>,
    pipe_stderr: bool,
) -> Result<ProcessSpec, String> {
    let program = runtime.python_executable.clone();
    let mut args = Vec::<OsString>::new();
    #[cfg(all(target_os = "windows", debug_assertions))]
    if is_python_launcher(&program) {
        args.push("-3.12".into());
    }
    args.extend(["-B", "-E", "-s", "-X", "utf8"].into_iter().map(OsString::from));
    args.push(runtime.script_path.as_os_str().to_owned());
    args.extend(arguments);
    // Preserve the existing fixed Python runtime and isolation configuration.
    let mut env: Vec<(OsString, Option<OsString>)> = [
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONUSERBASE",
        "PYTHONSTARTUP",
        "PYTHONWARNINGS",
        "PYTHONHASHSEED",
        "PYTHONMALLOC",
        "PYTHONFAULTHANDLER",
        "PYTHONUTF8",
        "PYTHONIOENCODING",
        "PYTHONINSPECT",
        "PYTHONDONTWRITEBYTECODE",
    ]
    .into_iter()
    .map(|name| (name.into(), None))
    .collect();
    env.push((
        ENGINE_PRIVATE_TEMP_ENV.into(),
        Some(runtime.private_temp_root.as_os_str().to_owned()),
    ));
    Ok(ProcessSpec {
        program,
        args,
        env,
        cwd: None,
        pipe_stderr,
    })
}

fn call_engine(runtime: &EngineRuntime, request: Value) -> Result<Value, String> {
    call_engine_with_timeout(runtime, request, ENGINE_OPERATION_TIMEOUT)
}

fn call_engine_with_timeout(
    runtime: &EngineRuntime,
    request: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let request_line = serde_json::to_vec(&request)
        .map_err(|error| format!("local engine request could not be encoded: {error}"))?;
    if request_line.len() > ENGINE_IO_LIMIT_BYTES {
        return Err("local engine request exceeded the size limit".to_string());
    }
    let started = Instant::now();
    let spec = engine_process_spec(runtime, vec!["--serve".into()], false)?;
    let mut child = runtime
        .supervisor
        .spawn(spec, Duration::from_secs(15))
        .map_err(|error| format!("local engine could not start: {error}"))?;
    let control = child.control();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "local engine stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "local engine stdout is unavailable".to_string())?;
    let (writer_sender, writer_receiver) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        let result = stdin
            .write_all(&request_line)
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|error| format!("local engine request failed: {error}"));
        drop(stdin);
        let _ = writer_sender.send(result);
    });
    let (reader_sender, reader_receiver) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let result = read_bounded_engine_response(stdout, ENGINE_IO_LIMIT_BYTES);
        let _ = reader_sender.send(result);
    });
    let mut status = None;
    let mut response = None;
    let mut request_result = None;
    loop {
        if request_result.is_none() {
            if let Ok(result) = writer_receiver.try_recv() {
                if result.is_err() {
                    let _ = control.terminate_tree();
                }
                request_result = Some(result);
            }
        }
        if response.is_none() {
            if let Ok(result) = reader_receiver.try_recv() {
                if result.is_err() {
                    let _ = control.terminate_tree();
                }
                response = Some(result);
            }
        }
        if status.is_none() {
            status = child
                .try_wait()
                .map_err(|error| format!("local engine could not exit cleanly: {error}"))?;
        }
        if status.is_some() && response.is_some() && request_result.is_some() {
            break;
        }
        if operation_timed_out(started, Instant::now(), timeout) {
            let _ = control.terminate_tree();
            let _ = child.wait_timeout(Duration::from_secs(2));
            let _ = writer.join();
            let _ = reader.join();
            return Err("local engine operation timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = writer.join();
    let _ = reader.join();
    let request_result = request_result.expect("request should be set when engine loop exits");
    request_result?;
    let response_line = response
        .expect("response should be set when engine loop exits")
        .map_err(|error| error.to_string())?;
    let status = status.expect("status should be set when engine loop exits");
    if !status.success() {
        return Err(format!("local engine exited with status {}", status.code));
    }
    serde_json::from_str(&response_line)
        .map_err(|error| format!("local engine returned invalid JSON: {error}"))
}

async fn run_engine_blocking<F>(operation: &'static str, task: F) -> Result<Value, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("{operation} worker failed: {error}"))?
}

fn canonical_pdf_path(path: String) -> Result<PathBuf, String> {
    if path.len() > MAX_ENGINE_PATH_BYTES {
        return Err("PDF path is too long".to_string());
    }
    let candidate = PathBuf::from(path);
    if candidate
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pdf"))
        != Some(true)
    {
        return Err("only PDF files are supported".to_string());
    }
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("PDF file is unavailable: {error}"))?;
    if !resolved.is_file() {
        return Err("PDF path is not a file".to_string());
    }
    Ok(resolved)
}

/// Ask the bundled local Python engine for its side-effect-free health payload.
#[tauri::command]
async fn engine_health(app: tauri::AppHandle) -> Result<Value, String> {
    run_engine_blocking("health", move || {
        let runtime = engine_runtime(&app)?;
        call_engine(&runtime, serde_json::json!({"op": "health"}))
    })
    .await
}

#[tauri::command]
async fn ocr_health(app: tauri::AppHandle, verify: Option<bool>) -> Result<Value, String> {
    run_engine_blocking("ocr_health", move || {
        let runtime = engine_runtime(&app)?;
        call_engine(
            &runtime,
            serde_json::json!({"op": "ocr_health", "verify": verify.unwrap_or(false)}),
        )
    })
    .await
}

#[tauri::command]
async fn ocr_cache_info(app: tauri::AppHandle) -> Result<Value, String> {
    run_engine_blocking("ocr_cache_info", move || {
        let runtime = engine_runtime(&app)?;
        call_engine(&runtime, serde_json::json!({"op": "ocr_cache_info"}))
    })
    .await
}

#[tauri::command]
async fn ocr_cache_clear(app: tauri::AppHandle) -> Result<Value, String> {
    run_engine_blocking("ocr_cache_clear", move || {
        let runtime = engine_runtime(&app)?;
        call_engine(&runtime, serde_json::json!({"op": "ocr_cache_clear"}))
    })
    .await
}

#[tauri::command]
async fn engine_search(
    app: tauri::AppHandle,
    path: String,
    keyword: String,
    exact: Option<bool>,
) -> Result<Value, String> {
    run_engine_blocking("search", move || {
        let runtime = engine_runtime(&app)?;
        let resolved = canonical_pdf_path(path)?;
        if keyword.trim().is_empty() {
            return Err("keyword is required".to_string());
        }
        ensure_text_limit(&keyword, MAX_ENGINE_KEYWORD_BYTES, "keyword is too long")?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "search",
                "path": resolved,
                "keyword": keyword,
                "exact": exact.unwrap_or(true),
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_search_multi(
    app: tauri::AppHandle,
    path: String,
    queries: Value,
    exact: Option<bool>,
) -> Result<Value, String> {
    run_engine_blocking("search_multi", move || {
        let runtime = engine_runtime(&app)?;
        let resolved = canonical_pdf_path(path)?;
        validate_search_clauses(&queries)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "search_multi",
                "path": resolved,
                "queries": queries,
                "exact": exact.unwrap_or(true),
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_render_page(
    app: tauri::AppHandle,
    path: String,
    page: u32,
    source_sha256: String,
) -> Result<Value, String> {
    run_engine_blocking("render_page", move || {
        let runtime = engine_runtime(&app)?;
        let resolved = canonical_pdf_path(path)?;
        if page == 0 {
            return Err("page must be positive".to_string());
        }
        if !valid_source_sha256(&source_sha256) {
            return Err("source SHA-256 is invalid".to_string());
        }
        let request = serde_json::json!({
            "op": "render_page",
            "path": resolved,
            "page": page,
            "source_sha256": source_sha256,
        });
        call_engine(&runtime, request)
    })
    .await
}

#[tauri::command]
async fn engine_inspect_pdf(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    run_engine_blocking("inspect_pdf", move || {
        let runtime = engine_runtime(&app)?;
        let resolved = canonical_pdf_path(path)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "inspect_pdf",
                "path": resolved,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_analyze_page(
    app: tauri::AppHandle,
    path: String,
    page: u32,
    matches: Value,
    source_sha256: String,
    include_crop_template: Option<bool>,
) -> Result<Value, String> {
    run_engine_blocking("analyze_page", move || {
        let runtime = engine_runtime(&app)?;
        let resolved = canonical_pdf_path(path)?;
        if page == 0 {
            return Err("page must be positive".to_string());
        }
        if !matches.is_array() {
            return Err("matches must be an array".to_string());
        }
        ensure_array_limit(&matches, MAX_ENGINE_MATCHES, "matches")?;
        if !valid_source_sha256(&source_sha256) {
            return Err("source SHA-256 is invalid".to_string());
        }
        let request = serde_json::json!({
            "op": "analyze_page",
            "include_crop_template": include_crop_template.unwrap_or(false),
            "path": resolved,
            "page": page,
            "matches": matches,
            "source_sha256": source_sha256,
        });
        call_engine(&runtime, request)
    })
    .await
}

#[tauri::command]
async fn engine_export_index(
    app: tauri::AppHandle,
    output_path: String,
    rows: Value,
    export_token: String,
) -> Result<Value, String> {
    run_engine_blocking("export_index", move || {
        let runtime = engine_runtime(&app)?;
        let candidate = PathBuf::from(&output_path);
        if candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            != Some("xlsx".to_string())
        {
            return Err("index output must be XLSX".to_string());
        }
        if !rows.is_array() {
            return Err("rows must be an array".to_string());
        }
        ensure_array_limit(&rows, MAX_ENGINE_ROWS, "rows")?;
        ensure_text_limit(
            &output_path,
            MAX_ENGINE_PATH_BYTES,
            "index output path is too long",
        )?;
        if !valid_export_token(&export_token) {
            return Err("export token is invalid".to_string());
        }
        let parent = candidate
            .parent()
            .ok_or_else(|| "index output directory is unavailable".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|_| "index output directory could not be created".to_string())?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "export_index",
                "output_path": candidate,
                "export_token": export_token,
                "rows": rows,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_export_pdf(
    app: tauri::AppHandle,
    output_path: String,
    selections: Value,
    export_token: String,
) -> Result<Value, String> {
    run_engine_blocking("export_pdf", move || {
        let lifecycle = app.try_state::<PreviewLifecycle>().ok_or("预览生命周期不可用")?;
        let _operation = lifecycle.operation.lock().map_err(|_| "预览生命周期不可用")?;
        let runtime = engine_runtime(&app)?;
        ensure_text_limit(
            &output_path,
            MAX_ENGINE_PATH_BYTES,
            "PDF output path is too long",
        )?;
        let candidate = PathBuf::from(&output_path);
        lifecycle.assert_open_path(&candidate, &export_token)?;
        if candidate
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pdf"))
            != Some(true)
        {
            return Err("PDF output is required".to_string());
        }
        if !selections.is_array() {
            return Err("selections must be an array".to_string());
        }
        ensure_array_limit(&selections, MAX_ENGINE_SELECTIONS, "selections")?;
        if !valid_export_token(&export_token) {
            return Err("export token is invalid".to_string());
        }
        if let Some(parent) = candidate.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|_| "PDF output directory could not be created".to_string())?;
        }
        call_engine(&runtime, serde_json::json!({"op": "export_pdf", "output_path": candidate, "export_token": export_token, "selections": selections}))
    })
    .await
}

#[tauri::command]
async fn engine_publish_preview_pdf(
    app: tauri::AppHandle,
    preview_path: String,
    output_path: String,
    preview_token: String,
    final_token: String,
) -> Result<Value, String> {
    run_engine_blocking("publish_preview_pdf", move || {
        let lifecycle = app
            .try_state::<PreviewLifecycle>()
            .ok_or("预览生命周期不可用")?;
        let _operation = lifecycle
            .operation
            .lock()
            .map_err(|_| "预览生命周期不可用")?;
        let runtime = engine_runtime(&app)?;
        if !valid_export_token(&preview_token) || !valid_export_token(&final_token) {
            return Err("export token is invalid".to_string());
        }
        if preview_token == final_token {
            return Err("preview and final export tokens must differ".to_string());
        }
        let preview = canonical_pdf_path(preview_path)?;
        lifecycle.assert_open_path(&preview, &preview_token)?;
        ensure_text_limit(
            &output_path,
            MAX_ENGINE_PATH_BYTES,
            "PDF output path is too long",
        )?;
        let output = PathBuf::from(&output_path);
        lifecycle.assert_open_path(&output, &final_token)?;
        if output
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("pdf"))
            != Some(true)
        {
            return Err("PDF output is required".to_string());
        }
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "publish_preview_pdf",
                "preview_path": preview,
                "output_path": output,
                "preview_token": preview_token,
                "final_token": final_token,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_cleanup_exports(
    app: tauri::AppHandle,
    export_token: String,
) -> Result<Value, String> {
    run_engine_blocking("cleanup_exports", move || {
        let lifecycle = app
            .try_state::<PreviewLifecycle>()
            .ok_or("预览生命周期不可用")?;
        let _operation = lifecycle
            .operation
            .lock()
            .map_err(|_| "预览生命周期不可用")?;
        let runtime = engine_runtime(&app)?;
        if !valid_export_token(&export_token) {
            return Err("export token is invalid".to_string());
        }
        let response = call_engine(
            &runtime,
            serde_json::json!({
                "op": "cleanup_exports",
                "export_token": &export_token,
            }),
        );
        // Closing a preview ends its active UI lease even if deletion failed;
        // persisted identity remains available to task cleanup for a retry.
        lifecycle.unregister_token(&export_token);
        let task = lifecycle
            .task_tokens
            .lock()
            .map_err(|_| "预览生命周期不可用")?
            .remove(&export_token);
        if task.is_some() && response.as_ref().is_ok_and(|value| value["status"] == "ok") {
            if let Some(state) = app.try_state::<BatchServiceState>() {
                if let Ok(service) = &state.0 {
                    let _ = service.release_preview(&export_token);
                }
            }
        }
        response
    })
    .await
}

#[tauri::command]
async fn engine_release_exports(
    app: tauri::AppHandle,
    export_token: String,
) -> Result<Value, String> {
    run_engine_blocking("release_exports", move || {
        let runtime = engine_runtime(&app)?;
        if !valid_export_token(&export_token) {
            return Err("export token is invalid".to_string());
        }
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "release_exports",
                "export_token": export_token,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn save_review_segments(
    app: tauri::AppHandle,
    task_id: String,
    segments: Value,
) -> Result<Value, String> {
    run_engine_blocking("save_review_segments", move || {
        if task_id.trim().is_empty() {
            return Err("task id is required".to_string());
        }
        ensure_text_limit(&task_id, MAX_ENGINE_TASK_ID_BYTES, "task id is too long")?;
        if !segments.is_array() {
            return Err("segments must be an array".to_string());
        }
        ensure_array_limit(&segments, MAX_ENGINE_SEGMENTS, "segments")?;
        let runtime = engine_runtime(&app)?;
        let database_path = review_database_path(&app)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "save_review_segments",
                "database_path": database_path,
                "task_id": task_id,
                "segments": segments,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn load_review_segments(app: tauri::AppHandle, task_id: String) -> Result<Value, String> {
    run_engine_blocking("load_review_segments", move || {
        if task_id.trim().is_empty() {
            return Err("task id is required".to_string());
        }
        ensure_text_limit(&task_id, MAX_ENGINE_TASK_ID_BYTES, "task id is too long")?;
        let runtime = engine_runtime(&app)?;
        let database_path = review_database_path(&app)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "load_review_segments",
                "database_path": database_path,
                "task_id": task_id,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn engine_computation_info(app: tauri::AppHandle) -> Result<Value, String> {
    run_engine_blocking("computation_info", move || {
        let runtime = engine_runtime(&app)?;
        call_engine(&runtime, serde_json::json!({"op": "computation_info"}))
    })
    .await
}

#[tauri::command]
async fn prepare_review_context_v2(
    app: tauri::AppHandle,
    context: Value,
    originals: Value,
    result_revision: String,
) -> Result<Value, String> {
    review_v2::prepare(&context, &originals, &result_revision)?;
    run_engine_blocking("prepare_review_context_v2", move || {
        let runtime = engine_runtime(&app)?;
        let database_path = review_database_path(&app)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "prepare_review_context_v2", "database_path": database_path,
                "context": context, "originals": originals, "result_revision": result_revision,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn read_review_snapshot_v2(
    app: tauri::AppHandle,
    context_key: String,
    result_revision: String,
) -> Result<Value, String> {
    review_v2::read(&context_key, &result_revision)?;
    run_engine_blocking("read_review_snapshot_v2", move || {
        let runtime = engine_runtime(&app)?;
        // Unlike write preparation, reading must not create the data directory.
        let database_path = app
            .path()
            .app_data_dir()
            .map_err(|_| "review database directory is unavailable")?
            .join("pdf-search.sqlite3");
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "read_review_snapshot_v2", "database_path": database_path,
                "context_key": context_key, "result_revision": result_revision,
            }),
        )
    })
    .await
}

#[tauri::command]
async fn save_review_segments_v2(
    app: tauri::AppHandle,
    context_key: String,
    result_revision: String,
    segments: Value,
    confirm_group: bool,
) -> Result<Value, String> {
    review_v2::save(&context_key, &result_revision, &segments)?;
    run_engine_blocking("save_review_segments_v2", move || {
        let runtime = engine_runtime(&app)?;
        let database_path = review_database_path(&app)?;
        call_engine(
            &runtime,
            serde_json::json!({
                "op": "save_review_segments_v2", "database_path": database_path,
                "context_key": context_key, "result_revision": result_revision,
                "segments": segments, "confirm_group": confirm_group,
            }),
        )
    })
    .await
}

/// Parse the batch file limit without accepting whitespace, signs, or other
/// numeric formats. Invalid values fall back to the conservative default and
/// only the variable name is written to stderr.
fn parse_max_pdf_files(raw: Option<&str>) -> usize {
    let Some(value) = raw else {
        return DEFAULT_MAX_PDF_FILES;
    };
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
        if let Ok(limit) = value.parse::<usize>() {
            if limit > 0 {
                return limit;
            }
        }
    }

    eprintln!("invalid {PDF_SEARCH_MAX_FILES_ENV}; using default {DEFAULT_MAX_PDF_FILES}");
    DEFAULT_MAX_PDF_FILES
}

fn configured_max_pdf_files() -> usize {
    parse_max_pdf_files(std::env::var(PDF_SEARCH_MAX_FILES_ENV).ok().as_deref())
}

fn report_file_limit_exceeded() {
    eprintln!("PDF file selection exceeded the configured limit; returning no files");
}

fn apply_pdf_file_limit(paths: Vec<PathBuf>, max_files: usize) -> Vec<String> {
    if paths.len() > max_files {
        report_file_limit_exceeded();
        return Vec::new();
    }
    paths
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

fn valid_export_token(token: &str) -> bool {
    let mut characters = token.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (16..=128).contains(&token.len())
        && first.is_ascii_alphanumeric()
        && characters.all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '_'))
}

fn valid_source_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_text_limit(value: &str, max_bytes: usize, field_error: &str) -> Result<(), String> {
    if value.len() > max_bytes {
        Err(field_error.to_string())
    } else {
        Ok(())
    }
}

fn ensure_array_limit(value: &Value, max_items: usize, field: &str) -> Result<(), String> {
    match value.as_array() {
        Some(items) if items.len() <= max_items => Ok(()),
        Some(_) => Err(format!("{field} contains too many items")),
        None => Err(format!("{field} must be an array")),
    }
}

fn validate_search_clauses(queries: &Value) -> Result<(), String> {
    ensure_array_limit(queries, MAX_ENGINE_SEARCH_CLAUSES, "queries")?;
    let clauses = queries
        .as_array()
        .ok_or_else(|| "queries must be an array".to_string())?;
    if clauses.is_empty() {
        return Err("queries must contain at least one clause".to_string());
    }

    let serialized =
        serde_json::to_vec(queries).map_err(|_| "queries could not be encoded".to_string())?;
    if serialized.len() > MAX_ENGINE_SEARCH_QUERIES_BYTES {
        return Err("queries exceeded the size limit".to_string());
    }

    let mut ids = BTreeSet::new();
    let mut include_count = 0_usize;
    for clause in clauses {
        let object = clause
            .as_object()
            .ok_or_else(|| "each query must be an object".to_string())?;

        let id = object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "query id must be a string".to_string())?;
        if !(1..=MAX_ENGINE_SEARCH_CLAUSE_ID_CHARS).contains(&id.chars().count())
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("query id is invalid".to_string());
        }
        if !ids.insert(id) {
            return Err("query ids must be unique".to_string());
        }

        let keyword = object
            .get("keyword")
            .and_then(Value::as_str)
            .ok_or_else(|| "query keyword must be a string".to_string())?;
        let trimmed_keyword = keyword.trim();
        if !(1..=MAX_ENGINE_SEARCH_CLAUSE_KEYWORD_CHARS).contains(&trimmed_keyword.chars().count())
        {
            return Err("query keyword is invalid".to_string());
        }
        ensure_text_limit(
            trimmed_keyword,
            MAX_ENGINE_KEYWORD_BYTES,
            "query keyword is too long",
        )?;

        let role = object
            .get("role")
            .and_then(Value::as_str)
            .ok_or_else(|| "query role must be a string".to_string())?;
        match role {
            "include" => include_count += 1,
            "exclude" => {}
            _ => return Err("query role is invalid".to_string()),
        }
    }

    if include_count == 0 {
        return Err("queries must contain an include clause".to_string());
    }
    Ok(())
}

fn managed_preview_path(root: &Path, token: &str) -> Result<PathBuf, String> {
    if !preview_root_is_dedicated(root) {
        return Err("export preview directory is invalid".to_string());
    }
    if !valid_export_token(token) {
        return Err("export preview token is invalid".to_string());
    }
    let path = root.join(format!("{token}.pdf"));
    if path.parent() != Some(root) {
        return Err("export preview path is invalid".to_string());
    }
    Ok(path)
}

fn preview_root_is_dedicated(root: &Path) -> bool {
    root.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == EXPORT_PREVIEW_DIRECTORY_NAME)
        && !root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        metadata.file_type().is_symlink()
    }
}

fn ensure_managed_preview_directory(root: &Path) -> Result<(), String> {
    if !preview_root_is_dedicated(root) {
        return Err("preview cache directory is not dedicated".to_string());
    }
    match std::fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.is_dir() && !metadata_is_reparse_point(&metadata) {
                return Ok(());
            }
            Err("preview cache directory is not a safe directory".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(root).map_err(|error| {
                format!("preview cache directory could not be created: {error}")
            })?;
            let metadata = std::fs::symlink_metadata(root).map_err(|error| {
                format!("preview cache directory could not be inspected: {error}")
            })?;
            if metadata.is_dir() && !metadata_is_reparse_point(&metadata) {
                Ok(())
            } else {
                Err("preview cache directory is not a safe directory".to_string())
            }
        }
        Err(error) => Err(format!("preview cache directory is unavailable: {error}")),
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
struct PreviewCleanupReport {
    cleaned_count: usize,
    failed_count: usize,
}

fn safe_preview_file(root: &Path, path: &Path) -> bool {
    if path.parent() != Some(root) {
        return false;
    }
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    let Some(token) = name.strip_suffix(".pdf") else {
        return false;
    };
    if !valid_export_token(token) {
        return false;
    }
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    metadata.is_file() && !metadata_is_reparse_point(&metadata)
}

fn normalize_windows_final_path(path: &str) -> String {
    let mut normalized = path.replace('/', "\\");
    while normalized.len() > 1 && normalized.ends_with('\\') {
        normalized.pop();
    }
    normalized.to_ascii_lowercase()
}

/// Check final-path containment using only normalized absolute Windows paths.
/// The child must be an immediate file below the managed root and keep the
/// exact enumerated filename; parent components such as `..` never match.
fn windows_final_path_is_direct_child(
    expected_root: &str,
    child_final_path: &str,
    expected_name: &str,
) -> bool {
    let root = normalize_windows_final_path(expected_root);
    let child = normalize_windows_final_path(child_final_path);
    let name = normalize_windows_final_path(expected_name);
    let Some(separator) = child.rfind('\\') else {
        return false;
    };
    let (parent, child_name) = child.split_at(separator);
    parent == root && child_name.trim_start_matches('\\') == name
}

#[cfg(target_os = "windows")]
mod windows_preview_cleanup {
    use super::{windows_final_path_is_direct_child, Path};
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const DELETE: u32 = 0x0001_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_NAME_NORMALIZED: u32 = 0;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    const FILE_ATTRIBUTE_TAG_INFO_CLASS: u32 = 9;
    const FILE_DISPOSITION_INFO_CLASS: u32 = 4;

    #[repr(C)]
    struct FileAttributeTagInfo {
        file_attributes: u32,
        reparse_tag: u32,
    }

    #[repr(C)]
    struct FileDispositionInfo {
        delete_file: u8,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *const c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetFinalPathNameByHandleW(
            handle: Handle,
            file_path: *mut u16,
            file_path_length: u32,
            flags: u32,
        ) -> u32;
        fn GetFileInformationByHandleEx(
            handle: Handle,
            file_information_class: u32,
            file_information: *mut c_void,
            buffer_size: u32,
        ) -> i32;
        fn SetFileInformationByHandle(
            handle: Handle,
            file_information_class: u32,
            file_information: *const c_void,
            buffer_size: u32,
        ) -> i32;
    }

    struct OwnedHandle(Handle);

    impl OwnedHandle {
        fn open(path: &Path, desired_access: u32, directory: bool) -> Option<Self> {
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
            let flags = FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                };
            // SAFETY: `wide` is NUL-terminated and remains alive for the
            // duration of the call. The optional security/template pointers
            // are null by contract, and the returned handle is checked
            // against INVALID_HANDLE_VALUE before ownership is accepted.
            let handle = unsafe {
                CreateFileW(
                    wide.as_mut_ptr(),
                    desired_access,
                    FILE_SHARE_READ,
                    null(),
                    OPEN_EXISTING,
                    flags,
                    null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                None
            } else {
                Some(Self(handle))
            }
        }

        fn final_path(&self) -> Option<String> {
            let mut buffer = vec![0u16; 512];
            loop {
                // SAFETY: `self.0` is a live handle owned by this value and
                // `buffer` exposes a writable allocation of exactly the
                // advertised length. Windows either writes within that bound
                // or returns the larger required length, which is handled by
                // resizing before the next call.
                let length = unsafe {
                    GetFinalPathNameByHandleW(
                        self.0,
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        FILE_NAME_NORMALIZED,
                    )
                };
                if length == 0 {
                    return None;
                }
                if (length as usize) < buffer.len() {
                    return String::from_utf16(&buffer[..length as usize]).ok();
                }
                if buffer.len() >= 32_768 {
                    return None;
                }
                buffer.resize(buffer.len() * 2, 0);
            }
        }

        fn attributes(&self) -> Option<u32> {
            let mut info = FileAttributeTagInfo {
                file_attributes: 0,
                reparse_tag: 0,
            };
            // SAFETY: `self.0` is valid, `FileAttributeTagInfo` has the Win32
            // C layout, and the pointer and byte count describe the same live
            // stack value for the duration of this synchronous call.
            let success = unsafe {
                GetFileInformationByHandleEx(
                    self.0,
                    FILE_ATTRIBUTE_TAG_INFO_CLASS,
                    (&mut info as *mut FileAttributeTagInfo).cast(),
                    std::mem::size_of::<FileAttributeTagInfo>() as u32,
                )
            };
            (success != 0).then_some(info.file_attributes)
        }

        fn mark_for_delete(&self) -> bool {
            let info = FileDispositionInfo { delete_file: 1 };
            // SAFETY: the handle was opened with DELETE access;
            // `FileDispositionInfo` has the required Win32 C layout, and its
            // pointer remains valid for the exact size passed to the call.
            unsafe {
                SetFileInformationByHandle(
                    self.0,
                    FILE_DISPOSITION_INFO_CLASS,
                    (&info as *const FileDispositionInfo).cast(),
                    std::mem::size_of::<FileDispositionInfo>() as u32,
                ) != 0
            }
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: `OwnedHandle` is created only for a non-invalid Win32
            // handle and is its sole owner. Drop runs once, so this is the
            // unique matching close operation.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub(super) fn remove_if_safe(
        root: &Path,
        expected_root: &Path,
        path: &Path,
    ) -> Result<bool, ()> {
        let root_handle = OwnedHandle::open(
            root,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            true,
        )
        .ok_or(())?;
        let root_attributes = root_handle.attributes().ok_or(())?;
        if root_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
            != FILE_ATTRIBUTE_DIRECTORY
        {
            return Ok(false);
        }
        let root_final = root_handle.final_path().ok_or(())?;
        let expected_root_string = expected_root.to_string_lossy();
        if super::normalize_windows_final_path(&root_final)
            != super::normalize_windows_final_path(&expected_root_string)
        {
            return Ok(false);
        }

        let child_handle =
            OwnedHandle::open(path, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, false).ok_or(())?;
        let child_attributes = child_handle.attributes().ok_or(())?;
        if child_attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Ok(false);
        }
        let child_final = child_handle.final_path().ok_or(())?;
        let expected_name = path.file_name().ok_or(())?.to_string_lossy();
        if !windows_final_path_is_direct_child(&expected_root_string, &child_final, &expected_name)
        {
            return Ok(false);
        }
        Ok(child_handle.mark_for_delete())
    }
}

#[cfg(target_os = "windows")]
fn remove_if_safe(root: &Path, expected_root: &Path, path: &Path) -> Result<bool, ()> {
    windows_preview_cleanup::remove_if_safe(root, expected_root, path)
}

#[cfg(not(target_os = "windows"))]
fn same_preview_file_metadata(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.len() == right.len()
            && left.modified().ok() == right.modified().ok()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len() && left.modified().ok() == right.modified().ok()
    }
}

#[cfg(not(target_os = "windows"))]
fn remove_if_safe(root: &Path, expected_root: &Path, path: &Path) -> Result<bool, ()> {
    let current_root = std::fs::canonicalize(root).map_err(|_| ())?;
    if current_root != expected_root {
        return Ok(false);
    }
    let parent = path.parent().ok_or(())?;
    if std::fs::canonicalize(parent).map_err(|_| ())? != expected_root {
        return Ok(false);
    }
    let before = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Ok(false);
    }
    let after = std::fs::symlink_metadata(path).map_err(|_| ())?;
    if !same_preview_file_metadata(&before, &after) {
        return Ok(false);
    }
    std::fs::remove_file(path).map(|()| true).map_err(|_| ())
}

/// Remove only direct, regular PDF files in the app's dedicated preview
/// directory. Unknown files, nested directories, links and reparse points are
/// intentionally left untouched so a cleanup failure cannot escape its scope.
fn cleanup_preview_directory_with_expected_root(
    root: &Path,
    expected_root: &Path,
) -> PreviewCleanupReport {
    let mut report = PreviewCleanupReport::default();
    if !preview_root_is_dedicated(root) {
        report.failed_count = 1;
        return report;
    }
    let Ok(root_metadata) = std::fs::symlink_metadata(root) else {
        return report;
    };
    if !root_metadata.is_dir() || metadata_is_reparse_point(&root_metadata) {
        report.failed_count = 1;
        return report;
    }
    if std::fs::canonicalize(root).ok().as_deref() != Some(expected_root) {
        report.failed_count = 1;
        return report;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        report.failed_count = 1;
        return report;
    };
    let mut paths = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_PREVIEW_CLEANUP_ENTRIES {
            report.failed_count += 1;
            break;
        }
        let Ok(entry) = entry else {
            report.failed_count += 1;
            continue;
        };
        paths.push(entry.path());
    }
    for path in paths {
        if !safe_preview_file(root, &path) {
            continue;
        }
        match remove_if_safe(root, expected_root, &path) {
            Ok(true) => report.cleaned_count += 1,
            Ok(false) => {}
            Err(()) => report.failed_count += 1,
        }
    }
    report
}

#[cfg(test)]
fn cleanup_preview_directory(root: &Path) -> PreviewCleanupReport {
    let Ok(expected_root) = std::fs::canonicalize(root) else {
        return PreviewCleanupReport {
            cleaned_count: 0,
            failed_count: 1,
        };
    };
    cleanup_preview_directory_with_expected_root(root, &expected_root)
}

struct PreviewLifecycle {
    root: PathBuf,
    resolved_root: PathBuf,
    tokens: Mutex<BTreeSet<String>>,
    task_tokens: Mutex<BTreeMap<String, String>>,
    // Serializes managed allocation, production, close and task cleanup.
    // It is not shared with source preview or batch pause/cancel operations.
    operation: Mutex<()>,
    cleanup_started: AtomicBool,
}

impl PreviewLifecycle {
    fn new(root: PathBuf, resolved_root: PathBuf) -> Self {
        Self {
            root,
            resolved_root,
            tokens: Mutex::new(BTreeSet::new()),
            task_tokens: Mutex::new(BTreeMap::new()),
            operation: Mutex::new(()),
            cleanup_started: AtomicBool::new(false),
        }
    }

    fn register_token(&self, token: &str) -> bool {
        self.tokens
            .lock()
            .map(|mut tokens| tokens.insert(token.to_string()))
            .unwrap_or(false)
    }

    fn unregister_token(&self, token: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(token);
        }
    }

    fn assert_open_path(&self, path: &Path, token: &str) -> Result<(), String> {
        let lexical_managed = path.parent().is_some_and(|parent| {
            paths_equal(parent, &self.root) || paths_equal(parent, &self.resolved_root)
        });
        let managed = path
            .parent()
            .and_then(|parent| std::fs::canonicalize(parent).ok())
            .is_some_and(|parent| paths_equal(&parent, &self.resolved_root));
        if lexical_managed && !managed {
            return Err("PDF 预览目录已变化，请重新启动应用".into());
        }
        if managed
            && path.file_name().and_then(|name| name.to_str()) != Some(&format!("{token}.pdf"))
        {
            return Err("PDF 预览路径与令牌不一致".into());
        }
        if managed
            && !self
                .tokens
                .lock()
                .map_err(|_| "预览生命周期不可用")?
                .contains(token)
        {
            return Err("PDF 导出预览已关闭，请重新生成".into());
        }
        Ok(())
    }

    fn cleanup_on_exit(&self) {
        if self.cleanup_started.swap(true, Ordering::AcqRel) {
            return;
        }

        // Exit handling is deliberately local and bounded. Starting a Python
        // process for every token here could delay or prevent application
        // shutdown; the next startup repeats the same safe sweep if needed.
        let report = cleanup_preview_directory_with_expected_root(&self.root, &self.resolved_root);
        if report.failed_count > 0 {
            eprintln!(
                "preview cleanup left {} file(s) for the next startup sweep",
                report.failed_count
            );
        }
    }
}

fn app_preview_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join(EXPORT_PREVIEW_DIRECTORY_NAME))
        .map_err(|error| format!("preview cache directory is unavailable: {error}"))
}

fn initialize_preview_lifecycle(app: &tauri::AppHandle) -> Result<PreviewLifecycle, String> {
    let root = app_preview_root(app)?;
    ensure_managed_preview_directory(&root)?;
    let resolved_root = std::fs::canonicalize(&root)
        .map_err(|error| format!("preview cache directory could not be resolved: {error}"))?;
    let report = cleanup_preview_directory_with_expected_root(&root, &resolved_root);
    if report.failed_count > 0 {
        eprintln!(
            "preview startup cleanup left {} file(s) for a future retry",
            report.failed_count
        );
    }
    Ok(PreviewLifecycle::new(root, resolved_root))
}

#[tauri::command]
async fn create_export_preview_path(
    app: tauri::AppHandle,
    export_token: String,
    batch_job_id: Option<String>,
) -> Result<String, String> {
    let result = run_engine_blocking("create_export_preview_path", move || {
        let lifecycle = app
            .try_state::<PreviewLifecycle>()
            .ok_or_else(|| "preview lifecycle is unavailable".to_string())?;
        let _operation = lifecycle
            .operation
            .lock()
            .map_err(|_| "预览生命周期不可用")?;
        let root = app_preview_root(&app)?;
        ensure_managed_preview_directory(&root)?;
        if std::fs::canonicalize(&root).ok().as_deref() != Some(&lifecycle.resolved_root) {
            return Err("PDF 预览目录已变化".into());
        }
        let path = managed_preview_path(&root, &export_token)?;
        if lifecycle
            .tokens
            .lock()
            .map_err(|_| "预览生命周期不可用")?
            .contains(&export_token)
        {
            return Err("PDF 预览令牌已在使用".into());
        }
        match std::fs::symlink_metadata(&path) {
            Ok(_) => return Err("preview output already exists".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("preview output is unavailable: {error}")),
        }
        if let Some(job_id) = batch_job_id {
            if job_id.is_empty() || job_id.len() > 128 {
                return Err("任务标识无效".into());
            }
            let service = app
                .try_state::<BatchServiceState>()
                .ok_or("任务服务不可用")?
                .0
                .clone()?;
            service.register_preview(&job_id, &export_token, &root)?;
            lifecycle
                .task_tokens
                .lock()
                .map_err(|_| "预览生命周期不可用")?
                .insert(export_token.clone(), job_id);
        }
        if !lifecycle.register_token(&export_token) {
            return Err("preview lifecycle is unavailable".to_string());
        }
        Ok(Value::String(path.to_string_lossy().into_owned()))
    })
    .await?;
    result
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "预览路径无效".into())
}

#[cfg(target_os = "windows")]
fn system_binary_is_direct_child(root: &Path, candidate: &Path, expected_name: &str) -> bool {
    candidate.parent().map(|parent| {
        parent
            .to_string_lossy()
            .eq_ignore_ascii_case(&root.to_string_lossy())
    }) == Some(true)
        && candidate
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(expected_name))
}

#[cfg(target_os = "windows")]
fn trusted_windows_root() -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetWindowsDirectoryW(buffer: *mut u16, length: u32) -> u32;
    }

    let mut buffer = vec![0_u16; 260];
    loop {
        // SAFETY: The buffer is writable for the advertised length. The
        // Windows API writes at most that many UTF-16 code units and returns
        // the required size if it does not fit.
        let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err("Windows system directory is unavailable".to_string());
        }
        if (length as usize) < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(
                &buffer[..length as usize],
            )));
        }
        let required = (length as usize).saturating_add(1);
        if required > 32_768 {
            return Err("Windows system directory is invalid".to_string());
        }
        buffer.resize(required.max(buffer.len().saturating_mul(2)), 0);
    }
}

#[cfg(target_os = "windows")]
fn trusted_system_binary(binary_name: &str) -> Result<PathBuf, String> {
    let root = trusted_windows_root()?;
    if !root.is_absolute() {
        return Err("Windows system directory is invalid".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("Windows system directory is unavailable: {error}"))?;
    let root_metadata = std::fs::symlink_metadata(&root)
        .map_err(|error| format!("Windows system directory is unavailable: {error}"))?;
    if !root.is_dir() || metadata_is_reparse_point(&root_metadata) {
        return Err("Windows system directory is invalid".to_string());
    }
    let binary = root.join(binary_name);
    let binary_metadata = std::fs::symlink_metadata(&binary)
        .map_err(|error| format!("Windows system binary is unavailable: {error}"))?;
    if !binary_metadata.is_file() || metadata_is_reparse_point(&binary_metadata) {
        return Err("Windows system binary is invalid".to_string());
    }
    let resolved = binary
        .canonicalize()
        .map_err(|error| format!("Windows system binary is unavailable: {error}"))?;
    if !resolved.is_file() || !system_binary_is_direct_child(&root, &resolved, binary_name) {
        return Err("Windows system binary path is invalid".to_string());
    }
    Ok(resolved)
}

#[cfg(all(target_os = "windows", debug_assertions))]
fn resolve_engine_python(_resource_dir: &Path) -> Result<PathBuf, String> {
    trusted_system_binary("py.exe")
        .map_err(|_| "本地引擎 Python 启动器不可用（开发模式需要系统 py.exe）".to_string())
}

#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn resolve_engine_python(resource_dir: &Path) -> Result<PathBuf, String> {
    resolve_bundled_engine_python(resource_dir)
}

#[cfg(not(target_os = "windows"))]
fn resolve_engine_python(_resource_dir: &Path) -> Result<PathBuf, String> {
    ["/usr/local/bin/python3", "/usr/bin/python3"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or_else(|| "local engine Python interpreter is unavailable".to_string())
}

#[cfg(target_os = "windows")]
fn trusted_system_explorer() -> Result<PathBuf, String> {
    trusted_system_binary("explorer.exe")
}

#[derive(serde::Serialize)]
struct PdfPickerResult {
    files: Vec<String>,
    directory: Option<String>,
}

fn picker_dialog_directory(initial_directory: Option<&str>) -> Option<PathBuf> {
    initial_directory.and_then(|value| canonical_regular_directory(Path::new(value)))
}

fn picker_dialog(initial_directory: Option<String>) -> rfd::FileDialog {
    match picker_dialog_directory(initial_directory.as_deref()) {
        Some(directory) => rfd::FileDialog::new().set_directory(directory),
        None => rfd::FileDialog::new(),
    }
}

#[tauri::command]
fn pick_pdf_files(initial_directory: Option<String>) -> PdfPickerResult {
    let max_files = configured_max_pdf_files();
    let paths = picker_dialog(initial_directory)
        .add_filter("PDF", &["pdf"])
        .pick_files()
        .unwrap_or_default();
    let files = apply_pdf_file_limit(paths, max_files);
    let directory = files.first().and_then(|path| {
        Path::new(path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
    });
    PdfPickerResult { files, directory }
}

fn canonical_regular_directory(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
        return None;
    }
    let resolved = path.canonicalize().ok()?;
    let resolved_metadata = std::fs::symlink_metadata(&resolved).ok()?;
    (resolved_metadata.is_dir() && !metadata_is_reparse_point(&resolved_metadata))
        .then_some(resolved)
}

fn canonical_directory_key(path: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(path.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_path_buf()
    }
}

/// Recursively collect PDF paths, stopping as soon as a configured safety
/// boundary is reached. Links and reparse points are skipped, never followed.
/// The caller returns an empty list when this function reports an overflow or
/// an incomplete scan, so a batch is never silently truncated.
fn collect_pdf_files(folder: &Path, files: &mut Vec<String>, max_files: usize) -> bool {
    collect_pdf_files_with_limits(
        folder,
        files,
        max_files,
        MAX_PDF_SCAN_DEPTH,
        MAX_PDF_SCAN_ENTRIES,
    )
}

fn collect_pdf_files_with_limits(
    folder: &Path,
    files: &mut Vec<String>,
    max_files: usize,
    max_depth: usize,
    max_entries: usize,
) -> bool {
    let mut scan = PdfScanState {
        files,
        max_files,
        max_depth,
        max_entries,
        scanned_entries: 0,
        visited: BTreeSet::new(),
    };
    scan.collect(folder, 0)
}

struct PdfScanState<'a> {
    files: &'a mut Vec<String>,
    max_files: usize,
    max_depth: usize,
    max_entries: usize,
    scanned_entries: usize,
    visited: BTreeSet<PathBuf>,
}

impl PdfScanState<'_> {
    fn collect(&mut self, folder: &Path, depth: usize) -> bool {
        let Some(resolved_folder) = canonical_regular_directory(folder) else {
            return false;
        };
        if !self
            .visited
            .insert(canonical_directory_key(&resolved_folder))
        {
            return false;
        }

        let Ok(entries) = std::fs::read_dir(&resolved_folder) else {
            return false;
        };
        for entry in entries {
            self.scanned_entries = self.scanned_entries.saturating_add(1);
            if self.scanned_entries > self.max_entries {
                return false;
            }
            let Ok(entry) = entry else {
                return false;
            };
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return false;
            };
            if metadata_is_reparse_point(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                if depth >= self.max_depth || !self.collect(&path, depth + 1) {
                    return false;
                }
            } else if metadata.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.eq_ignore_ascii_case("pdf"))
                    .unwrap_or(false)
            {
                if self.files.len() >= self.max_files {
                    return false;
                }
                self.files.push(path.to_string_lossy().into_owned());
            }
        }
        true
    }
}

#[tauri::command]
fn pick_pdf_folder(initial_directory: Option<String>) -> PdfPickerResult {
    let Some(folder) = picker_dialog(initial_directory).pick_folder() else {
        return PdfPickerResult {
            files: Vec::new(),
            directory: None,
        };
    };
    let directory = Some(folder.to_string_lossy().into_owned());
    let max_files = configured_max_pdf_files();
    let mut files = Vec::new();
    if !collect_pdf_files(&folder, &mut files, max_files) {
        report_file_limit_exceeded();
        return PdfPickerResult {
            files: Vec::new(),
            directory,
        };
    }
    files.sort();
    PdfPickerResult { files, directory }
}

#[tauri::command]
fn pick_directory(initial_directory: Option<String>) -> Option<String> {
    picker_dialog(initial_directory)
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn validate_directory(path: String) -> bool {
    canonical_regular_directory(Path::new(&path)).is_some()
}

#[tauri::command]
fn pick_output_folder(initial_directory: Option<String>) -> Option<String> {
    picker_dialog(initial_directory)
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_output_folder(path: String) -> Result<(), String> {
    let candidate = PathBuf::from(path);
    let folder = if candidate.is_dir() {
        candidate
    } else {
        candidate
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "output directory is unavailable".to_string())?
    };
    if !folder.is_dir() {
        return Err("output directory does not exist".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let explorer = trusted_system_explorer()?;
        let mut command = Command::new(explorer);
        command.arg(folder).creation_flags(WINDOWS_CREATE_NO_WINDOW);
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not open output directory: {error}"))
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(folder)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not open output directory: {error}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("could not open output directory: {error}"))
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        let _ = folder;
        Err("opening output directories is unsupported on this platform".to_string())
    }
}

fn main() {
    let application = tauri::Builder::default()
        .setup(|app| {
            let engine_runtime = match initialize_engine_runtime(app.handle()) {
                Ok(runtime) => runtime,
                Err(_) => {
                    return Err("local engine initialization failed".to_string().into());
                }
            };
            let batch = review_database_path(app.handle()).and_then(|database| {
                let handle = app.handle().clone();
                batch_service::BatchService::new(
                    engine_runtime.clone(),
                    database.parent().ok_or("任务目录不可用")?,
                    std::sync::Arc::new(move |event| {
                        let _ = handle.emit("batch-task-event", event);
                    }),
                )
            });
            app.manage(BatchServiceState(batch));
            app.manage(engine_runtime);
            let lifecycle = initialize_preview_lifecycle(app.handle())?;
            app.manage(lifecycle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_health,
            ocr_health,
            ocr_cache_info,
            ocr_cache_clear,
            engine_search,
            engine_search_multi,
            engine_render_page,
            engine_inspect_pdf,
            engine_analyze_page,
            engine_export_index,
            engine_export_pdf,
            engine_publish_preview_pdf,
            engine_cleanup_exports,
            engine_release_exports,
            save_review_segments,
            load_review_segments,
            engine_computation_info,
            prepare_review_context_v2,
            read_review_snapshot_v2,
            save_review_segments_v2,
            batch_command,
            export_bundle_command,
            pick_pdf_files,
            pick_pdf_folder,
            pick_directory,
            validate_directory,
            create_export_preview_path,
            pick_output_folder,
            open_output_folder,
            feedback::save_feedback_report
        ])
        .build(tauri::generate_context!());
    let Ok(application) = application else {
        show_engine_startup_error();
        return;
    };
    application.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(service) = app.try_state::<BatchServiceState>() {
                if let Ok(service) = &service.0 {
                    service.shutdown();
                }
            }
            if let Some(runtime) = app.try_state::<EngineRuntime>() {
                runtime.supervisor.shutdown();
            }
            if let Some(lifecycle) = app.try_state::<PreviewLifecycle>() {
                lifecycle.cleanup_on_exit();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::system_binary_is_direct_child;
    #[cfg(unix)]
    use super::ENGINE_PRIVATE_TEMP_DIRECTORY_NAME;
    use super::{
        apply_pdf_file_limit, canonical_pdf_path, cleanup_preview_directory, collect_pdf_files,
        collect_pdf_files_with_limits, engine_inspect_pdf, ensure_array_limit,
        ensure_engine_private_temp_directory, ensure_managed_preview_directory, ensure_text_limit,
        managed_preview_path, operation_timed_out, parse_max_pdf_files, picker_dialog_directory,
        read_bounded_engine_response, resolve_bundled_engine_python, resolve_bundled_engine_script,
        resolve_engine_python, valid_export_token, valid_source_sha256, validate_directory,
        windows_final_path_is_direct_child, PreviewLifecycle, BUNDLED_ENGINE_RUNTIME_ERROR,
        DEFAULT_MAX_PDF_FILES, ENGINE_PYTHON_EXECUTABLE_FILE_NAME, ENGINE_RUNTIME_DIRECTORY_NAME,
        EXPORT_PREVIEW_DIRECTORY_NAME, MAX_ENGINE_MATCHES, MAX_ENGINE_PATH_BYTES,
        MAX_ENGINE_SELECTIONS, MAX_PREVIEW_CLEANUP_ENTRIES, WINDOWS_CREATE_NO_WINDOW,
    };
    use serde_json::Value;
    use std::io::Cursor;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn review_geometry_survives_json_bridge_roundtrip() {
        // Real PDF coordinates can require all 17 decimal digits. The default
        // serde_json parser once rounded this y1 up by one f64 ULP, making an
        // unchanged group confirmation fail the immutable manifest comparison.
        for decimal in ["410.95098876953125", "800.2850341796875", "0.9899999999999999"] {
            let expected = decimal.parse::<f64>().unwrap().to_bits();
            let wire = format!(r#"{{"candidate_rect":{{"y1":{decimal}}}}}"#);
            let from_engine: Value = serde_json::from_str(&wire).unwrap();
            assert_eq!(from_engine["candidate_rect"]["y1"].as_f64().unwrap().to_bits(), expected);
            let webview_wire = serde_json::to_string(&from_engine).unwrap();
            let save_request: Value = serde_json::from_str(&webview_wire).unwrap();
            assert_eq!(save_request["candidate_rect"]["y1"].as_f64().unwrap().to_bits(), expected);
        }
    }

    fn test_preview_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "pdf-search-preview-test-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system clock is before UNIX epoch")
                    .as_nanos()
            ))
            .join(EXPORT_PREVIEW_DIRECTORY_NAME)
    }

    fn test_resource_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pdf-search-resource-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before UNIX epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn validate_directory_only_accepts_existing_directories() {
        let root = test_resource_root("validate-directory");
        std::fs::create_dir_all(&root).expect("validation directory should be created");
        let file = root.join("not-a-directory.txt");
        std::fs::write(&file, b"not a directory").expect("validation file should be created");
        let missing = root.join("missing");

        assert!(validate_directory(root.to_string_lossy().into_owned()));
        assert!(!validate_directory(String::new()));
        assert!(!validate_directory(missing.to_string_lossy().into_owned()));
        assert!(!validate_directory(file.to_string_lossy().into_owned()));

        std::fs::remove_dir_all(root).expect("validation directory should be removed");
    }

    #[test]
    fn picker_dialog_uses_a_canonical_initial_directory() {
        let root = test_resource_root("picker-valid");
        std::fs::create_dir_all(&root).expect("picker directory should be created");
        let expected = root
            .canonicalize()
            .expect("picker directory should resolve canonically");

        assert_eq!(
            picker_dialog_directory(Some(root.to_string_lossy().as_ref())),
            Some(expected)
        );

        std::fs::remove_dir_all(root).expect("picker directory should be removed");
    }

    #[test]
    fn picker_dialog_falls_back_for_an_invalid_or_missing_initial_directory() {
        let root = test_resource_root("picker-invalid");
        std::fs::create_dir_all(&root).expect("picker test root should be created");
        let file = root.join("not-a-directory.txt");
        std::fs::write(&file, b"not a directory").expect("picker test file should be created");
        let missing = root.join("missing");

        assert_eq!(
            picker_dialog_directory(Some(file.to_string_lossy().as_ref())),
            None
        );
        assert_eq!(
            picker_dialog_directory(Some(missing.to_string_lossy().as_ref())),
            None
        );
        assert_eq!(picker_dialog_directory(None), None);

        std::fs::remove_dir_all(root).expect("picker test root should be removed");
    }

    #[test]
    fn bundled_engine_resource_resolution_accepts_expected_layout() {
        let root = test_resource_root("valid");
        let engine_dir = root.join("engine");
        std::fs::create_dir_all(&engine_dir).expect("resource engine directory should be created");
        let script = engine_dir.join("engine.py");
        std::fs::write(&script, b"print('ok')\n")
            .expect("resource engine script should be created");

        let resolved =
            resolve_bundled_engine_script(&root).expect("bundled engine resource should resolve");
        assert_eq!(
            resolved,
            script
                .canonicalize()
                .expect("resource engine script should resolve canonically")
        );

        std::fs::remove_dir_all(root).expect("test resource tree should be removed");
    }

    #[test]
    fn bundled_engine_resource_resolution_rejects_missing_script() {
        let root = test_resource_root("missing-script");
        std::fs::create_dir_all(root.join("engine"))
            .expect("resource engine directory should be created");

        assert!(resolve_bundled_engine_script(&root).is_err());

        std::fs::remove_dir_all(root).expect("test resource tree should be removed");
    }

    #[test]
    fn bundled_engine_python_resolution_accepts_expected_layout() {
        let root = test_resource_root("python-valid");
        let runtime_dir = root.join(ENGINE_RUNTIME_DIRECTORY_NAME);
        std::fs::create_dir_all(&runtime_dir).expect("runtime directory should be created");
        let python = runtime_dir.join(ENGINE_PYTHON_EXECUTABLE_FILE_NAME);
        std::fs::write(&python, b"standalone python placeholder")
            .expect("runtime executable should be created");

        let resolved =
            resolve_bundled_engine_python(&root).expect("bundled Python runtime should resolve");
        assert_eq!(
            resolved,
            python
                .canonicalize()
                .expect("runtime executable should resolve canonically")
        );

        std::fs::remove_dir_all(root).expect("test runtime tree should be removed");
    }

    #[test]
    fn bundled_engine_python_resolution_rejects_missing_runtime() {
        let root = test_resource_root("python-missing");
        std::fs::create_dir_all(root.join(ENGINE_RUNTIME_DIRECTORY_NAME))
            .expect("runtime directory should be created");

        let error = resolve_bundled_engine_python(&root)
            .expect_err("missing bundled Python executable should fail");
        assert_eq!(error, BUNDLED_ENGINE_RUNTIME_ERROR);

        std::fs::remove_dir_all(root).expect("test runtime tree should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn bundled_engine_python_resolution_rejects_runtime_directory_escape() {
        use std::os::unix::fs::symlink;

        let root = test_resource_root("python-runtime-link");
        let outside = test_resource_root("python-runtime-outside");
        std::fs::create_dir_all(&outside).expect("outside runtime directory should be created");
        std::fs::write(
            outside.join(ENGINE_PYTHON_EXECUTABLE_FILE_NAME),
            b"outside python placeholder",
        )
        .expect("outside executable should be created");
        std::fs::create_dir_all(&root).expect("resource root should be created");
        symlink(&outside, root.join(ENGINE_RUNTIME_DIRECTORY_NAME))
            .expect("runtime directory symlink should be created");

        let error = resolve_bundled_engine_python(&root)
            .expect_err("runtime directory escape should be rejected");
        assert_eq!(error, BUNDLED_ENGINE_RUNTIME_ERROR);

        std::fs::remove_dir_all(root).expect("test resource tree should be removed");
        std::fs::remove_dir_all(outside).expect("outside test tree should be removed");
    }

    #[cfg(all(target_os = "windows", debug_assertions))]
    #[test]
    fn development_engine_uses_the_trusted_system_python_launcher() {
        let expected = super::trusted_system_binary("py.exe");
        let resolved = resolve_engine_python(std::path::Path::new(r"C:\\unused-resource-root"));
        match expected {
            Ok(expected) => assert_eq!(
                resolved.expect("development Python launcher should resolve"),
                expected
            ),
            Err(_) => assert!(
                resolved.is_err(),
                "development runtime must fail safely when py.exe is unavailable"
            ),
        }
    }

    #[cfg(all(target_os = "windows", debug_assertions))]
    #[test]
    fn debug_engine_process_adds_launcher_selector_only_for_py_exe() {
        let runtime_for = |python_executable: &str| super::EngineRuntime {
            script_path: PathBuf::from(r"C:\\app\\engine.py"),
            python_executable: PathBuf::from(python_executable),
            private_temp_root: PathBuf::from(r"C:\\app\\engine-temp"),
            supervisor: super::ProcessSupervisor::new(1, 1),
        };

        let launcher = super::engine_process_spec(
            &runtime_for(r"C:\\Windows\\py.exe"),
            Vec::new(),
            false,
        )
        .expect("launcher process specification should be built");
        assert_eq!(
            launcher.args.first().and_then(|argument| argument.to_str()),
            Some("-3.12")
        );

        let bundled = super::engine_process_spec(
            &runtime_for(r"C:\\app\\runtime\\python.exe"),
            Vec::new(),
            false,
        )
        .expect("bundled process specification should be built");
        assert_eq!(
            bundled.args.first().and_then(|argument| argument.to_str()),
            Some("-B")
        );
    }

    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    #[test]
    fn release_engine_uses_only_the_bundled_python_runtime() {
        let root = test_resource_root("python-release");
        let runtime_dir = root.join(ENGINE_RUNTIME_DIRECTORY_NAME);
        std::fs::create_dir_all(&runtime_dir).expect("runtime directory should be created");
        let python = runtime_dir.join(ENGINE_PYTHON_EXECUTABLE_FILE_NAME);
        std::fs::write(&python, b"standalone python placeholder")
            .expect("runtime executable should be created");

        assert_eq!(
            resolve_engine_python(&root).expect("release runtime should resolve"),
            python
                .canonicalize()
                .expect("runtime executable should resolve canonically")
        );

        std::fs::remove_file(&python).expect("runtime executable should be removed");
        let error = resolve_engine_python(&root)
            .expect_err("release must fail when bundled runtime is missing");
        assert_eq!(error, BUNDLED_ENGINE_RUNTIME_ERROR);

        std::fs::remove_dir_all(root).expect("test runtime tree should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn bundled_engine_resource_resolution_rejects_engine_directory_escape() {
        use std::os::unix::fs::symlink;

        let root = test_resource_root("engine-link");
        let outside = test_resource_root("outside");
        std::fs::create_dir_all(&outside).expect("outside engine directory should be created");
        std::fs::write(outside.join("engine.py"), b"print('outside')\n")
            .expect("outside engine script should be created");
        std::fs::create_dir_all(&root).expect("resource root should be created");
        symlink(&outside, root.join("engine")).expect("engine directory symlink should be created");

        assert!(resolve_bundled_engine_script(&root).is_err());
        assert!(outside.join("engine.py").is_file());

        std::fs::remove_dir_all(root).expect("test resource tree should be removed");
        std::fs::remove_dir_all(outside).expect("outside test tree should be removed");
    }

    #[test]
    fn engine_private_temp_directory_is_created_as_a_direct_cache_child() {
        let cache = test_resource_root("private-temp");
        let resolved = ensure_engine_private_temp_directory(&cache)
            .expect("private engine cache should be created");
        let expected = cache
            .join("engine-temp")
            .canonicalize()
            .expect("private cache should resolve canonically");
        assert_eq!(resolved, expected);
        assert!(resolved.is_dir());

        std::fs::remove_dir_all(cache).expect("test cache tree should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn engine_private_temp_directory_rejects_a_linked_child() {
        use std::os::unix::fs::symlink;

        let cache = test_resource_root("private-temp-link");
        let outside = test_resource_root("private-temp-outside");
        std::fs::create_dir_all(&cache).expect("cache directory should be created");
        std::fs::create_dir_all(&outside).expect("outside directory should be created");
        symlink(&outside, cache.join(ENGINE_PRIVATE_TEMP_DIRECTORY_NAME))
            .expect("private cache symlink should be created");

        assert!(ensure_engine_private_temp_directory(&cache).is_err());
        assert!(outside.is_dir());

        std::fs::remove_dir_all(cache).expect("test cache tree should be removed");
        std::fs::remove_dir_all(outside).expect("outside test tree should be removed");
    }

    #[test]
    fn max_file_limit_accepts_only_strict_positive_decimal_values() {
        assert_eq!(parse_max_pdf_files(None), DEFAULT_MAX_PDF_FILES);
        assert_eq!(parse_max_pdf_files(Some("1")), 1);
        assert_eq!(parse_max_pdf_files(Some("005")), 5);
        for invalid in ["", "0", "-1", "+1", " 1", "1 ", "1.0", "abc"] {
            assert_eq!(
                parse_max_pdf_files(Some(invalid)),
                DEFAULT_MAX_PDF_FILES,
                "unexpectedly accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn engine_child_process_uses_the_windows_no_console_flag() {
        assert_eq!(WINDOWS_CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn export_preview_token_accepts_only_safe_filename_characters() {
        assert!(valid_export_token("preview-token-1234567890"));
        assert!(valid_export_token("preview.token-1234567890"));
        assert!(!valid_export_token("../outside-preview-token"));
        assert!(!valid_export_token(r"..\outside-preview-token"));
        assert!(!valid_export_token("-preview-token-1234567890"));
        assert!(!valid_export_token(".preview-token-1234567890"));
        assert!(!valid_export_token("short"));
    }

    #[test]
    fn export_preview_path_stays_below_managed_directory() {
        let root = PathBuf::from(r"C:\cache\pdf-search\export-previews");
        let result = managed_preview_path(&root, "preview-token-1234567890")
            .expect("safe token should produce a preview path");
        assert_eq!(result, root.join("preview-token-1234567890.pdf"));
        assert!(managed_preview_path(
            &PathBuf::from(r"C:\cache\pdf-search\..\outside\export-previews"),
            "preview-token-1234567890",
        )
        .is_err());
    }

    #[test]
    fn final_path_containment_accepts_only_an_immediate_managed_child() {
        let root = r"\\?\C:\cache\pdf-search\export-previews";
        assert!(windows_final_path_is_direct_child(
            root,
            r"\\?\C:\CACHE\PDF-SEARCH\EXPORT-PREVIEWS\preview-token-1234567890.pdf",
            "preview-token-1234567890.pdf",
        ));
        assert!(!windows_final_path_is_direct_child(
            root,
            r"\\?\C:\cache\pdf-search\outside\preview-token-1234567890.pdf",
            "preview-token-1234567890.pdf",
        ));
        assert!(!windows_final_path_is_direct_child(
            root,
            r"\\?\C:\cache\pdf-search\export-previews\..\outside.pdf",
            "outside.pdf",
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn trusted_system_binary_requires_a_direct_system_root_child() {
        let root = PathBuf::from(r"C:\Windows");
        assert!(system_binary_is_direct_child(
            &root,
            &root.join("py.exe"),
            "py.exe",
        ));
        assert!(!system_binary_is_direct_child(
            &root,
            &root.join("System32").join("py.exe"),
            "py.exe",
        ));
    }

    #[test]
    fn preview_lifecycle_unregisters_a_cleaned_token() {
        let root = PathBuf::from(r"C:\cache\pdf-search\export-previews");
        let lifecycle = PreviewLifecycle::new(root.clone(), root);
        let token = "preview-token-1234567890";
        assert!(lifecycle.register_token(token));
        assert_eq!(lifecycle.tokens.lock().expect("token lock").len(), 1);
        lifecycle.unregister_token(token);
        assert!(lifecycle.tokens.lock().expect("token lock").is_empty());
    }

    #[test]
    fn preview_cleanup_has_a_hard_entry_bound() {
        let root = test_preview_root("bounded-count");
        ensure_managed_preview_directory(&root).expect("dedicated preview root should be created");
        for index in 0..=MAX_PREVIEW_CLEANUP_ENTRIES {
            let name = format!("preview-{index:04}-token.pdf");
            std::fs::write(root.join(name), b"preview").expect("preview should be created");
        }

        let report = cleanup_preview_directory(&root);
        assert!(report.cleaned_count <= MAX_PREVIEW_CLEANUP_ENTRIES);
        assert!(report.failed_count >= 1);

        std::fs::remove_dir_all(root.parent().expect("test root should have a parent"))
            .expect("test preview tree should be removed");
    }

    #[test]
    fn startup_cleanup_removes_only_direct_safe_preview_files() {
        let root = test_preview_root("bounded");
        ensure_managed_preview_directory(&root).expect("dedicated preview root should be created");
        let safe_file = root.join("preview-token-1234567890.pdf");
        let unrelated_file = root.join("keep-me.txt");
        let nested = root.join("nested");
        let outside = root
            .parent()
            .expect("test root should have a parent")
            .join("outside.pdf");
        std::fs::write(&safe_file, b"preview").expect("safe preview should be created");
        std::fs::write(&unrelated_file, b"keep").expect("unrelated file should be created");
        std::fs::create_dir(&nested).expect("nested directory should be created");
        std::fs::write(nested.join("preview-token-1234567890.pdf"), b"keep")
            .expect("nested preview should be created");
        std::fs::write(&outside, b"keep").expect("outside file should be created");

        let report = cleanup_preview_directory(&root);
        assert_eq!(report.cleaned_count, 1);
        assert_eq!(report.failed_count, 0);
        assert!(!safe_file.exists());
        assert!(unrelated_file.exists());
        assert!(nested.exists());
        assert!(outside.exists());

        std::fs::remove_dir_all(root.parent().expect("test root should have a parent"))
            .expect("test preview tree should be removed");
    }

    #[test]
    fn cleanup_refuses_a_non_dedicated_directory() {
        let root = std::env::temp_dir().join(format!(
            "pdf-search-preview-not-dedicated-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("test directory should be created");
        let file = root.join("preview-token-1234567890.pdf");
        std::fs::write(&file, b"keep").expect("test file should be created");

        let report = cleanup_preview_directory(&root);
        assert_eq!(report.cleaned_count, 0);
        assert_eq!(report.failed_count, 1);
        assert!(file.exists());

        std::fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn closed_managed_preview_tokens_cannot_produce_again() {
        let root = test_preview_root("closed-token");
        std::fs::create_dir_all(&root).unwrap();
        let resolved = std::fs::canonicalize(&root).unwrap();
        let lifecycle = PreviewLifecycle::new(root.clone(), resolved);
        let token = "preview-token-1234567890";
        let path = root.join(format!("{token}.pdf"));
        assert!(lifecycle.assert_open_path(&path, token).is_err());
        assert!(lifecycle.register_token(token));
        assert!(lifecycle.assert_open_path(&path, token).is_ok());
        assert!(!lifecycle.register_token(token));
        assert!(lifecycle
            .assert_open_path(&root.join("another-preview.pdf"), token)
            .is_err());
        lifecycle.unregister_token(token);
        assert!(lifecycle.assert_open_path(&path, token).is_err());
        // A final user export is outside the managed temporary directory.
        assert!(lifecycle
            .assert_open_path(&root.parent().unwrap().join("final.pdf"), token)
            .is_ok());
        std::fs::remove_dir(&root).unwrap();
        assert!(lifecycle.assert_open_path(&path, token).is_err());
    }

    #[test]
    fn selected_files_fail_closed_when_the_limit_is_exceeded() {
        let paths = vec![PathBuf::from("one.pdf"), PathBuf::from("two.pdf")];
        assert_eq!(apply_pdf_file_limit(paths.clone(), 2).len(), 2);
        assert!(apply_pdf_file_limit(paths, 1).is_empty());
    }

    #[test]
    fn recursive_collection_reports_overflow_without_returning_a_partial_batch() {
        let root = std::env::temp_dir().join(format!(
            "pdf-search-limit-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before UNIX epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("nested")).expect("test directory should be created");
        std::fs::write(root.join("first.pdf"), b"test").expect("test PDF should be created");
        std::fs::write(root.join("nested").join("second.pdf"), b"test")
            .expect("nested test PDF should be created");
        std::fs::write(root.join("nested").join("third.pdf"), b"test")
            .expect("nested test PDF should be created");

        let mut files = Vec::new();
        let overflowed = !collect_pdf_files(&root, &mut files, 2);
        assert!(overflowed);
        assert_eq!(files.len(), 2);
        let safe_result = if overflowed {
            Vec::new()
        } else {
            apply_pdf_file_limit(files.into_iter().map(PathBuf::from).collect(), 2)
        };
        assert!(safe_result.is_empty());

        std::fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn recursive_collection_stops_at_depth_and_entry_limits() {
        let root = std::env::temp_dir().join(format!(
            "pdf-search-scan-boundary-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before UNIX epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("nested")).expect("test directory should be created");
        std::fs::write(root.join("first.pdf"), b"test").expect("test PDF should be created");
        std::fs::write(root.join("nested").join("second.pdf"), b"test")
            .expect("nested test PDF should be created");

        let mut files = Vec::new();
        assert!(!collect_pdf_files_with_limits(
            &root, &mut files, 10, 0, 100
        ));
        files.clear();
        assert!(!collect_pdf_files_with_limits(&root, &mut files, 10, 64, 1));

        std::fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn recursive_collection_does_not_follow_symlinked_directories_or_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "pdf-search-scan-link-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before UNIX epoch")
                .as_nanos()
        ));
        let outside = test_resource_root("scan-link-outside");
        std::fs::create_dir_all(&root).expect("test directory should be created");
        std::fs::create_dir_all(&outside).expect("outside directory should be created");
        std::fs::write(root.join("safe.pdf"), b"safe").expect("safe PDF should be created");
        std::fs::write(outside.join("outside.pdf"), b"outside")
            .expect("outside PDF should be created");
        symlink(&outside, root.join("nested-link")).expect("directory symlink should be created");
        symlink(outside.join("outside.pdf"), root.join("linked.pdf"))
            .expect("file symlink should be created");

        let mut files = Vec::new();
        assert!(collect_pdf_files(&root, &mut files, 10));
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("safe.pdf"));

        std::fs::remove_dir_all(&root).expect("test directory should be removed");
        std::fs::remove_dir_all(outside).expect("outside directory should be removed");
    }

    #[test]
    fn engine_response_reader_enforces_a_byte_limit() {
        let response =
            read_bounded_engine_response(Cursor::new(b"{\"status\":\"ok\"}\ntrailing"), 64)
                .expect("bounded response should be read");
        assert_eq!(response, "{\"status\":\"ok\"}");
        assert!(read_bounded_engine_response(Cursor::new(b"123456789"), 8).is_err());
    }

    #[test]
    fn engine_timeout_helper_expires_only_after_the_deadline() {
        let start = Instant::now();
        assert!(!operation_timed_out(
            start,
            start + Duration::from_millis(99),
            Duration::from_millis(100),
        ));
        assert!(operation_timed_out(
            start,
            start + Duration::from_millis(100),
            Duration::from_millis(100),
        ));
    }

    #[test]
    fn source_sha256_validation_requires_exact_hex_digest() {
        assert!(valid_source_sha256(&"a".repeat(64)));
        assert!(valid_source_sha256(&"B".repeat(64)));
        assert!(!valid_source_sha256("short"));
        assert!(!valid_source_sha256(&format!("{}z", "a".repeat(63))));
    }

    #[test]
    fn inspect_pdf_command_exposes_the_canonical_pdf_boundary() {
        let _command = engine_inspect_pdf;
        let root = test_resource_root("inspect-pdf-boundary");
        std::fs::create_dir_all(&root).expect("inspect test directory should be created");
        let pdf = root.join("document.pdf");
        std::fs::write(&pdf, b"not a real PDF").expect("inspect test PDF should be created");
        let text = root.join("document.txt");
        std::fs::write(&text, b"not a PDF").expect("inspect test text file should be created");
        let directory = root.join("directory.pdf");
        std::fs::create_dir(&directory).expect("inspect test directory should be created");

        assert_eq!(
            canonical_pdf_path(pdf.to_string_lossy().into_owned())
                .expect("PDF path should resolve"),
            pdf.canonicalize().unwrap()
        );
        assert!(canonical_pdf_path(text.to_string_lossy().into_owned()).is_err());
        assert!(canonical_pdf_path(directory.to_string_lossy().into_owned()).is_err());
        assert!(
            canonical_pdf_path(root.join("missing.pdf").to_string_lossy().into_owned()).is_err()
        );

        std::fs::remove_dir_all(root).expect("inspect test directory should be removed");
    }

    #[test]
    fn engine_ipc_payload_limits_bound_text_and_array_counts() {
        assert!(ensure_text_limit("keyword", MAX_ENGINE_PATH_BYTES, "too long").is_ok());
        assert!(ensure_text_limit(
            &"x".repeat(MAX_ENGINE_PATH_BYTES + 1),
            MAX_ENGINE_PATH_BYTES,
            "too long"
        )
        .is_err());

        let within_matches = Value::Array(vec![Value::Null; MAX_ENGINE_MATCHES]);
        assert!(ensure_array_limit(&within_matches, MAX_ENGINE_MATCHES, "matches").is_ok());
        let over_matches = Value::Array(vec![Value::Null; MAX_ENGINE_MATCHES + 1]);
        assert!(ensure_array_limit(&over_matches, MAX_ENGINE_MATCHES, "matches").is_err());

        let within_selections = Value::Array(vec![Value::Null; MAX_ENGINE_SELECTIONS]);
        assert!(
            ensure_array_limit(&within_selections, MAX_ENGINE_SELECTIONS, "selections").is_ok()
        );
        let over_selections = Value::Array(vec![Value::Null; MAX_ENGINE_SELECTIONS + 1]);
        assert!(ensure_array_limit(&over_selections, MAX_ENGINE_SELECTIONS, "selections").is_err());
    }

    #[test]
    fn multi_search_rejects_duplicate_ids_and_exclude_only_queries() {
        let duplicate = serde_json::json!([
            {"id":"include-0", "keyword":"A", "role":"include"},
            {"id":"include-0", "keyword":"B", "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&duplicate).is_err());

        let exclude_only = serde_json::json!([
            {"id":"exclude-0", "keyword":"refund", "role":"exclude"}
        ]);
        assert!(super::validate_search_clauses(&exclude_only).is_err());
    }

    #[test]
    fn multi_search_accepts_bounded_include_and_exclude() {
        let queries = serde_json::json!([
            {"id":"include-0", "keyword":" A ", "role":"include"},
            {"id":"exclude-0", "keyword":" B ", "role":"exclude"}
        ]);
        assert!(super::validate_search_clauses(&queries).is_ok());
    }

    #[test]
    fn multi_search_rejects_invalid_roles_and_clause_counts() {
        let invalid_role = serde_json::json!([
            {"id":"include-0", "keyword":"A", "role":"other"}
        ]);
        assert!(super::validate_search_clauses(&invalid_role).is_err());

        let empty = Value::Array(Vec::new());
        assert!(super::validate_search_clauses(&empty).is_err());

        let too_many = Value::Array(
            (0..33)
                .map(|index| {
                    serde_json::json!({
                        "id": format!("include-{index}"),
                        "keyword": "A",
                        "role": "include"
                    })
                })
                .collect(),
        );
        assert!(super::validate_search_clauses(&too_many).is_err());
    }

    #[test]
    fn multi_search_enforces_ascii_bounded_unique_ids() {
        let valid = serde_json::json!([
            {"id":"A-1", "keyword":"A", "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&valid).is_ok());

        let too_long = serde_json::json!([
            {"id": "a".repeat(65), "keyword":"A", "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&too_long).is_err());

        for id in ["", "with_space", "含中文", "include/0"] {
            let invalid = serde_json::json!([
                {"id": id, "keyword":"A", "role":"include"}
            ]);
            assert!(
                super::validate_search_clauses(&invalid).is_err(),
                "id should be rejected: {id:?}"
            );
        }
    }

    #[test]
    fn multi_search_enforces_trimmed_keyword_character_and_utf8_limits() {
        let trimmed = serde_json::json!([
            {"id":"include-0", "keyword":"  示例实业  ", "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&trimmed).is_ok());

        let max_unicode = serde_json::json!([
            {"id":"include-0", "keyword": "界".repeat(512), "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&max_unicode).is_ok());

        let too_many_unicode = serde_json::json!([
            {"id":"include-0", "keyword": "界".repeat(513), "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&too_many_unicode).is_err());

        let whitespace_only = serde_json::json!([
            {"id":"include-0", "keyword":" \t\n ", "role":"include"}
        ]);
        assert!(super::validate_search_clauses(&whitespace_only).is_err());
    }

    #[test]
    fn multi_search_rejects_queries_over_total_json_size_limit() {
        let oversized = serde_json::json!([
            {
                "id":"include-0",
                "keyword":"A",
                "role":"include",
                "metadata":"x".repeat(128 * 1024)
            }
        ]);
        assert!(super::validate_search_clauses(&oversized).is_err());
    }
}
