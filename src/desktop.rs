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
    deploy_service_icons(definition)?;
    ensure_combined_icon()?;
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

    // Remove autostart entry
    let _ = set_autostart(definition, false, false);

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

/// Return the host XDG data directory, bypassing Flatpak's remapping.
/// Inside a Flatpak, `dirs::data_dir()` returns `~/.var/app/<id>/data/`,
/// but .desktop files, icons, and GNOME Shell extensions must go to
/// `~/.local/share/` for the host desktop to find them.
fn host_data_dir() -> PathBuf {
    if crate::chrome::is_flatpak() {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(".local/share")
    } else {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from("~/.local/share"))
    }
}

/// Return the host XDG config directory, bypassing Flatpak's remapping.
fn host_config_dir() -> PathBuf {
    if crate::chrome::is_flatpak() {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("~"))
            .join(".config")
    } else {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from("~/.config"))
    }
}

/// Loft's own data directory (icons, extension, profiles, logs).
/// This can stay in the sandbox — only Loft and Chrome (via explicit
/// filesystem access) need it.
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
    host_data_dir()
        .join("applications")
        .join(format!("loft-{}.desktop", definition.name))
}

fn nm_host_manifest_path() -> PathBuf {
    host_config_dir()
        .join("google-chrome/NativeMessagingHosts/chat.loft.host.json")
}

// ============================================================
// .desktop file management
// ============================================================

/// Return the Icon= value for .desktop files.
/// Uses the absolute path if the icon file exists, otherwise falls back
/// to the XDG theme name (e.g. `loft-whatsapp`).
fn desktop_icon(definition: &ServiceDefinition) -> String {
    let icon_path = data_dir().join("icons").join(definition.app_icon_filename);
    if icon_path.exists() {
        icon_path.display().to_string()
    } else {
        definition.app_icon_name()
    }
}

/// Return the Exec= prefix for .desktop files.
/// Inside Flatpak: `flatpak run chat.loft.Loft`
/// Native: the path to the current binary.
fn desktop_exec() -> Result<String> {
    if crate::chrome::is_flatpak() {
        Ok("flatpak run chat.loft.Loft".to_string())
    } else {
        let binary = std::env::current_exe().context("Could not determine loft binary path")?;
        Ok(binary.display().to_string())
    }
}

fn create_desktop_entry(definition: &ServiceDefinition) -> Result<()> {
    let exec = desktop_exec()?;
    let icon = desktop_icon(definition);

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
        exec = exec,
        service = definition.name,
        icon = icon,
    );

    let path = desktop_entry_path(definition);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, content)
        .with_context(|| format!("Failed to write {}", path.display()))?;

    tracing::debug!("Created .desktop file: {}", path.display());
    Ok(())
}

/// Install the manager's own .desktop file so GNOME can associate the
/// running app window with an icon in the dock/overview.
/// The file is named after the GTK application ID (`chat.loft.Manager.desktop`).
pub fn ensure_manager_desktop_entry() -> Result<()> {
    // Flatpak already exports its own chat.loft.Loft.desktop — skip to avoid duplicates.
    if crate::chrome::is_flatpak() {
        return Ok(());
    }

    let apps_dir = host_data_dir().join("applications");
    let path = apps_dir.join("chat.loft.Manager.desktop");

    if path.exists() {
        return Ok(());
    }

    std::fs::create_dir_all(&apps_dir)?;
    let exec = desktop_exec()?;

    let content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Loft\n\
         Comment=Manage Loft web app services\n\
         Exec={exec}\n\
         Icon=loft\n\
         Terminal=false\n\
         Categories=Network;InstantMessaging;\n\
         StartupWMClass=loft\n",
        exec = exec,
    );

    std::fs::write(&path, &content)
        .with_context(|| format!("Failed to write {}", path.display()))?;
    tracing::debug!("Installed manager .desktop file: {}", path.display());
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
    host_data_dir()
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
    let exec = desktop_exec()?;
    let icon = desktop_icon(definition);

    let content = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name={name}\n\
         Exec={exec} --service {service}\n\
         Icon={icon}\n\
         NoDisplay=true\n",
        name = definition.display_name,
        exec = exec,
        service = definition.name,
        icon = icon,
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
pub fn deploy_extension() -> Result<()> {
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

/// Deploy the GNOME Shell extension to ~/.local/share/gnome-shell/extensions/loft-shell-helper@loft.chat/.
fn deploy_gnome_shell_extension() -> Result<()> {
    let ext_dir = host_data_dir()
        .join("gnome-shell/extensions/loft-shell-helper@loft.chat");
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

    // Deploy icon files used by the combined tray menu
    let icons_dir = ext_dir.join("icons");
    std::fs::create_dir_all(&icons_dir)
        .with_context(|| format!("Failed to create GNOME Shell extension icons dir {}", icons_dir.display()))?;

    let icons: &[(&str, &str)] = &[
        ("show-window-symbolic.svg", include_str!("../gnome-shell-extension/icons/show-window-symbolic.svg")),
        ("hide-window-symbolic.svg", include_str!("../gnome-shell-extension/icons/hide-window-symbolic.svg")),
    ];

    for (name, content) in icons {
        std::fs::write(icons_dir.join(name), content)
            .with_context(|| format!("Failed to write GNOME Shell extension icon {}", name))?;
    }

    tracing::debug!("Deployed GNOME Shell extension to {}", ext_dir.display());

    // Best-effort: enable the extension (requires gnome-extensions CLI on the host)
    match crate::chrome::host_command("gnome-extensions")
        .args(["enable", "loft-shell-helper@loft.chat"])
        .output()
    {
        Ok(output) if output.status.success() => {
            tracing::info!("Enabled GNOME Shell extension loft-shell-helper@loft.chat");
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
// Icon deployment (from embedded assets)
// ============================================================

/// Deploy all service icons from embedded assets to disk.
/// Call this once on manager startup so icons are available before any install.
pub fn ensure_icons() {
    for definition in crate::service::ALL_SERVICES {
        if let Err(e) = deploy_service_icons(definition) {
            tracing::warn!(
                "Failed to deploy icons for {}: {}",
                definition.display_name,
                e
            );
        }
    }
}

/// Deploy all icons for a single service from embedded assets.
/// Writes the app icon SVG + PNG to the Loft data dir, and installs
/// both the app icon and tray icon into the XDG icon theme.
fn deploy_service_icons(definition: &ServiceDefinition) -> Result<()> {
    // App icon SVG → ~/.local/share/loft/icons/<name>.svg
    let icon_dir = data_dir().join("icons");
    std::fs::create_dir_all(&icon_dir)?;

    let svg_path = icon_dir.join(definition.app_icon_filename);
    if !svg_path.exists() {
        std::fs::write(&svg_path, definition.app_icon_svg)
            .with_context(|| format!("Failed to write {}", svg_path.display()))?;
    }

    // App icon PNG → ~/.local/share/loft/icons/<name>.png (for SNI tray pixmaps)
    let png_filename = definition.app_icon_filename.replace(".svg", ".png");
    let png_path = icon_dir.join(&png_filename);
    if !png_path.exists() {
        std::fs::write(&png_path, definition.app_icon_png)
            .with_context(|| format!("Failed to write {}", png_path.display()))?;
    }

    // App icon → XDG icon theme (scalable/apps/loft-<name>.svg)
    let icons_base = host_data_dir().join("icons/hicolor");
    let theme_dest = icons_base
        .join("scalable/apps")
        .join(format!("{}.svg", definition.app_icon_name()));
    if !theme_dest.exists() {
        std::fs::create_dir_all(theme_dest.parent().unwrap())?;
        std::fs::write(&theme_dest, definition.app_icon_svg)
            .with_context(|| format!("Failed to write {}", theme_dest.display()))?;
    }

    // Tray icon → XDG icon theme (scalable/apps/loft-<name>-symbolic.svg)
    let tray_dest = icons_base
        .join("scalable/apps")
        .join(format!("loft-{}-symbolic.svg", definition.name));
    if !tray_dest.exists() {
        std::fs::create_dir_all(tray_dest.parent().unwrap())?;
        std::fs::write(&tray_dest, definition.tray_icon_svg)
            .with_context(|| format!("Failed to write {}", tray_dest.display()))?;
    }

    Ok(())
}

/// Remove icons from the XDG icon theme directory (both app and tray).
fn remove_icons_from_theme(definition: &ServiceDefinition) {
    let icons_base = host_data_dir().join("icons/hicolor/scalable/apps");

    let app_icon = icons_base.join(format!("{}.svg", definition.app_icon_name()));
    let tray_icon = icons_base.join(format!("loft-{}-symbolic.svg", definition.name));

    let _ = std::fs::remove_file(&app_icon);
    let _ = std::fs::remove_file(&tray_icon);
}

/// Install the combined Loft icon into the XDG icon theme so the combined
/// tray icon can be resolved by name (`loft-symbolic`).
///
/// Embeds `loft-symbolic.svg` and `loft.svg` from `assets/icons/` at compile time
/// and writes them to `~/.local/share/icons/hicolor/scalable/apps/`.
pub fn ensure_combined_icon() -> Result<()> {
    let icons_base = host_data_dir().join("icons/hicolor/scalable/apps");
    std::fs::create_dir_all(&icons_base)?;

    let symbolic_dest = icons_base.join("loft-symbolic.svg");
    if !symbolic_dest.exists() {
        std::fs::write(&symbolic_dest, include_str!("../assets/icons/loft-symbolic.svg"))
            .with_context(|| format!("Failed to write {}", symbolic_dest.display()))?;
        tracing::debug!("Installed loft-symbolic icon to {}", symbolic_dest.display());
    }

    let app_dest = icons_base.join("loft.svg");
    if !app_dest.exists() {
        std::fs::write(&app_dest, include_str!("../assets/icons/loft.svg"))
            .with_context(|| format!("Failed to write {}", app_dest.display()))?;
        tracing::debug!("Installed loft icon to {}", app_dest.display());
    }

    // Also install the PNG version for SNI pixmap (KDE/non-GNOME).
    let png_dir = data_dir().join("icons");
    std::fs::create_dir_all(&png_dir)?;
    let png_dest = png_dir.join("loft.png");
    if !png_dest.exists() {
        std::fs::write(&png_dest, include_bytes!("../assets/icons/loft.png"))
            .with_context(|| format!("Failed to write {}", png_dest.display()))?;
        tracing::debug!("Installed loft PNG icon to {}", png_dest.display());
    }

    // Install show/hide window icons for tray menu items.
    // These must go into the active icon theme's actions directory (not hicolor/apps)
    // for KDE's KIconLoader to apply color scheme recoloring.
    install_action_icon("loft-show-window-symbolic",
        include_str!("../gnome-shell-extension/icons/show-window-symbolic.svg"))?;
    install_action_icon("loft-hide-window-symbolic",
        include_str!("../gnome-shell-extension/icons/hide-window-symbolic.svg"))?;

    Ok(())
}

/// Install an SVG icon into both breeze and breeze-dark action icon directories
/// so KDE's KIconLoader applies color scheme recoloring.
fn install_action_icon(name: &str, svg_content: &str) -> Result<()> {
    let system_themes = PathBuf::from("/usr/share/icons");
    let user_themes = host_data_dir().join("icons");

    // Install into user's local icon directories for each theme that exists
    for theme in &["breeze", "breeze-dark", "hicolor"] {
        // Check if the theme exists (either system or user)
        let theme_exists = system_themes.join(theme).exists()
            || user_themes.join(theme).exists();
        if !theme_exists {
            continue;
        }

        let dir = if *theme == "hicolor" {
            user_themes.join(format!("{}/scalable/actions", theme))
        } else {
            user_themes.join(format!("{}/actions/16", theme))
        };
        std::fs::create_dir_all(&dir)?;

        let dest = dir.join(format!("{}.svg", name));
        if !dest.exists() {
            std::fs::write(&dest, svg_content)
                .with_context(|| format!("Failed to write {}", dest.display()))?;
            tracing::debug!("Installed action icon to {}", dest.display());
        }
    }

    Ok(())
}

// ============================================================
// Native messaging host manifest
// ============================================================

pub fn setup_nm_host() -> Result<()> {
    let origin = format!("chrome-extension://{}/", EXTENSION_ID);

    // Chrome launches the NM host binary directly without arguments, so we need
    // a wrapper script that passes --native-messaging to the loft binary.
    let wrapper_path = data_dir().join("nm-host.sh");
    std::fs::create_dir_all(wrapper_path.parent().unwrap())?;

    // The wrapper runs on the HOST (Chrome launches it). When Loft is a Flatpak,
    // use `flatpak run` to enter the sandbox; otherwise exec the binary directly.
    let wrapper_content = if crate::chrome::is_flatpak() {
        "#!/bin/sh\nexec flatpak run chat.loft.Loft --native-messaging \"$@\"\n".to_string()
    } else {
        let loft_binary = std::env::current_exe().context("Could not determine loft binary path")?;
        format!(
            "#!/bin/sh\nexec \"{}\" --native-messaging \"$@\"\n",
            loft_binary.display()
        )
    };
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

pub fn set_autostart(definition: &ServiceDefinition, enabled: bool, start_hidden: bool) -> Result<()> {
    let autostart_dir = host_config_dir().join("autostart");
    let path = autostart_dir.join(format!("loft-{}.desktop", definition.name));

    if enabled {
        std::fs::create_dir_all(&autostart_dir)?;
        let exec = desktop_exec()?;
        let minimized_flag = if start_hidden { " --minimized" } else { "" };
        let content = format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={name}\n\
             Comment={name} (Loft)\n\
             Exec={exec} --service {service}{minimized}\n\
             Icon={icon}\n\
             Terminal=false\n\
             X-GNOME-Autostart-enabled=true\n",
            name = definition.display_name,
            exec = exec,
            service = definition.name,
            minimized = minimized_flag,
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
