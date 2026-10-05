//! Opt-in JSONL progress for one export command. Ordinary engine calls keep
//! their existing single-response protocol and process deadlines.

use serde_json::Value;
use std::io::{BufRead, BufReader, Read};

const MAX_PROGRESS_FRAMES: usize = 20_000;
const MAX_PROGRESS_BYTES: usize = 1024;

fn valid_progress(frame: &Value) -> bool {
    let Some(object) = frame.as_object() else {
        return false;
    };
    if object.len() != 5
        || frame["type"] != "export_progress"
        || !matches!(
            frame["stage"].as_str(),
            Some(
                "validating"
                    | "rendering"
                    | "writing_pdf"
                    | "saving"
                    | "indexing"
                    | "verifying"
                    | "finalizing"
            )
        )
    {
        return false;
    }
    if ["completed", "total", "unit"]
        .iter()
        .all(|key| object.get(*key) == Some(&Value::Null))
    {
        return true;
    }
    match (
        frame["completed"].as_u64(),
        frame["total"].as_u64(),
        frame["unit"].as_str(),
    ) {
        (Some(done), Some(total), Some("pages" | "files")) => {
            total > 0 && total <= 100_000 && done <= total
        }
        _ => false,
    }
}

pub fn read_response<R: Read>(
    reader: R,
    max_response_bytes: usize,
    mut emit: impl FnMut(Value),
) -> Result<String, String> {
    let mut reader = BufReader::new(reader);
    let mut final_response = None;
    let mut progress_count = 0;
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .by_ref()
            .take(max_response_bytes.saturating_add(1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "local engine export response could not be read")?;
        if read == 0 {
            break;
        }
        if read > max_response_bytes {
            return Err("local engine response exceeded the size limit".into());
        }
        if final_response.is_some() {
            return Err("local engine returned data after the final export response".into());
        }
        let line =
            String::from_utf8(bytes).map_err(|_| "local engine returned non-UTF-8 response")?;
        let frame: Value =
            serde_json::from_str(&line).map_err(|_| "local engine returned invalid export JSON")?;
        if frame["type"] == "export_progress" {
            progress_count += 1;
            if read > MAX_PROGRESS_BYTES
                || progress_count > MAX_PROGRESS_FRAMES
                || !valid_progress(&frame)
            {
                return Err("local engine returned invalid export progress".into());
            }
            emit(frame);
        } else if matches!(frame["status"].as_str(), Some("ok" | "error")) {
            final_response = Some(line);
        } else {
            return Err("local engine returned an invalid final export response".into());
        }
    }
    final_response.ok_or_else(|| "local engine returned no final export response".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn progress() -> Value {
        json!({"type":"export_progress", "stage":"rendering", "completed":1, "total":3, "unit":"pages"})
    }

    #[test]
    fn forwards_progress_and_waits_for_the_final_result() {
        let body = format!(
            "{}\n{}\n{{\"status\":\"ok\",\"data\":{{}}}}\n",
            progress(),
            json!({"type":"export_progress", "stage":"writing_pdf", "completed":null, "total":null, "unit":null})
        );
        let mut received = Vec::new();
        let result = read_response(Cursor::new(body), 4096, |frame| received.push(frame)).unwrap();
        assert_eq!(received.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["status"],
            "ok"
        );
        assert!(read_response(Cursor::new(format!("{}\n", progress())), 4096, |_| {}).is_err());
    }

    #[test]
    fn accepts_an_error_result_but_rejects_invalid_or_unbounded_frames() {
        assert!(read_response(Cursor::new(b"{\"status\":\"error\"}\n"), 4096, |_| {}).is_ok());
        for frame in [
            json!({"type":"export_progress", "stage":"invented", "completed":null, "total":null, "unit":null}),
            json!({"type":"export_progress", "stage":"rendering", "completed":4, "total":3, "unit":"pages"}),
            json!({"type":"export_progress", "stage":"rendering", "completed":0, "total":0, "unit":"pages"}),
        ] {
            assert!(read_response(Cursor::new(format!("{frame}\n")), 4096, |_| {}).is_err());
        }
        assert!(read_response(Cursor::new(b"{\"status\":\"ok\"}\nextra\n"), 4096, |_| {}).is_err());
        assert!(read_response(Cursor::new(" ".repeat(4097)), 4096, |_| {}).is_err());
        let oversized = format!("{}{}\n", " ".repeat(MAX_PROGRESS_BYTES), progress());
        assert!(read_response(Cursor::new(oversized), 4096, |_| {}).is_err());
        let too_many = format!("{}\n", progress()).repeat(MAX_PROGRESS_FRAMES + 1);
        assert!(read_response(Cursor::new(too_many), 4096, |_| {}).is_err());
    }
}
