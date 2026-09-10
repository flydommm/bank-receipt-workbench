//! Native-only allocation and lifecycle for frozen multi-file export intents.

use crate::{
    call_engine_with_timeout, engine_runtime, ensure_managed_preview_directory,
    managed_preview_path, metadata_is_reparse_point, BatchServiceState, EngineRuntime,
    PreviewLifecycle,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_FILES: usize = 501;
const MAX_ITEMS: usize = 50_000;
const MAX_OUTPUT_NAME_UTF16: usize = 120;

fn exact_fields(value: &Value, fields: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("导出请求无效")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("导出请求字段无效".into());
    }
    Ok(())
}

fn text(value: &Value, max: usize) -> Result<&str, String> {
    value
        .as_str()
        .filter(|value| !value.trim().is_empty() && value.len() <= max && !value.contains('\0'))
        .ok_or_else(|| "导出标识或路径无效".into())
}

fn uuid(value: &Value) -> Result<&str, String> {
    let value = text(value, 36)?;
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err("导出令牌无效".into());
    }
    Ok(value)
}

fn output_name(value: &Value) -> Result<(), String> {
    let raw = value
        .as_str()
        .filter(|value| !value.trim().is_empty() && !value.contains('\0') && value.len() <= 512)
        .ok_or("导出文件名无效")?;
    if raw.ends_with('.') || raw.ends_with(' ') {
        return Err("导出文件名无效".into());
    }
    let trimmed = raw.trim();
    let mut name = trimmed;
    // The suffix is ASCII, but the preceding character may be a multi-byte
    // UTF-8 code point. Check the boundary before slicing so Chinese and
    // emoji names cannot panic at the Rust/Python boundary. Repeating the
    // loop also keeps normalization idempotent for `name.pdf.pdf`.
    while name.len() >= 4 {
        let suffix_start = name.len() - 4;
        if !name.is_char_boundary(suffix_start)
            || !name[suffix_start..].eq_ignore_ascii_case(".pdf")
        {
            break;
        }
        name = &name[..suffix_start];
    }
    if name.is_empty() || name.encode_utf16().count() > MAX_OUTPUT_NAME_UTF16
        || name == "." || name == ".."
        || name.starts_with('/') || name.starts_with('\\')
        || name.as_bytes().get(1) == Some(&b':')
        || name.ends_with('.') || name.ends_with(' ')
        || name.chars().any(|character| {
            character.is_control() || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
    {
        return Err("导出文件名无效".into());
    }
    let device = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if matches!(device.as_str(), "con" | "prn" | "aux" | "nul")
        || (device.starts_with("com") && {
            let suffix = &device[3..];
            suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
        })
        || (device.starts_with("lpt") && {
            let suffix = &device[3..];
            suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
        })
    {
        return Err("导出文件名无效".into());
    }
    Ok(())
}

pub fn validate_request(request: &Value) -> Result<&str, String> {
    if serde_json::to_vec(request)
        .map_err(|_| "导出请求无效")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("导出请求过大".into());
    }
    let op = text(&request["op"], 32)?;
    match op {
        "create" => {
            exact_fields(request, &["op", "scope"])?;
            let scope = &request["scope"];
            let base_fields = [
                "job_id",
                "result_revision",
                "scope_kind",
                "selected_segment_ids",
                "expected_records",
                "output_mode",
                "include_xlsx",
            ];
            let scope_object = scope.as_object().ok_or("导出请求无效")?;
            if (scope_object.len() != base_fields.len()
                && scope_object.len() != base_fields.len() + 1)
                || base_fields.iter().any(|field| !scope_object.contains_key(*field))
                || scope_object.keys().any(|field| field != "output_name" && !base_fields.contains(&field.as_str()))
            {
                return Err("导出请求字段无效".into());
            }
            if scope_object.contains_key("output_name") {
                output_name(&scope["output_name"])?;
            }
            text(&scope["job_id"], 1024)?;
            text(&scope["result_revision"], 1024)?;
            if !matches!(
                scope["scope_kind"].as_str(),
                Some("all" | "sources" | "list")
            ) || !matches!(
                scope["output_mode"].as_str(),
                Some("merged" | "by_source" | "both")
            ) || !scope["include_xlsx"].is_boolean()
            {
                return Err("导出范围或输出方式无效".into());
            }
            let ids = scope["selected_segment_ids"]
                .as_array()
                .ok_or("导出片段集合无效")?;
            if ids.is_empty() || ids.len() > MAX_ITEMS {
                return Err("导出片段数量无效".into());
            }
            let mut selected = BTreeSet::new();
            for id in ids {
                if !selected.insert(text(id, 1024)?) {
                    return Err("导出片段重复".into());
                }
            }
            let expected = scope["expected_records"]
                .as_array()
                .ok_or("审核修订集合无效")?;
            if expected.len() != ids.len() {
                return Err("审核修订集合不完整".into());
            }
            let mut revisions = BTreeSet::new();
            for row in expected {
                exact_fields(row, &["id", "record_revision"])?;
                if !revisions.insert(text(&row["id"], 1024)?)
                    || row["record_revision"]
                        .as_u64()
                        .is_none_or(|revision| revision == 0 || revision >= (1 << 53))
                {
                    return Err("审核修订无效".into());
                }
            }
            if selected != revisions {
                return Err("审核修订与导出片段不一致".into());
            }
        }
        "publish" => {
            exact_fields(request, &["op", "intent_id", "directory"])?;
            uuid(&request["intent_id"])?;
            if !Path::new(text(&request["directory"], 32768)?).is_absolute() {
                return Err("输出目录必须是绝对路径".into());
            }
        }
        "close" => {
            exact_fields(request, &["op", "intent_id"])?;
            uuid(&request["intent_id"])?;
        }
        "status" => {
            exact_fields(request, &["op", "job_id"])?;
            text(&request["job_id"], 1024)?;
        }
        _ => return Err("不支持的导出操作".into()),
    }
    Ok(op)
}

fn descriptors(response: &Value, root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let files = response["files"].as_array().ok_or("导出预览清单无效")?;
    if files.is_empty() || files.len() > MAX_FILES {
        return Err("导出文件数量无效".into());
    }
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(files.len());
    for file in files {
        let token = uuid(&file["preview_token"])?;
        let path = managed_preview_path(root, token)?;
        if Path::new(text(&file["preview_path"], 32768)?) != path || !seen.insert(token.to_string())
        {
            return Err("导出预览路径或令牌无效".into());
        }
        result.push((token.to_string(), path));
    }
    Ok(result)
}

fn validate_rendered(created: &Value, rendered: &Value, root: &Path) -> Result<(), String> {
    if rendered["status"] != "ok" {
        return Ok(());
    }
    let result = &rendered["data"];
    if result["state"] != "rendered"
        || [
            "intent_id",
            "job_id",
            "result_revision",
            "selected_segment_ids",
            "output_mode",
            "include_xlsx",
            "output_name",
            "source_fingerprint",
            "review_revision",
            "scope_kind",
            "summary",
            "merged_pages",
            "source_pages",
            "total_pages",
        ]
        .iter()
        .any(|key| created[*key] != result[*key])
        || descriptors(created, root)? != descriptors(result, root)?
    {
        return Err("生成的预览与已登记导出范围不一致".into());
    }
    for (original, file) in created["files"]
        .as_array()
        .ok_or("导出文件清单无效")?
        .iter()
        .zip(result["files"].as_array().ok_or("导出文件清单无效")?)
    {
        let hash = text(&file["sha256"], 64)?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || file["page_count"]
                .as_u64()
                .is_none_or(|count| count == 0 || count > MAX_ITEMS as u64)
            || file["size_bytes"]
                .as_u64()
                .is_none_or(|size| size == 0 || size >= (1 << 53))
            || ["file_id", "name", "source_key", "page_count"]
                .iter()
                .any(|key| original[*key] != file[*key])
        {
            return Err("导出预览文件校验信息无效".into());
        }
    }
    Ok(())
}

struct HostPaths {
    data: PathBuf,
    journal: PathBuf,
    previews: PathBuf,
}

fn abandon_failed_previews(lifecycle: &PreviewLifecycle, files: &[(String, PathBuf)]) {
    // No frontend preview was returned. Retain durable owners and task tokens
    // for cleanup, but allow the next reconciliation to retry these files.
    for (token, _) in files {
        lifecycle.unregister_token(token);
    }
}

impl HostPaths {
    fn request(&self, mut request: Value) -> Value {
        request["batch_database_path"] = json!(self.data.join("batch-tasks.sqlite3"));
        request["review_database_path"] = json!(self.data.join("pdf-search.sqlite3"));
        request["journal_root"] = json!(self.journal);
        request["preview_root"] = json!(self.previews);
        request
    }
    fn call(&self, runtime: &EngineRuntime, request: Value) -> Result<Value, String> {
        // The bounded full-source check plus multi-file production can take
        // longer than a single PDF call. Shutdown still kills the owned tree.
        let seconds = if matches!(
            request["op"].as_str(),
            Some("export_intent_create" | "export_intent_render" | "export_intent_publish")
        ) {
            900
        } else {
            120
        };
        call_engine_with_timeout(
            runtime,
            self.request(request),
            std::time::Duration::from_secs(seconds),
        )
    }
}

pub fn execute(app: &tauri::AppHandle, request: Value) -> Result<Value, String> {
    let op = validate_request(&request)?;
    let lifecycle = app
        .try_state::<PreviewLifecycle>()
        .ok_or("预览生命周期不可用")?;
    let _operation = lifecycle
        .operation
        .lock()
        .map_err(|_| "预览生命周期不可用")?;
    ensure_managed_preview_directory(&lifecycle.root)?;
    if std::fs::canonicalize(&lifecycle.root).ok().as_deref() != Some(&lifecycle.resolved_root) {
        return Err("PDF 预览目录已变化".into());
    }
    let data = app
        .path()
        .app_data_dir()
        .map_err(|_| "导出数据目录不可用")?;
    let journal = data.join("export-intents");
    match std::fs::create_dir(&journal) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("无法创建导出记录目录".into()),
    }
    let metadata = std::fs::symlink_metadata(&journal).map_err(|_| "导出记录目录不可用")?;
    if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
        return Err("导出记录目录无效".into());
    }
    let paths = HostPaths {
        data,
        journal,
        previews: lifecycle.root.clone(),
    };
    let runtime = engine_runtime(app)?;
    let service = app
        .try_state::<BatchServiceState>()
        .ok_or("任务服务不可用")?
        .0
        .clone()?;
    let recovered_residuals = if matches!(op, "create" | "status") {
        let active_tokens: Vec<String> = lifecycle
            .tokens
            .lock()
            .map_err(|_| "预览生命周期不可用")?
            .iter()
            .cloned()
            .collect();
        let response = paths.call(
            &runtime,
            json!({"op":"export_intent_reconcile", "active_tokens":active_tokens}),
        )?;
        if response["status"] != "ok" {
            return Ok(response);
        }
        response["data"]["residuals"]
            .as_array()
            .ok_or("导出恢复结果无效")?
            .clone()
    } else {
        Vec::new()
    };
    match op {
        "create" => {
            let created = paths.call(&runtime, json!({"op":"export_intent_create", "scope":request["scope"]}))?;
            if created["status"] != "ok" { return Ok(created); }
            let data = &created["data"];
            let intent = uuid(&data["intent_id"])?;
            let job = text(&data["job_id"], 1024)?;
            if data["job_id"] != request["scope"]["job_id"] || data["state"] != "created" {
                return Err("导出任务身份不一致".into());
            }
            let files = descriptors(data, &lifecycle.root)?;
            let rendered = (|| -> Result<Value, String> {
                for (token, path) in &files {
                    if std::fs::symlink_metadata(path).is_ok() { return Err("预览文件已存在".into()); }
                    service.register_preview(job, token, &lifecycle.root)?;
                    lifecycle.task_tokens.lock().map_err(|_| "预览生命周期不可用")?.insert(token.clone(), job.to_string());
                    if !lifecycle.register_token(token) { return Err("导出预览令牌已被占用".into()); }
                }
                let result = paths.call(&runtime, json!({"op":"export_intent_render", "intent_id":intent}))?;
                validate_rendered(data, &result, &lifecycle.root)?;
                Ok(result)
            })();
            if rendered.as_ref().is_ok_and(|result| result["status"] == "ok") { return rendered; }
            // Created or partially rendered intents have no delivered files.
            // Close before releasing native ownership; retained failures stay
            // registered so task cleanup cannot claim there is no preview.
            let cleaned = paths.call(&runtime, json!({"op":"export_intent_close", "intent_id":intent}));
            if cleaned.as_ref().is_ok_and(|result| result["status"] == "ok") {
                for (token, _) in &files {
                    if service.release_preview(token).is_ok() {
                        lifecycle.unregister_token(token);
                        lifecycle.task_tokens.lock().map_err(|_| "预览生命周期不可用")?.remove(token);
                    }
                }
            }
            abandon_failed_previews(&lifecycle, &files);
            rendered
        }
        "close" => {
            let intent = uuid(&request["intent_id"])?;
            let described = paths.call(&runtime, json!({"op":"export_intent_describe", "intent_id":intent}))?;
            if described["status"] != "ok" { return Ok(described); }
            let files = descriptors(&described["data"], &lifecycle.root)?;
            let result = paths.call(&runtime, json!({"op":"export_intent_close", "intent_id":intent}))?;
            if result["status"] == "ok" {
                for (token, _) in files {
                    service.release_preview(&token)?;
                    lifecycle.unregister_token(&token);
                    lifecycle.task_tokens.lock().map_err(|_| "预览生命周期不可用")?.remove(&token);
                }
            }
            Ok(result)
        }
        "publish" => paths.call(&runtime, json!({"op":"export_intent_publish", "intent_id":request["intent_id"], "directory":request["directory"]})),
        "status" => {
            let mut response = paths.call(&runtime, json!({"op":"export_intent_status", "job_id":request["job_id"]}))?;
            if response["status"] == "ok" {
                response["data"]["residuals"].as_array_mut().ok_or("导出恢复结果无效")?.extend(recovered_residuals);
            }
            Ok(response)
        },
        _ => Err("不支持的导出操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn create() -> Value {
        json!({"op":"create", "scope":{"job_id":"job", "result_revision":"result", "scope_kind":"all", "selected_segment_ids":["one"], "expected_records":[{"id":"one", "record_revision":1}], "output_mode":"both", "include_xlsx":false}})
    }
    #[test]
    fn failed_creation_releases_activity_but_retains_cleanup_ownership() {
        let root = std::env::temp_dir().join("export-previews");
        let lifecycle = PreviewLifecycle::new(root.clone(), root.clone());
        lifecycle.register_token("failed");
        lifecycle.register_token("visible");
        lifecycle
            .task_tokens
            .lock()
            .unwrap()
            .insert("failed".into(), "job".into());
        abandon_failed_previews(&lifecycle, &[("failed".into(), root.join("failed.pdf"))]);
        assert_eq!(
            *lifecycle.tokens.lock().unwrap(),
            BTreeSet::from(["visible".into()])
        );
        assert_eq!(
            lifecycle
                .task_tokens
                .lock()
                .unwrap()
                .get("failed")
                .map(String::as_str),
            Some("job")
        );
    }
    #[test]
    fn accepts_only_declared_webview_operations() {
        assert!(validate_request(&create()).is_ok());
        for op in [
            "export_intent_render",
            "register_preview",
            "render",
            "cleanup",
            "describe",
        ] {
            assert!(validate_request(
                &json!({"op":op, "intent_id":"12345678-1234-1234-1234-123456789012"})
            )
            .is_err());
        }
        for field in [
            "database_path",
            "preview_root",
            "journal_root",
            "selections",
            "directory",
        ] {
            let mut request = create();
            request[field] = json!("untrusted");
            assert!(validate_request(&request).is_err());
        }
    }

    #[test]
    fn output_name_validation_handles_utf8_names_and_repeated_extension() {
        for value in ["结果", "😀报告", "结果.PDF.pdf", "COM01", "COM+1", "LPT01"] {
            let mut request = create();
            request["scope"]["output_name"] = json!(value);
            assert!(validate_request(&request).is_ok(), "{value}");
        }
        for value in ["CON", "con.pdf", "COM1", "LPT9", "../结果", "结果/"] {
            let mut request = create();
            request["scope"]["output_name"] = json!(value);
            assert!(validate_request(&request).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_forged_duplicate_or_unpersisted_scope_revisions() {
        for change in 0..6 {
            let mut request = create();
            match change {
                0 => request["scope"]["selected_segment_ids"] = json!(["one", "one"]),
                1 => request["scope"]["expected_records"][0]["record_revision"] = json!(0),
                2 => request["scope"]["expected_records"][0]["record_revision"] = json!(1.5),
                3 => request["scope"]["expected_records"][0]["id"] = json!("other"),
                4 => request["scope"]["include_xlsx"] = json!("false"),
                _ => request["scope"]["selections"] = json!([]),
            }
            assert!(validate_request(&request).is_err());
        }
    }
    #[test]
    fn preview_allocation_cannot_escape_root_or_reuse_tokens() {
        let root = std::env::temp_dir().join("export-previews");
        let token = "12345678-1234-1234-1234-123456789012";
        let file = json!({"preview_token":token,"preview_path":root.join(format!("{token}.pdf"))});
        assert!(descriptors(&json!({"files":[file.clone()]}), &root).is_ok());
        assert!(descriptors(&json!({"files":[file.clone(),file.clone()]}), &root).is_err());
        let mut outside = file;
        outside["preview_path"] = json!(root.join("..").join("outside.pdf"));
        assert!(descriptors(&json!({"files":[outside]}), &root).is_err());
    }

    #[test]
    fn rendered_reply_must_preserve_the_allocated_plan() {
        let root = std::env::temp_dir().join("export-previews");
        let token = "12345678-1234-1234-1234-123456789012";
        let created = json!({"state":"created", "intent_id":token,"job_id":"job","result_revision":"result",
            "selected_segment_ids":["one"],"output_mode":"merged","include_xlsx":false,"source_fingerprint":"a".repeat(64),
            "review_revision":"b".repeat(64),"scope_kind":"all","summary":{"selected_count":1},"merged_pages":1,"source_pages":0,"total_pages":1,
            "files":[{"file_id":"merged","name":"全部匹配结果.pdf","source_key":null,"page_count":1,
                "preview_token":token,"preview_path":root.join(format!("{token}.pdf"))}]});
        let mut data = created.clone();
        data["state"] = json!("rendered");
        data["files"][0]["sha256"] = json!("c".repeat(64));
        data["files"][0]["size_bytes"] = json!(300);
        let response = json!({"status":"ok","data":data});
        assert!(validate_rendered(&created, &response, &root).is_ok());
        for field in ["job_id", "scope_kind", "summary", "total_pages"] {
            let mut changed = response.clone();
            changed["data"][field] = json!("changed");
            assert!(validate_rendered(&created, &changed, &root).is_err());
        }
        for field in ["name", "source_key", "page_count", "sha256", "size_bytes"] {
            let mut changed = response.clone();
            changed["data"]["files"][0][field] = json!("changed");
            assert!(validate_rendered(&created, &changed, &root).is_err());
        }
    }
}
