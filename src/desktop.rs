use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::config::ServiceConfig;
use crate::service::ServiceDefinition;

/// Deterministic extension ID derived from the public key in extension/manifest.json.
const EXTENSION_ID: &str = "eofapmpkglkhhdjadegnleadgbjooljp";

/// Install a service: fetch icon, create .desktop file, set up NM host manifest.
pub fn install_service(definition: &ServiceDefinition) -> Result<()> {
    deploy_extension()?;
    deploy_gnome_shell_extension()?;
    ensure_icons_for(definition)?;
    create_desktop_entry(definition)?;
    create_chrome_desktop_file(definition)?;
    setup_nm_host()?;
    ServiceConfig::default().save(&definition.name)?;
    tracing::info!("Installed service: {}", definition.display_name);
    Ok(())
}

/// Uninstall a service: remove .desktop file, icon, config.
/// If `delete_data` is true, also removes the Chrome profile directory.
pub fn uninstall_service(definition: &ServiceDefinition, delete_data: bool) -> Result<()> {
    remove_desktop_entry(definition)?;

    // Remove autostart entry (XDG path; portal cleanup is best-effort)
    let _ = set_autostart(definition, false);

    // Remove app and tray icons from XDG icon theme
    remove_icons_from_theme(definition);

    // Remove per-service config
    let config_path = config_dir()
        .join("services")
        .join(format!("{}.toml", definition.name));
    let _ = std::fs::remove_file(&config_path);

    // Remove Chrome profile if user chose to delete data
    if delete_data {
        let profile = crate::chrome::profile_path(definition.name);
        if profile.exists() {
            let _ = std::fs::remove_dir_all(&profile);
            tracing::info!("Removed Chrome profile: {}", profile.display());
        }
    }

    // Remove NM host manifest if no services remain installed
    if !any_service_installed() {
        let _ = remove_nm_host();
    }

    tracing::info!("Uninstalled service: {}", definition.display_name);
    Ok(())
}

/// Check if a service is installed (has a .desktop file).
pub fn is_service_installed(definition: &ServiceDefinition) -> bool {
    desktop_entry_path(definition).exists()
}

// ============================================================
// Paths
// ============================================================

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("loft")
}

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("~/.config"))
        .join("loft")
}

fn desktop_entry_path(definition: &ServiceDefinition) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("applications")
        .join(format!("loft-{}.desktop", definition.name))
}

fn nm_host_manifest_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("~/.config"))
        .join("google-chrome/NativeMessagingHosts/chat.loft.host.json")
}

// ============================================================
// .desktop file management
// ============================================================

fn create_desktop_entry(definition: &ServiceDefinition) -> Result<()> {
    let loft_binary = std::env::current_exe().context("Could not determine loft binary path")?;
    let icon_path = data_dir().join("icons").join(definition.app_icon_filename);

    let content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={name}\n\
         Comment=Open {name} via Loft\n\
         Exec={exec} --service {service}\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=Network;InstantMessaging;\n\
         StartupWMClass=loft-{service}\n",
        name = definition.display_name,
        exec = loft_binary.display(),
        service = definition.name,
        icon = icon_path.display(),
    );

    let path = desktop_entry_path(definition);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, content)
        .with_context(|| format!("Failed to write {}", path.display()))?;

    tracing::debug!("Created .desktop file: {}", path.display());
    Ok(())
}

fn remove_desktop_entry(definition: &ServiceDefinition) -> Result<()> {
    let path = desktop_entry_path(definition);
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("Failed to remove {}", path.display()))?;
        tracing::debug!("Removed .desktop file: {}", path.display());
    }
    // Also remove the Chrome notification alias
    let alias = chrome_notification_desktop_path(definition);
    if alias.exists() {
        let _ = std::fs::remove_file(&alias);
    }
    Ok(())
}

fn chrome_notification_desktop_path(definition: &ServiceDefinition) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("applications")
        .join(format!("{}.desktop", definition.chrome_desktop_id))
}

/// Create a hidden .desktop file matching Chrome's auto-generated app identity.
///
/// Chrome in `--app=URL` mode sets the window's app-id / WM_CLASS to something
/// like `chrome-web.whatsapp.com__-Default`.  GNOME uses this to resolve the
/// window name and icon in alt-tab, and to resolve notification click activation.
///
/// Chrome also auto-generates its own `.desktop` file with this ID, but it has
/// `NoDisplay=true` and **no `Exec=` line**.  Without a valid `Exec=`, calling
/// `g_app_info_get_executable()` returns NULL, which crashes Mutter
/// (`strlen(NULL)` in `sn_launcher_context_set_binary_name`).
///
/// We pre-create this file with a valid `Exec=` line so that:
/// 1. Alt-tab shows the correct name and icon
/// 2. Notification click activation doesn't crash GNOME
///
/// The daemon also rewrites this file after Chrome spawns (since Chrome
/// overwrites it on launch), see `daemon::mod.rs::fix_chrome_desktop_file`.
pub fn create_chrome_desktop_file(definition: &ServiceDefinition) -> Result<()> {
    let loft_binary = std::env::current_exe().context("Could not determine loft binary path")?;
    let icon_path = data_dir().join("icons").join(definition.app_icon_filename);

    let content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={name}\n\
         Exec={exec} --service {service}\n\
         Icon={icon}\n\
         NoDisplay=true\n",
        name = definition.display_name,
        exec = loft_binary.display(),
        service = definition.name,
        icon = icon_path.display(),
    );

    let path = chrome_notification_desktop_path(definition);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, &content)
        .with_context(|| format!("Failed to write Chrome desktop file {}", path.display()))?;

    tracing::debug!("Created Chrome desktop file: {}", path.display());
    Ok(())
}

// ============================================================
// Extension deployment
// ============================================================

/// Deploy the Chrome extension files to ~/.local/share/loft/extension/.
fn deploy_extension() -> Result<()> {
    let ext_dir = crate::chrome::extension_path();
    std::fs::create_dir_all(&ext_dir)
        .with_context(|| format!("Failed to create extension dir {}", ext_dir.display()))?;

    // Embed extension files at compile time
    let files: &[(&str, &str)] = &[
        ("manifest.json", include_str!("../extension/manifest.json")),
        ("background.js", include_str!("../extension/background.js")),
        ("content.js", include_str!("../extension/content.js")),
        ("notification-override.js", include_str!("../extension/notification-override.js")),
        ("offscreen.html", include_str!("../extension/offscreen.html")),
    ];

    for (name, content) in files {
        std::fs::write(ext_dir.join(name), content)
            .with_context(|| format!("Failed to write extension file {}", name))?;
    }

    tracing::debug!("Deployed extension to {}", ext_dir.display());
    Ok(())
}

/// Deploy the GNOME Shell extension to ~/.local/share/gnome-shell/extensions/loft-shell-helper@chat.loft/.
fn deploy_gnome_shell_extension() -> Result<()> {
    let ext_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("gnome-shell/extensions/loft-shell-helper@chat.loft");
    std::fs::create_dir_all(&ext_dir)
        .with_context(|| format!("Failed to create GNOME Shell extension dir {}", ext_dir.display()))?;

    let files: &[(&str, &str)] = &[
        ("metadata.json", include_str!("../gnome-shell-extension/metadata.json")),
        ("extension.js", include_str!("../gnome-shell-extension/extension.js")),
    ];

    for (name, content) in files {
        std::fs::write(ext_dir.join(name), content)
            .with_context(|| format!("Failed to write GNOME Shell extension file {}", name))?;
    }

    tracing::debug!("Deployed GNOME Shell extension to {}", ext_dir.display());

    // Best-effort: enable the extension (requires gnome-extensions CLI)
    match std::process::Command::new("gnome-extensions")
        .args(["enable", "loft-shell-helper@chat.loft"])
        .output()
    {
        Ok(output) if output.status.success() => {
            tracing::info!("Enabled GNOME Shell extension loft-shell-helper@chat.loft");
        }
        Ok(output) => {
            tracing::warn!(
                "gnome-extensions enable failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Err(e) => {
            tracing::warn!("gnome-extensions not available ({}), extension may need manual enable", e);
        }
    }

    Ok(())
}

// ============================================================
// Icon fetching
// ============================================================

/// Download all service icons (app + tray) if they are not already present.
/// Call this once on manager startup so icons are available before any install.
pub fn ensure_icons() {
    for definition in crate::service::ALL_SERVICES {
        if let Err(e) = ensure_icons_for(definition) {
            tracing::warn!(
                "Failed to fetch icons for {}: {}",
                definition.display_name,
                e
            );
        }
    }
}

/// Download app icon and tray icon for a single service (skips if already present).
fn ensure_icons_for(definition: &ServiceDefinition) -> Result<()> {
    fetch_app_icon(definition)?;
    install_app_icon_to_theme(definition)?;
    fetch_tray_icon(definition)?;
    Ok(())
}

/// Download the application icon (for .desktop files, notifications, manager GUI).
/// SVG files are saved as-is; other formats are decoded and re-saved as PNG.
fn fetch_app_icon(definition: &ServiceDefinition) -> Result<()> {
    let icon_dir = data_dir().join("icons");
    std::fs::create_dir_all(&icon_dir)?;
    let icon_path = icon_dir.join(definition.app_icon_filename);

    if icon_path.exists() {
        tracing::debug!("App icon already exists: {}", icon_path.display());
        return Ok(());
    }

    tracing::info!("Fetching app icon from {}", definition.app_icon_url);
    let bytes = download_url(definition.app_icon_url)?;

    if definition.app_icon_url.ends_with(".svg") {
        std::fs::write(&icon_path, &bytes)
            .with_context(|| format!("Failed to save SVG icon to {}", icon_path.display()))?;
    } else {
        let img = image::load_from_memory(&bytes).context("Failed to decode icon image")?;
        img.save_with_format(&icon_path, image::ImageFormat::Png)
            .with_context(|| format!("Failed to save icon to {}", icon_path.display()))?;
    }

    tracing::debug!("Saved app icon to {}", icon_path.display());
    Ok(())
}

/// Install the app icon into the XDG icon theme so .desktop files and autostart
/// entries can reference it by name (e.g. `loft-whatsapp`) rather than by path.
///
/// Copies from `~/.local/share/loft/icons/<file>` to
/// `~/.local/share/icons/hicolor/scalable/apps/loft-<name>.svg` (or 48x48 PNG).
fn install_app_icon_to_theme(definition: &ServiceDefinition) -> Result<()> {
    let icon_name = definition.app_icon_name();
    let icons_base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("icons/hicolor");

    let is_svg = definition.app_icon_filename.ends_with(".svg");
    let dest = if is_svg {
        icons_base
            .join("scalable/apps")
            .join(format!("{}.svg", icon_name))
    } else {
        icons_base
            .join("48x48/apps")
            .join(format!("{}.png", icon_name))
    };

    if dest.exists() {
        return Ok(());
    }

    let src = data_dir().join("icons").join(definition.app_icon_filename);
    if !src.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(dest.parent().unwrap())?;
    std::fs::copy(&src, &dest)
        .with_context(|| format!("Failed to install app icon to {}", dest.display()))?;

    tracing::debug!("Installed app icon to theme: {}", dest.display());
    Ok(())
}

/// Download the tray icon and install it into the XDG icon theme so the desktop
/// environment can resolve it by name via the SNI `IconName` property.
///
/// SVG icons go to `~/.local/share/icons/hicolor/scalable/apps/loft-<name>.svg`.
/// Non-SVG icons are decoded and saved as PNG to `~/.local/share/icons/hicolor/48x48/apps/`.
fn fetch_tray_icon(definition: &ServiceDefinition) -> Result<()> {
    let tray_icon_name = definition.tray_icon_name();
    let icons_base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("icons/hicolor");

    let is_svg = definition.tray_icon_url.ends_with(".svg");
    let dest = if is_svg {
        icons_base
            .join("scalable/apps")
            .join(format!("{}.svg", tray_icon_name))
    } else {
        icons_base
            .join("48x48/apps")
            .join(format!("{}.png", tray_icon_name))
    };

    if dest.exists() {
        tracing::debug!("Tray icon already exists: {}", dest.display());
        return Ok(());
    }

    tracing::info!("Fetching tray icon from {}", definition.tray_icon_url);
    let bytes = download_url(definition.tray_icon_url)?;

    std::fs::create_dir_all(dest.parent().unwrap())?;

    if is_svg {
        std::fs::write(&dest, &bytes)
            .with_context(|| format!("Failed to save tray icon to {}", dest.display()))?;
    } else {
        let img = image::load_from_memory(&bytes).context("Failed to decode tray icon")?;
        img.save_with_format(&dest, image::ImageFormat::Png)
            .with_context(|| format!("Failed to save tray icon to {}", dest.display()))?;
    }

    tracing::debug!("Installed tray icon to {}", dest.display());
    Ok(())
}

/// Remove icons from the XDG icon theme directory (both app and tray).
fn remove_icons_from_theme(definition: &ServiceDefinition) {
    let icons_base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("icons/hicolor");

    // Remove both app icon and tray icon from theme
    for name in [definition.app_icon_name(), definition.tray_icon_name()] {
        let svg_path = icons_base
            .join("scalable/apps")
            .join(format!("{}.svg", name));
        let png_path = icons_base
            .join("48x48/apps")
            .join(format!("{}.png", name));

        let _ = std::fs::remove_file(&svg_path);
        let _ = std::fs::remove_file(&png_path);
    }
}

fn download_url(url: &str) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("Loft/1.0")
        .build()
        .context("Failed to build HTTP client")?;
    let response = client
        .get(url)
        .send()
        .with_context(|| format!("Failed to fetch {}", url))?;
    let bytes = response
        .bytes()
        .with_context(|| format!("Failed to read response body from {}", url))?;
    Ok(bytes.to_vec())
}

// ============================================================
// Native messaging host manifest
// ============================================================

fn setup_nm_host() -> Result<()> {
    let loft_binary = std::env::current_exe().context("Could not determine loft binary path")?;
    let origin = format!("chrome-extension://{}/", EXTENSION_ID);

    // Chrome launches the NM host binary directly without arguments, so we need
    // a wrapper script that passes --native-messaging to the loft binary.
    let wrapper_path = data_dir().join("nm-host.sh");
    std::fs::create_dir_all(wrapper_path.parent().unwrap())?;
    let wrapper_content = format!(
        "#!/bin/sh\nexec \"{}\" --native-messaging \"$@\"\n",
        loft_binary.display()
    );
    std::fs::write(&wrapper_path, &wrapper_content)
        .with_context(|| format!("Failed to write NM wrapper {}", wrapper_path.display()))?;

    // Make the wrapper executable
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper_path, std::fs::Permissions::from_mode(0o755))?;
    }

    let manifest = serde_json::json!({
        "name": "chat.loft.host",
        "description": "Loft desktop integration native messaging host",
        "path": wrapper_path.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [origin]
    });

    let content = serde_json::to_string_pretty(&manifest)?;

    // Install into default Chrome config location
    let path = nm_host_manifest_path();
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, &content)
        .with_context(|| format!("Failed to write NM host manifest {}", path.display()))?;
    tracing::debug!("Created NM host manifest: {}", path.display());

    // Also install into each service's --user-data-dir, since Chrome with a
    // custom --user-data-dir does NOT look in the default config location.
    for svc in crate::service::ALL_SERVICES {
        let profile_nm_dir = crate::chrome::profile_path(svc.name)
            .join("NativeMessagingHosts");
        std::fs::create_dir_all(&profile_nm_dir)?;
        let profile_nm_path = profile_nm_dir.join("chat.loft.host.json");
        std::fs::write(&profile_nm_path, &content)
            .with_context(|| format!("Failed to write NM manifest {}", profile_nm_path.display()))?;
        tracing::debug!("Created per-profile NM manifest: {}", profile_nm_path.display());
    }

    tracing::debug!("Created NM wrapper script: {}", wrapper_path.display());
    Ok(())
}

fn remove_nm_host() -> Result<()> {
    let path = nm_host_manifest_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
        tracing::debug!("Removed NM host manifest: {}", path.display());
    }
    let wrapper = data_dir().join("nm-host.sh");
    if wrapper.exists() {
        let _ = std::fs::remove_file(&wrapper);
    }
    Ok(())
}

fn any_service_installed() -> bool {
    crate::service::ALL_SERVICES
        .iter()
        .any(|s| is_service_installed(s))
}

// ============================================================
// Autostart
// ============================================================

pub fn set_autostart(definition: &ServiceDefinition, enabled: bool) -> Result<()> {
    let autostart_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("~/.config"))
        .join("autostart");
    let path = autostart_dir.join(format!("loft-{}.desktop", definition.name));

    if enabled {
        std::fs::create_dir_all(&autostart_dir)?;
        let loft_binary =
            std::env::current_exe().context("Could not determine loft binary path")?;
        let content = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={name}\n\
             Comment={name} (Loft)\n\
             Exec={exec} --service {service} --minimized\n\
             Icon={icon}\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n",
            name = definition.display_name,
            exec = loft_binary.display(),
            service = definition.name,
            icon = definition.app_icon_name(),
        );
        std::fs::write(&path, content)?;
        tracing::debug!("Enabled autostart: {}", path.display());
    } else if path.exists() {
        std::fs::remove_file(&path)?;
        tracing::debug!("Disabled autostart: {}", path.display());
    }

    Ok(())
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::WHATSAPP;

    #[test]
    fn test_desktop_entry_path() {
        let path = desktop_entry_path(&WHATSAPP);
        assert!(path.to_string_lossy().contains("loft-whatsapp.desktop"));
    }

    #[test]
    fn test_nm_host_manifest_path() {
        let path = nm_host_manifest_path();
        assert!(path
            .to_string_lossy()
            .contains("NativeMessagingHosts/chat.loft.host.json"));
    }

    #[test]
    fn test_is_service_installed_false() {
        // Not installed by default
        assert!(!is_service_installed(&WHATSAPP));
    }
}
