use rfd::FileDialog;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_FEEDBACK_REPORT_BYTES: usize = 32 * 1024;
const MAX_FEEDBACK_FILE_NAME_UTF16: usize = 240;

fn validate_report(report: &str) -> Result<(), String> {
    if report.trim().is_empty() {
        return Err("反馈内容不能为空。".to_string());
    }
    if report.as_bytes().len() > MAX_FEEDBACK_REPORT_BYTES {
        return Err("反馈内容过长，请删减后再保存。".to_string());
    }
    if report.chars().any(|character| {
        let code = character as u32;
        code == 0
            || (code < 0x20
                && code != ('\t' as u32)
                && code != ('\n' as u32)
                && code != ('\r' as u32))
    }) {
        return Err("反馈内容包含无法保存的控制字符。".to_string());
    }
    Ok(())
}

fn normalize_selected_path(path: PathBuf) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("反馈文件路径无效。".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "反馈文件名无效。".to_string())?;
    let device_name = file_name
        .split('.')
        .next()
        .unwrap_or(file_name)
        .to_ascii_lowercase();
    let reserved_device = matches!(device_name.as_str(), "con" | "prn" | "aux" | "nul")
        || (device_name.starts_with("com")
            && device_name.len() == 4
            && matches!(device_name.as_bytes()[3], b'1'..=b'9'))
        || (device_name.starts_with("lpt")
            && device_name.len() == 4
            && matches!(device_name.as_bytes()[3], b'1'..=b'9'));
    if file_name.is_empty()
        || file_name.encode_utf16().count() > MAX_FEEDBACK_FILE_NAME_UTF16
        || file_name.ends_with('.')
        || file_name.ends_with(' ')
        || reserved_device
        || file_name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
    {
        return Err("反馈文件必须使用 .txt 后缀。".to_string());
    }
    Ok(path)
}

fn feedback_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "反馈文件名无效。".to_string())
}

fn write_feedback_file_with<F>(path: &Path, report: &str, writer: F) -> Result<String, String>
where
    F: FnOnce(&mut File, &[u8]) -> io::Result<()>,
{
    validate_report(report)?;
    let path = normalize_selected_path(path.to_path_buf())?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err("反馈文件已存在，请更换文件名。".to_string());
        }
        Err(_) => return Err("无法创建反馈文件，请检查保存目录后重试。".to_string()),
    };

    if writer(&mut file, report.as_bytes()).is_err() {
        // Keep the newly created file in place.  Removing by pathname after a
        // write error could delete a replacement created by another process
        // during the error window.  The caller receives an explicit warning
        // and can remove the exact incomplete file manually.
        drop(file);
        return Err("反馈文件写入失败，文件可能不完整，请检查后重试。".to_string());
    }
    Ok(feedback_file_name(&path)?)
}

fn write_feedback_file(path: &Path, report: &str) -> Result<String, String> {
    write_feedback_file_with(path, report, |file, bytes| {
        file.write_all(bytes)?;
        file.flush()
    })
}

fn default_feedback_file_name() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("银行回单工作台_反馈_{timestamp}.txt")
}

/// Open the native save dialog only after the web UI has explicitly asked to
/// save.  The web side supplies report text only; the native side owns the
/// destination and filename policy.
#[tauri::command]
pub async fn save_feedback_report(report: String) -> Result<Value, String> {
    validate_report(&report)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = FileDialog::new()
            .set_title("保存使用反馈")
            .set_file_name(default_feedback_file_name())
            .add_filter("文本文件", &["txt"])
            .save_file()
        else {
            return Ok(json!({ "status": "cancelled" }));
        };
        let file_name = write_feedback_file(&path, &report)?;
        Ok(json!({ "status": "saved", "fileName": file_name }))
    })
    .await
    .map_err(|_| "保存反馈失败，请重试。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "pdf-search-feedback-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    #[test]
    fn validates_non_empty_utf8_and_bounded_report() {
        assert!(validate_report("中文反馈\n第二行").is_ok());
        assert_eq!(validate_report(" \n\t ").unwrap_err(), "反馈内容不能为空。");
        assert_eq!(
            validate_report(&"界".repeat(MAX_FEEDBACK_REPORT_BYTES / 3 + 1)).unwrap_err(),
            "反馈内容过长，请删减后再保存。"
        );
        assert_eq!(
            validate_report("bad\0text").unwrap_err(),
            "反馈内容包含无法保存的控制字符。"
        );
    }

    #[test]
    fn saves_unicode_text_and_returns_basename_only() {
        let root = test_root("unicode");
        fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("银行回单工作台_反馈_1.txt");
        let name = write_feedback_file(&path, "问题描述：中文反馈").expect("report should save");
        assert_eq!(name, "银行回单工作台_反馈_1.txt");
        assert_eq!(fs::read_to_string(&path).unwrap(), "问题描述：中文反馈");
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let root = test_root("existing");
        fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("existing.txt");
        fs::write(&path, "原内容").expect("existing report should be created");
        assert_eq!(
            write_feedback_file(&path, "新内容").unwrap_err(),
            "反馈文件已存在，请更换文件名。"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "原内容");
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn keeps_an_incomplete_new_file_when_writing_fails() {
        let root = test_root("failure");
        fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("failed.txt");
        let result = write_feedback_file_with(&path, "中文反馈", |_file, _bytes| {
            Err(io::Error::new(
                io::ErrorKind::Other,
                "injected write failure",
            ))
        });
        assert_eq!(
            result.unwrap_err(),
            "反馈文件写入失败，文件可能不完整，请检查后重试。"
        );
        assert!(path.exists());
        fs::remove_file(&path).expect("incomplete report should be removable by the user");
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn rejects_non_txt_or_relative_native_paths() {
        assert!(normalize_selected_path(PathBuf::from("feedback.pdf")).is_err());
        assert!(normalize_selected_path(PathBuf::from("feedback.txt")).is_err());
    }

    #[test]
    fn rejects_windows_ads_controls_and_reserved_devices() {
        let root = test_root("names");
        for name in [
            "feedback:stream.txt",
            "feedback\u{0007}.txt",
            "CON.txt",
            "report.txt ",
            "report.txt.",
        ] {
            assert!(
                normalize_selected_path(root.join(name)).is_err(),
                "name should be rejected: {name:?}"
            );
        }
    }

    #[test]
    fn default_name_contains_app_label_feedback_and_txt_suffix() {
        let name = default_feedback_file_name();
        assert!(name.starts_with("银行回单工作台_反馈_"));
        assert!(name.ends_with(".txt"));
    }

    #[test]
    fn name_length_uses_the_same_utf16_limit_as_the_webview() {
        let root = test_root("name-length");
        assert!(normalize_selected_path(root.join(format!("{}.txt", "😀".repeat(118)))).is_ok());
        assert!(normalize_selected_path(root.join(format!("{}.txt", "😀".repeat(119)))).is_err());
    }
}
