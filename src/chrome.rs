use anyhow::{anyhow, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::config::GlobalConfig;
use crate::service::ServiceDefinition;

/// Returns true if the current process is running inside a Flatpak sandbox.
pub fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Run a command on the host when inside Flatpak, or directly otherwise.
fn host_command(program: &str) -> Command {
    if is_flatpak() {
        let mut cmd = Command::new("flatpak-spawn");
        cmd.arg("--host").arg(program);
        cmd
    } else {
        Command::new(program)
    }
}

#[derive(Debug, Clone)]
pub struct ChromeInfo {
    pub path: String,
    pub display_name: String,
    pub launch_method: LaunchMethod,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LaunchMethod {
    Direct,
    AppImage,
    /// Flatpak-installed Chrome. The `ChromeInfo.path` field holds the Flatpak
    /// app ID (e.g. `"com.google.Chrome"`).
    Flatpak,
}

/// Detect Chrome by searching in the order specified in CLAUDE.md.
pub fn detect_chrome(config: &GlobalConfig) -> Result<ChromeInfo> {
    // 1. User override from config
    if let Some(path) = &config.chrome_path {
        // Check if this is a Flatpak app ID (e.g. "com.google.Chrome")
        if (path.starts_with("com.") || path.starts_with("org."))
            && !path.contains('/')
        {
            if let Ok(output) = host_command("flatpak").args(["info", path]).output() {
                if output.status.success() {
                    return Ok(ChromeInfo {
                        path: path.clone(),
                        display_name: "Google Chrome (Flatpak)".to_string(),
                        launch_method: LaunchMethod::Flatpak,
                    });
                }
            }
            tracing::warn!("Configured Flatpak app {} not installed", path);
        } else if is_host_executable(path) {
            return Ok(ChromeInfo {
                path: path.clone(),
                display_name: "Custom".to_string(),
                launch_method: LaunchMethod::Direct,
            });
        } else {
            tracing::warn!("Configured Chrome path {} is not executable", path);
        }
    }

    // Return the first result from detect_all_chrome
    detect_all_chrome()
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("Google Chrome not found. Please install Google Chrome and try again."))
}

/// Detect all Chrome installations on the system.
/// Returns a deduplicated list (by resolved path) in priority order.
pub fn detect_all_chrome() -> Vec<ChromeInfo> {
    let mut results = Vec::new();
    let mut seen_paths = HashSet::new();

    // Helper: add to results if path not already seen (resolving symlinks for dedup)
    let mut add = |info: ChromeInfo| {
        let canonical = std::fs::canonicalize(&info.path)
            .unwrap_or_else(|_| PathBuf::from(&info.path));
        let key = canonical.to_string_lossy().to_string();
        if seen_paths.insert(key) {
            results.push(info);
        }
    };

    // 1. Search PATH for google-chrome / google-chrome-stable
    for name in &["google-chrome-stable", "google-chrome"] {
        if let Ok(output) = host_command("which").arg(name).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    add(ChromeInfo {
                        display_name: display_name_for_binary(name),
                        path,
                        launch_method: LaunchMethod::Direct,
                    });
                }
            }
        }
    }

    // 2. Well-known paths
    for path in &[
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/opt/google/chrome/google-chrome",
    ] {
        if is_host_executable(path) {
            let basename = Path::new(path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy();
            add(ChromeInfo {
                display_name: display_name_for_binary(&basename),
                path: path.to_string(),
                launch_method: LaunchMethod::Direct,
            });
        }
    }

    // 3. AppImage scan
    if let Some(home) = dirs::home_dir() {
        let scan_dirs = [home.join("Applications"), home.join(".local/bin")];
        for dir in &scan_dirs {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy().to_lowercase();
                    if name_str.contains("chrome") && name_str.ends_with(".appimage") {
                        let path = entry.path();
                        if is_executable(&path) {
                            let file_name = name.to_string_lossy().to_string();
                            add(ChromeInfo {
                                display_name: format!("Chrome AppImage ({})", file_name),
                                path: path.to_string_lossy().to_string(),
                                launch_method: LaunchMethod::AppImage,
                            });
                        }
                    }
                }
            }
        }
    }

    // 4. Flatpak
    if let Ok(output) = host_command("flatpak").args(["info", "com.google.Chrome"]).output() {
        if output.status.success() {
            add(ChromeInfo {
                display_name: "Google Chrome (Flatpak)".to_string(),
                path: "com.google.Chrome".to_string(),
                launch_method: LaunchMethod::Flatpak,
            });
        }
    }

    results
}

/// Map a Chrome binary name to a human-readable display name.
fn display_name_for_binary(name: &str) -> String {
    match name {
        "google-chrome-stable" => "Google Chrome Stable".to_string(),
        "google-chrome" => "Google Chrome".to_string(),
        _ => name.to_string(),
    }
}

/// Build the Chrome command-line arguments for a service.
///
/// Uses `--remote-debugging-pipe` + CDP `Extensions.loadUnpacked` to load the
/// extension (since `--load-extension` was removed from branded Chrome 137+).
/// The pipe fds (3/4) are set up via `pre_exec` in the daemon's spawn logic.
pub fn build_chrome_args(
    service: &ServiceDefinition,
    profile_path: &Path,
    _launch_method: &LaunchMethod,
) -> Vec<String> {
    vec![
        format!("--app={}", service.url),
        format!("--user-data-dir={}", profile_path.display()),
        format!("--class=loft-{}", service.name),
        "--enable-unsafe-extension-debugging".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--remote-debugging-pipe".to_string(),
    ]
}

/// Build a Command to launch Chrome based on the detection method.
///
/// When Loft is running inside a Flatpak sandbox, Chrome lives on the host,
/// so all launch methods go through `flatpak-spawn --host`.
pub fn build_chrome_command(
    chrome: &ChromeInfo,
    args: &[String],
) -> Command {
    let in_flatpak = is_flatpak();

    match chrome.launch_method {
        LaunchMethod::Flatpak => {
            // Chrome is itself a Flatpak app — launch it via `flatpak run`.
            // Grant access to the Loft data dir so Chrome can see the
            // extension and write to the profile inside the sandbox.
            // --talk-name=org.freedesktop.Flatpak allows flatpak-spawn --host
            // in the NM host script to call the loft binary on the host.
            let loft_data = loft_data_dir_on_host();
            let flatpak_args = [
                "run",
                &format!("--filesystem={}", loft_data.display()),
                "--talk-name=org.freedesktop.Flatpak",
            ];

            if in_flatpak {
                // Loft is Flatpak → Chrome is Flatpak: spawn on host
                let mut cmd = Command::new("flatpak-spawn");
                cmd.arg("--host").arg("flatpak");
                cmd.args(flatpak_args);
                cmd.arg(&chrome.path);
                cmd.args(args);
                cmd
            } else {
                // Loft is native → Chrome is Flatpak: call flatpak directly
                let mut cmd = Command::new("flatpak");
                cmd.args(flatpak_args);
                cmd.arg(&chrome.path);
                cmd.args(args);
                cmd
            }
        }
        _ => {
            if in_flatpak {
                // Loft is Flatpak → Chrome is native: spawn on host
                let mut cmd = Command::new("flatpak-spawn");
                cmd.arg("--host").arg(&chrome.path);
                cmd.args(args);
                cmd
            } else {
                let mut cmd = Command::new(&chrome.path);
                cmd.args(args);
                cmd
            }
        }
    }
}

/// Return the Loft data directory as it appears on the host filesystem.
/// Inside a Flatpak sandbox, `dirs::data_dir()` returns the sandbox path
/// (`~/.var/app/chat.loft.Loft/data`), but Chrome on the host needs the
/// real path. We read `$HOME` from the host via `/.flatpak-info` or fall back
/// to `~/.local/share/loft`.
fn loft_data_dir_on_host() -> PathBuf {
    if is_flatpak() {
        // Inside Flatpak, $HOME is the real home dir (not remapped).
        // The host Chrome needs access to the sandbox's data dir.
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("loft")
    } else {
        dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from("~/.local/share"))
            .join("loft")
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

/// Check if a path is executable on the host (works inside Flatpak sandbox).
fn is_host_executable(path: &str) -> bool {
    if is_flatpak() {
        host_command("test")
            .args(["-x", path])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    } else {
        is_executable(Path::new(path))
    }
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
    fn test_build_chrome_args_native() {
        let service = &crate::service::WHATSAPP;
        let profile = PathBuf::from("/home/user/.local/share/loft/profiles/whatsapp");

        let args = build_chrome_args(service, &profile, &LaunchMethod::Direct);

        assert_eq!(args[0], "--app=https://web.whatsapp.com/");
        assert!(args[1].contains("profiles/whatsapp"));
        assert_eq!(args[2], "--class=loft-whatsapp");
        assert!(args.contains(&"--remote-debugging-pipe".to_string()));
        assert!(args.contains(&"--enable-unsafe-extension-debugging".to_string()));
        assert!(!args.iter().any(|a| a.starts_with("--load-extension")));
    }

    #[test]
    fn test_build_chrome_args_flatpak() {
        let service = &crate::service::WHATSAPP;
        let profile = PathBuf::from("/home/user/.local/share/loft/profiles/whatsapp");

        let args = build_chrome_args(service, &profile, &LaunchMethod::Flatpak);

        assert_eq!(args[0], "--app=https://web.whatsapp.com/");
        assert!(args.contains(&"--remote-debugging-pipe".to_string()));
    }

    #[test]
    fn test_build_chrome_command_direct() {
        let chrome = ChromeInfo {
            path: "/usr/bin/google-chrome".to_string(),
            display_name: "Google Chrome".to_string(),
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
            ..Default::default()
        };
        // Should fall through since the path doesn't exist
        // (may still find Chrome on system, so we just check it doesn't panic)
        let _ = detect_chrome(&config);
    }
}
