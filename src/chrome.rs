use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::GlobalConfig;
use crate::service::ServiceDefinition;

#[derive(Debug, Clone)]
pub struct ChromeInfo {
    pub path: String,
    pub launch_method: LaunchMethod,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LaunchMethod {
    Direct,
    Flatpak,
    AppImage,
}

/// Detect Chrome by searching in the order specified in CLAUDE.md.
pub fn detect_chrome(config: &GlobalConfig) -> Result<ChromeInfo> {
    // 1. User override from config
    if let Some(path) = &config.chrome_path {
        if is_executable(Path::new(path)) {
            return Ok(ChromeInfo {
                path: path.clone(),
                launch_method: LaunchMethod::Direct,
            });
        }
        tracing::warn!("Configured Chrome path {} is not executable", path);
    }

    // 2. Search PATH for google-chrome / google-chrome-stable
    for name in &["google-chrome-stable", "google-chrome"] {
        if let Ok(output) = Command::new("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(ChromeInfo {
                        path,
                        launch_method: LaunchMethod::Direct,
                    });
                }
            }
        }
    }

    // 3-4. Well-known paths
    for path in &[
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/opt/google/chrome/google-chrome",
    ] {
        if is_executable(Path::new(path)) {
            return Ok(ChromeInfo {
                path: path.to_string(),
                launch_method: LaunchMethod::Direct,
            });
        }
    }

    // 5. Flatpak
    if let Ok(output) = Command::new("flatpak")
        .args(["info", "com.google.Chrome"])
        .output()
    {
        if output.status.success() {
            return Ok(ChromeInfo {
                path: "com.google.Chrome".to_string(),
                launch_method: LaunchMethod::Flatpak,
            });
        }
    }

    // 6. AppImage scan
    if let Some(home) = dirs::home_dir() {
        let scan_dirs = [
            home.join("Applications"),
            home.join(".local/bin"),
        ];
        for dir in &scan_dirs {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy().to_lowercase();
                    if name_str.contains("chrome") && name_str.ends_with(".appimage") {
                        let path = entry.path();
                        if is_executable(&path) {
                            return Ok(ChromeInfo {
                                path: path.to_string_lossy().to_string(),
                                launch_method: LaunchMethod::AppImage,
                            });
                        }
                    }
                }
            }
        }
    }

    Err(anyhow!(
        "Google Chrome not found. Please install Google Chrome and try again."
    ))
}

/// Check if we're running inside a Flatpak sandbox.
pub fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Build the Chrome command-line arguments for a service.
///
/// Chrome 137+ removed `--load-extension` from branded builds, so we use
/// `--remote-debugging-pipe` + CDP `Extensions.loadUnpacked` instead.
pub fn build_chrome_args(
    service: &ServiceDefinition,
    profile_path: &Path,
) -> Vec<String> {
    vec![
        format!("--app={}", service.url),
        format!("--user-data-dir={}", profile_path.display()),
        format!("--class=loft-{}", service.name),
        "--remote-debugging-pipe".to_string(),
        "--enable-unsafe-extension-debugging".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--ozone-platform=wayland".to_string(),
    ]
}

/// Build a Command to launch Chrome based on the detection method.
pub fn build_chrome_command(
    chrome: &ChromeInfo,
    args: &[String],
) -> Command {
    match chrome.launch_method {
        LaunchMethod::Direct | LaunchMethod::AppImage => {
            let mut cmd = Command::new(&chrome.path);
            cmd.args(args);
            cmd
        }
        LaunchMethod::Flatpak => {
            if is_flatpak() {
                // Inside Flatpak: use flatpak-spawn --host
                let mut cmd = Command::new("flatpak-spawn");
                cmd.arg("--host")
                    .arg("flatpak")
                    .arg("run")
                    .arg(&chrome.path);
                cmd.args(args);
                cmd
            } else {
                // Outside Flatpak: use flatpak run directly
                let mut cmd = Command::new("flatpak");
                cmd.arg("run").arg(&chrome.path);
                cmd.args(args);
                cmd
            }
        }
    }
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.exists()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Return the data directory for a service's Chrome profile.
pub fn profile_path(service_name: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("loft/profiles")
        .join(service_name)
}

/// Return the path where the extension is stored.
pub fn extension_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("loft/extension")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_chrome_args() {
        let service = &crate::service::WHATSAPP;
        let profile = PathBuf::from("/home/user/.local/share/loft/profiles/whatsapp");

        let args = build_chrome_args(service, &profile);

        assert_eq!(args.len(), 8);
        assert_eq!(args[0], "--app=https://web.whatsapp.com/");
        assert!(args[1].contains("profiles/whatsapp"));
        assert_eq!(args[2], "--class=loft-whatsapp");
        assert_eq!(args[3], "--remote-debugging-pipe");
        assert_eq!(args[4], "--enable-unsafe-extension-debugging");
        assert_eq!(args[5], "--no-first-run");
        assert_eq!(args[6], "--no-default-browser-check");
        assert_eq!(args[7], "--ozone-platform=wayland");
    }

    #[test]
    fn test_build_chrome_command_direct() {
        let chrome = ChromeInfo {
            path: "/usr/bin/google-chrome".to_string(),
            launch_method: LaunchMethod::Direct,
        };
        let args = vec!["--app=https://example.com".to_string()];
        let cmd = build_chrome_command(&chrome, &args);

        assert_eq!(cmd.get_program(), "/usr/bin/google-chrome");
    }

    #[test]
    fn test_profile_path() {
        let path = profile_path("whatsapp");
        assert!(path.to_string_lossy().contains("loft/profiles/whatsapp"));
    }

    #[test]
    fn test_extension_path() {
        let path = extension_path();
        assert!(path.to_string_lossy().contains("loft/extension"));
    }

    #[test]
    fn test_config_override_nonexistent() {
        let config = GlobalConfig {
            chrome_path: Some("/nonexistent/path/chrome".to_string()),
            hide_minimized_suggested: false,
        };
        // Should fall through since the path doesn't exist
        // (may still find Chrome on system, so we just check it doesn't panic)
        let _ = detect_chrome(&config);
    }
}
