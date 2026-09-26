use serde::de::{self, Visitor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fmt;

const FEEDBACK_CHANNELS_JSON: &str = include_str!("../../src/domain/feedbackChannels.json");

pub const INVALID_FEEDBACK_CHANNEL_ERROR: &str = "反馈渠道无效，请选择 GitHub 或邮箱。";
pub const FEEDBACK_CHANNEL_CONFIG_ERROR: &str = "反馈渠道配置不可用，请稍后重试。";
pub const FEEDBACK_CHANNEL_UNSUPPORTED_ERROR: &str =
    "当前系统暂不支持直接打开反馈渠道，请复制地址后手动打开。";
pub const FEEDBACK_CHANNEL_NO_HANDLER_ERROR: &str =
    "未找到可用的默认浏览器或邮件客户端，请检查系统默认应用设置后重试。";
pub const FEEDBACK_CHANNEL_OPEN_ERROR: &str = "无法打开反馈渠道，请检查系统默认应用设置后重试。";

/// The webview may select a channel, but it cannot supply a destination.
/// Destinations are resolved from the embedded, reviewed resource below.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeedbackChannel {
    Github,
    Email,
}

impl<'de> Deserialize<'de> for FeedbackChannel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_str(FeedbackChannelVisitor)
    }
}

struct FeedbackChannelVisitor;

impl<'de> Visitor<'de> for FeedbackChannelVisitor {
    type Value = FeedbackChannel;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("the lowercase feedback channel `github` or `email`")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        match value {
            "github" => Ok(FeedbackChannel::Github),
            "email" => Ok(FeedbackChannel::Email),
            _ => Err(E::custom(INVALID_FEEDBACK_CHANNEL_ERROR)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FeedbackChannelConfig {
    #[serde(rename = "githubUrl")]
    github_url: String,
    email: String,
    #[serde(rename = "emailUrl")]
    email_url: String,
    wechat: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LauncherError {
    Unsupported,
    NoDefaultHandler,
    ComInitialization,
    ShellExecute,
}

impl LauncherError {
    fn user_message(self) -> &'static str {
        match self {
            Self::Unsupported => FEEDBACK_CHANNEL_UNSUPPORTED_ERROR,
            Self::NoDefaultHandler => FEEDBACK_CHANNEL_NO_HANDLER_ERROR,
            Self::ComInitialization | Self::ShellExecute => FEEDBACK_CHANNEL_OPEN_ERROR,
        }
    }
}

fn has_forbidden_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn validate_config(config: &FeedbackChannelConfig) -> Result<(), &'static str> {
    // These values are compile-time embedded, but keep the launcher fail-closed
    // if the reviewed resource is accidentally malformed or edited later.
    let values = [
        config.github_url.as_str(),
        config.email.as_str(),
        config.email_url.as_str(),
        config.wechat.as_str(),
    ];
    if values.iter().any(|value| {
        value.is_empty() || value.trim() != *value || has_forbidden_control_character(value)
    }) {
        return Err(FEEDBACK_CHANNEL_CONFIG_ERROR);
    }

    let github_url = config.github_url.as_str();
    if !github_url.starts_with("https://github.com/")
        || github_url.contains('?')
        || github_url.contains('#')
        || github_url.ends_with('/')
    {
        return Err(FEEDBACK_CHANNEL_CONFIG_ERROR);
    }

    let email_url = config.email_url.as_str();
    let email_prefix = format!("mailto:{}", config.email);
    if !email_url.starts_with(&email_prefix)
        || email_url
            .as_bytes()
            .get(email_prefix.len())
            .is_some_and(|byte| *byte != b'?')
        || !config.email.contains('@')
        || config.email.starts_with('@')
        || config.email.ends_with('@')
    {
        return Err(FEEDBACK_CHANNEL_CONFIG_ERROR);
    }

    Ok(())
}

fn load_config() -> Result<FeedbackChannelConfig, &'static str> {
    let config = serde_json::from_str::<FeedbackChannelConfig>(FEEDBACK_CHANNELS_JSON)
        .map_err(|_| FEEDBACK_CHANNEL_CONFIG_ERROR)?;
    validate_config(&config)?;
    Ok(config)
}

fn target_for_channel(channel: FeedbackChannel) -> Result<String, &'static str> {
    let config = load_config()?;
    Ok(match channel {
        FeedbackChannel::Github => config.github_url,
        FeedbackChannel::Email => config.email_url,
    })
}

fn open_feedback_channel_with_launcher<F>(
    channel: FeedbackChannel,
    launcher: F,
) -> Result<Value, String>
where
    F: FnOnce(&str) -> Result<(), LauncherError>,
{
    let target = target_for_channel(channel).map_err(str::to_owned)?;
    launcher(&target).map_err(|error| error.user_message().to_owned())?;
    Ok(json!({ "status": "opened" }))
}

#[cfg(target_os = "windows")]
fn shell_execute_succeeded(instance: isize) -> bool {
    instance > 32
}

#[cfg(target_os = "windows")]
fn launch_feedback_target(target: &str) -> Result<(), LauncherError> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::HINSTANCE;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    struct ComGuard;

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // CoInitializeEx succeeded with S_OK or S_FALSE, so this thread
            // owns one matching COM initialization to release.
            unsafe { CoUninitialize() };
        }
    }

    let target_wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let operation_wide: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();

    let com_result = unsafe {
        CoInitializeEx(
            null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    if com_result < 0 {
        return Err(LauncherError::ComInitialization);
    }
    let _com_guard = ComGuard;

    let instance: HINSTANCE = unsafe {
        ShellExecuteW(
            null_mut(),
            operation_wide.as_ptr(),
            target_wide.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if shell_execute_succeeded(instance as isize) {
        Ok(())
    } else {
        Err(LauncherError::NoDefaultHandler)
    }
}

#[cfg(not(target_os = "windows"))]
fn launch_feedback_target(_target: &str) -> Result<(), LauncherError> {
    Err(LauncherError::Unsupported)
}

/// Ask the operating system to open the reviewed destination for a channel.
/// The result only acknowledges that the OS launcher accepted the request; it
/// does not claim that a browser page or email was sent.
#[tauri::command]
pub async fn open_feedback_channel(channel: FeedbackChannel) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_feedback_channel_with_launcher(channel, launch_feedback_target)
    })
    .await
    .map_err(|_| FEEDBACK_CHANNEL_OPEN_ERROR.to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serde_accepts_only_lowercase_supported_channels() {
        assert_eq!(
            serde_json::from_str::<FeedbackChannel>(r#""github""#).unwrap(),
            FeedbackChannel::Github
        );
        assert_eq!(
            serde_json::from_str::<FeedbackChannel>(r#""email""#).unwrap(),
            FeedbackChannel::Email
        );
        for invalid in [
            r#""Github""#,
            r#""EMAIL""#,
            r#""mailto:someone@example.com""#,
            r#""https://attacker.example/""#,
            r#""github\n""#,
            "null",
            "{}",
        ] {
            let error = serde_json::from_str::<FeedbackChannel>(invalid).unwrap_err();
            let message = error.to_string();
            assert!(
                message.starts_with(INVALID_FEEDBACK_CHANNEL_ERROR)
                    || message.starts_with("invalid type"),
                "unexpected serde error for {invalid:?}: {message}"
            );
            assert!(!message.contains("attacker.example"));
            assert!(!message.contains("mailto:someone@example.com"));
        }
    }

    #[test]
    fn selected_targets_are_exactly_the_embedded_reviewed_values() {
        let config = load_config().expect("embedded feedback channel config should be valid");
        assert_eq!(
            target_for_channel(FeedbackChannel::Github).unwrap(),
            config.github_url
        );
        assert_eq!(
            target_for_channel(FeedbackChannel::Email).unwrap(),
            config.email_url
        );
    }

    #[test]
    fn fake_launcher_receives_only_the_fixed_target_and_returns_opened() {
        let expected = load_config()
            .expect("embedded feedback channel config should be valid")
            .github_url;
        let mut received = None;
        let result = open_feedback_channel_with_launcher(FeedbackChannel::Github, |target| {
            received = Some(target.to_owned());
            Ok(())
        })
        .expect("fake launcher should succeed");
        assert_eq!(received.as_deref(), Some(expected.as_str()));
        assert_eq!(result, json!({ "status": "opened" }));
    }

    #[test]
    fn launcher_failures_use_fixed_messages_without_target_or_input() {
        let target = target_for_channel(FeedbackChannel::Email).unwrap();
        let error = open_feedback_channel_with_launcher(FeedbackChannel::Email, |_target| {
            Err(LauncherError::NoDefaultHandler)
        })
        .unwrap_err();
        assert_eq!(error, FEEDBACK_CHANNEL_NO_HANDLER_ERROR);
        assert!(!error.contains(&target));
        assert!(!error.contains("mailto:"));

        let error = open_feedback_channel_with_launcher(FeedbackChannel::Github, |_target| {
            Err(LauncherError::ShellExecute)
        })
        .unwrap_err();
        assert_eq!(error, FEEDBACK_CHANNEL_OPEN_ERROR);
        assert!(!error.contains("https://"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn shell_execute_succeeds_only_above_the_documented_error_range() {
        assert!(!shell_execute_succeeded(0));
        assert!(!shell_execute_succeeded(32));
        assert!(shell_execute_succeeded(33));
        assert!(!shell_execute_succeeded(-1));
        assert!(shell_execute_succeeded(isize::MAX));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn non_windows_launcher_is_explicitly_unsupported() {
        let target = target_for_channel(FeedbackChannel::Github).unwrap();
        assert_eq!(
            launch_feedback_target(&target).unwrap_err().user_message(),
            FEEDBACK_CHANNEL_UNSUPPORTED_ERROR
        );
    }
}
