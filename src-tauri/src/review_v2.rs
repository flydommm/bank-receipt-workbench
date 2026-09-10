//! Bounded input validation for the v2 review bridge. Python validates domain
//! compatibility and performs transactions; this layer never accepts a DB path.
use serde_json::Value;
use std::collections::HashSet;

fn text(value: Option<&Value>, limit: usize) -> Result<&str, String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= limit && !s.contains('\0'))
        .ok_or_else(|| "invalid review identifier".to_string())
}

fn digest(value: Option<&Value>) -> Result<&str, String> {
    let value = text(value, 64)?;
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid review digest".to_string());
    }
    Ok(value)
}

pub fn revision(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 128 || value.contains('\0') {
        return Err("invalid review result revision".to_string());
    }
    Ok(())
}

fn bounded_array(value: &Value, limit: usize) -> Result<&[Value], String> {
    value
        .as_array()
        .filter(|items| items.len() <= limit)
        .map(Vec::as_slice)
        .ok_or_else(|| "review collection is invalid or exceeds its limit".to_string())
}

fn payload_limit(value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "invalid review payload")?;
    // Leave room for the operation name and private database path in the
    // existing 64 MiB engine request limit.
    if bytes.len() > super::ENGINE_IO_LIMIT_BYTES - 64 * 1024 {
        return Err("review payload exceeds the engine request limit".to_string());
    }
    Ok(())
}

pub fn prepare(context: &Value, originals: &Value, result_revision: &str) -> Result<(), String> {
    revision(result_revision)?;
    if context.get("version").and_then(Value::as_u64) != Some(2)
        || context.get("database_path").is_some()
    {
        return Err("invalid review context".to_string());
    }
    digest(context.get("criteria_fingerprint"))?;
    text(context.get("computation_version"), 256)?;
    let sources = bounded_array(
        context
            .get("sources")
            .ok_or("review sources are required")?,
        super::configured_max_pdf_files().min(10_000),
    )?;
    if sources.is_empty() {
        return Err("review sources are required".to_string());
    }
    let mut source_keys = HashSet::new();
    for source in sources {
        let key = text(source.get("source_key"), super::MAX_ENGINE_PATH_BYTES)?;
        if !source_keys.insert(key) {
            return Err("duplicate review source".to_string());
        }
        text(source.get("source_path"), super::MAX_ENGINE_PATH_BYTES)?;
        digest(source.get("source_sha256"))?;
    }
    let originals = bounded_array(originals, super::MAX_ENGINE_SEGMENTS)?;
    let mut ids = HashSet::new();
    for item in originals {
        let id = text(item.get("id"), super::MAX_ENGINE_TASK_ID_BYTES)?;
        if !ids.insert(id) {
            return Err("duplicate review segment id".to_string());
        }
        let source = text(item.get("source_key"), super::MAX_ENGINE_PATH_BYTES)?;
        if !source_keys.contains(source) {
            return Err("review segment has an unknown source".to_string());
        }
        digest(item.get("analysis_signature"))?;
        text(item.get("layout_fingerprint"), 1024)?;
        if item.get("persistable").and_then(Value::as_bool).is_none() {
            return Err("review segment eligibility is required".to_string());
        }
    }
    payload_limit(&serde_json::json!({"context": context, "originals": originals}))
}

pub fn read(context_key: &str, result_revision: &str) -> Result<(), String> {
    digest(Some(&Value::String(context_key.to_owned())))?;
    revision(result_revision)
}

pub fn save(context_key: &str, result_revision: &str, segments: &Value) -> Result<(), String> {
    read(context_key, result_revision)?;
    let items = bounded_array(segments, super::MAX_ENGINE_SEGMENTS)?;
    let mut ids = HashSet::new();
    for item in items {
        let id = text(item.get("id"), super::MAX_ENGINE_TASK_ID_BYTES)?;
        if !ids.insert(id)
            || item.get("context_key").and_then(Value::as_str) != Some(context_key)
            || item.get("result_revision").and_then(Value::as_str) != Some(result_revision)
            || item
                .get("record_revision")
                .and_then(Value::as_u64)
                .is_none()
        {
            return Err("review record does not match the request".to_string());
        }
        text(item.get("task_id"), super::MAX_ENGINE_TASK_ID_BYTES)?;
        text(item.get("source_key"), super::MAX_ENGINE_PATH_BYTES)?;
        text(item.get("source_path"), super::MAX_ENGINE_PATH_BYTES)?;
        digest(item.get("source_sha256"))?;
        digest(item.get("analysis_signature"))?;
        text(item.get("layout_fingerprint"), 1024)?;
        text(item.get("reviewed_at"), 128)?;
    }
    payload_limit(segments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> Value {
        json!({"version":2,"sources":[{"source_key":"/a.pdf","source_path":"/a.pdf","source_sha256":"a".repeat(64)}],"criteria_fingerprint":"b".repeat(64),"computation_version":"m2-test"})
    }

    #[test]
    fn bounds_read_identity_before_engine_start() {
        assert!(read(&"a".repeat(64), "run-1").is_ok());
        for key in ["a".repeat(63), "g".repeat(64), "a".repeat(65)] {
            assert!(read(&key, "run-1").is_err());
        }
        for revision in [
            "".to_string(),
            " ".to_string(),
            "x\0y".to_string(),
            "r".repeat(129),
        ] {
            assert!(read(&"a".repeat(64), &revision).is_err());
        }
    }

    #[test]
    fn accepts_empty_zero_hit_manifest_but_not_missing_sources() {
        assert!(prepare(&context(), &json!([]), "run-1").is_ok());
        let mut missing = context();
        missing["sources"] = json!([]);
        assert!(prepare(&missing, &json!([]), "run-1").is_err());
    }

    #[test]
    fn rejects_database_override_oversized_revision_and_unregistered_source() {
        let mut overridden = context();
        overridden["database_path"] = json!("/other.sqlite3");
        assert!(prepare(&overridden, &json!([]), "run-1").is_err());
        assert!(prepare(&context(), &json!([]), &"r".repeat(129)).is_err());
        let item = json!({"id":"s1","source_key":"/other.pdf","analysis_signature":"c".repeat(64),"persistable":true});
        assert!(prepare(&context(), &json!([item]), "run-1").is_err());
    }

    #[test]
    fn rejects_duplicate_source_and_boolean_revision() {
        let mut duplicate = context();
        let source = duplicate["sources"][0].clone();
        duplicate["sources"].as_array_mut().unwrap().push(source);
        assert!(prepare(&duplicate, &json!([]), "run-1").is_err());
        let key = "d".repeat(64);
        let item =
            json!({"id":"s1","context_key":key,"result_revision":"run-1","record_revision":true});
        assert!(save(&key, "run-1", &json!([item])).is_err());
    }

    #[test]
    fn rejects_oversized_layout_metadata_before_engine_start() {
        let mut item = json!({"id":"s1","source_key":"/a.pdf","analysis_signature":"c".repeat(64),"persistable":true,"layout_fingerprint":"geometry:600:800"});
        assert!(prepare(&context(), &json!([item.clone()]), "run-1").is_ok());
        item["layout_fingerprint"] = json!("x".repeat(1025));
        assert!(prepare(&context(), &json!([item.clone()]), "run-1").is_err());
        let key = "d".repeat(64);
        item["context_key"] = json!(key);
        item["result_revision"] = json!("run-1");
        item["record_revision"] = json!(0);
        item["task_id"] = json!("t1");
        item["source_path"] = json!("/a.pdf");
        item["source_sha256"] = json!("a".repeat(64));
        item["reviewed_at"] = json!("2026-09-08T00:00:00.000Z");
        assert!(save(&key, "run-1", &json!([item.clone()])).is_err());
        item["layout_fingerprint"] = json!("geometry:600:800");
        assert!(save(&key, "run-1", &json!([item])).is_ok());
    }
}
