use rfd::FileDialog;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const TEMPLATE_NAME: &str = "本方账户导入模板.xlsx";
const TEMPLATE_BYTES: &[u8] = include_bytes!("../../public/templates/本方账户导入模板.xlsx");

fn validate_destination(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("模板文件路径无效。".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "模板文件名无效。".to_string())?;
    let device = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    let reserved = matches!(device.as_str(), "con" | "prn" | "aux" | "nul")
        || (device.len() == 4
            && (device.starts_with("com") || device.starts_with("lpt"))
            && matches!(device.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty()
        || name.trim() != name
        || name.encode_utf16().count() > 240
        || name.ends_with('.')
        || reserved
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err("模板文件名无效。".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("xlsx"))
    {
        return Err("模板文件必须使用 .xlsx 后缀。".to_string());
    }
    Ok(name.to_string())
}

fn write_template_with<F>(path: &Path, writer: F) -> Result<String, String>
where
    F: FnOnce(&mut File, &[u8]) -> io::Result<()>,
{
    let name = validate_destination(path)?;
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err("模板文件已存在，请更换文件名。".to_string());
        }
        Err(_) => return Err("无法创建模板文件，请检查保存目录后重试。".to_string()),
    };
    if writer(&mut file, TEMPLATE_BYTES).is_err() {
        // As with feedback saving, never delete by pathname after a failed
        // write: another process could have replaced this new file meanwhile.
        return Err("模板文件写入失败，文件可能不完整，请检查后重试。".to_string());
    }
    Ok(name)
}

fn save_with_picker<F>(picker: F) -> Result<Value, String>
where
    F: FnOnce() -> Option<PathBuf>,
{
    let Some(path) = picker() else {
        return Ok(json!({ "status": "cancelled" }));
    };
    let file_name = write_template_with(&path, |file, bytes| {
        file.write_all(bytes)?;
        file.flush()
    })?;
    Ok(json!({ "status": "saved", "fileName": file_name }))
}

/// Only a user-selected destination and the compiled-in public template are
/// used. The webview cannot choose arbitrary source paths or file contents.
#[tauri::command]
pub async fn save_company_account_template() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        save_with_picker(|| {
            FileDialog::new()
                .set_title("保存本方账户导入模板")
                .set_file_name(TEMPLATE_NAME)
                .add_filter("Excel 工作簿", &["xlsx"])
                .save_file()
        })
    })
    .await
    .map_err(|_| "保存导入模板失败，请重试。".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "account-template-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    #[test]
    fn saves_exact_public_workbook_and_returns_only_the_selected_basename() {
        let root = test_root("save");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("本方账户模板副本.xlsx");
        let result = save_with_picker(|| Some(path.clone())).unwrap();
        assert_eq!(
            result,
            json!({ "status": "saved", "fileName": "本方账户模板副本.xlsx" })
        );
        assert_eq!(fs::read(&path).unwrap(), TEMPLATE_BYTES);
        assert_eq!(
            TEMPLATE_BYTES,
            fs::read(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../public/templates/本方账户导入模板.xlsx")
            )
            .unwrap()
        );
        assert!(TEMPLATE_BYTES.starts_with(b"PK\x03\x04"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancellation_returns_without_creating_a_file() {
        let root = test_root("cancel");
        let result = save_with_picker(|| None).unwrap();
        assert_eq!(result, json!({ "status": "cancelled" }));
        assert!(!root.exists());
    }

    #[test]
    fn never_overwrites_an_existing_workbook() {
        let root = test_root("existing");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(TEMPLATE_NAME);
        fs::write(&path, b"existing user workbook").unwrap();
        assert_eq!(
            save_with_picker(|| Some(path.clone())).unwrap_err(),
            "模板文件已存在，请更换文件名。"
        );
        assert_eq!(fs::read(&path).unwrap(), b"existing user workbook");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creation_failure_is_a_safe_chinese_error() {
        let root = test_root("missing");
        let result = save_with_picker(|| Some(root.join(TEMPLATE_NAME)));
        assert_eq!(
            result.unwrap_err(),
            "无法创建模板文件，请检查保存目录后重试。"
        );
        assert!(!root.exists());
    }

    #[test]
    fn keeps_the_new_file_and_reports_write_failure() {
        let root = test_root("write");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(TEMPLATE_NAME);
        let result = write_template_with(&path, |file, _| {
            file.write_all(b"partial")?;
            Err(io::Error::new(io::ErrorKind::Other, "injected failure"))
        });
        assert_eq!(
            result.unwrap_err(),
            "模板文件写入失败，文件可能不完整，请检查后重试。"
        );
        assert_eq!(fs::read(&path).unwrap(), b"partial");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unsafe_paths_names_and_extensions_before_writing() {
        let root = test_root("names");
        assert!(validate_destination(Path::new("relative.xlsx")).is_err());
        for name in [
            "CON.xlsx",
            "a:stream.xlsx",
            "a\u{0007}.xlsx",
            "a.xlsx ",
            "a.xlsx.",
            "a.txt",
        ] {
            assert!(validate_destination(&root.join(name)).is_err(), "{name:?}");
        }
        assert!(validate_destination(&root.join(format!("{}.xlsx", "😀".repeat(117)))).is_ok());
        assert!(validate_destination(&root.join(format!("{}.xlsx", "😀".repeat(118)))).is_err());
        assert!(!root.exists());
    }
}
