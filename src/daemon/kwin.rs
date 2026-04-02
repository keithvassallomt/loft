use anyhow::{Context, Result};
use zbus::Connection;

/// Focus (show) a window by its WM class via KWin scripting.
/// Restores skipTaskbar, unminimizes, and activates.
pub async fn focus_window(wm_class: &str) -> Result<bool> {
    let script = format!(
        r#"var windows = workspace.windowList();
for (var i = 0; i < windows.length; i++) {{
    var w = windows[i];
    if (w.resourceClass === "{}") {{
        w.skipTaskbar = false;
        w.minimized = false;
        workspace.activeWindow = w;
        break;
    }}
}}"#,
        wm_class
    );
    run_kwin_script(&script, "loft-show").await
}

/// Hide a window by its WM class via KWin scripting.
/// Sets skipTaskbar and minimizes so it disappears from both screen and taskbar.
pub async fn hide_window(wm_class: &str) -> Result<bool> {
    let script = format!(
        r#"var windows = workspace.windowList();
for (var i = 0; i < windows.length; i++) {{
    var w = windows[i];
    if (w.resourceClass === "{}") {{
        w.skipTaskbar = true;
        w.minimized = true;
        break;
    }}
}}"#,
        wm_class
    );
    run_kwin_script(&script, "loft-hide").await
}

/// Write a JS script to a temp file, load it into KWin, run it, and clean up.
async fn run_kwin_script(script_js: &str, plugin_name: &str) -> Result<bool> {
    // Write script to a temp file
    let script_path = format!("/tmp/{}.js", plugin_name);
    std::fs::write(&script_path, script_js)
        .context("failed to write KWin script")?;

    let conn = Connection::session().await
        .context("failed to connect to session D-Bus")?;

    // Unload any previous instance of this plugin
    let _ = conn
        .call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "unloadScript",
            &(plugin_name,),
        )
        .await;

    // Load the script
    let reply = conn
        .call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "loadScript",
            &(&script_path, plugin_name),
        )
        .await
        .context("failed to load KWin script")?;

    let script_id: i32 = reply.body().deserialize()
        .context("failed to parse script ID")?;

    // Run the script
    let script_obj_path = format!("/Scripting/Script{}", script_id);
    let script_obj_path = zbus::zvariant::ObjectPath::try_from(script_obj_path.as_str())
        .context("invalid script object path")?;
    conn.call_method(
        Some("org.kde.KWin"),
        &script_obj_path,
        Some("org.kde.kwin.Script"),
        "run",
        &(),
    )
    .await
    .context("failed to run KWin script")?;

    // Brief delay to let the script execute
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // Unload
    let _ = conn
        .call_method(
            Some("org.kde.KWin"),
            "/Scripting",
            Some("org.kde.kwin.Scripting"),
            "unloadScript",
            &(plugin_name,),
        )
        .await;

    // Clean up temp file
    let _ = std::fs::remove_file(&script_path);

    Ok(true)
}
