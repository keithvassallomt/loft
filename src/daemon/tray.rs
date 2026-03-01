use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use ksni::menu::{CheckmarkItem, StandardItem};
use ksni::{Handle, Icon, MenuItem, Tray, TrayMethods};

use super::DaemonState;

pub struct LoftTray {
    pub service_name: String,
    pub display_name: String,
    pub badge_count: u32,
    pub visible: bool,
    pub dnd: bool,
    /// XDG icon theme name (e.g. "loft-whatsapp") used via the SNI `IconName` property.
    pub tray_icon_name: String,
    /// Fallback ARGB pixmap data for DEs that don't resolve the icon name.
    pub icon_data: Vec<Icon>,
    pub state: Arc<DaemonState>,
}

impl LoftTray {
    pub fn new(
        service_name: String,
        display_name: String,
        dnd: bool,
        tray_icon_name: String,
        icon_path: &PathBuf,
        state: Arc<DaemonState>,
    ) -> Self {
        let icon_data = load_icon(icon_path);
        Self {
            service_name,
            display_name,
            badge_count: 0,
            visible: false,
            dnd,
            tray_icon_name,
            icon_data,
            state,
        }
    }
}

impl Tray for LoftTray {
    fn id(&self) -> String {
        format!("loft-{}", self.service_name)
    }

    fn icon_name(&self) -> String {
        self.tray_icon_name.clone()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::Communications
    }

    fn title(&self) -> String {
        if self.badge_count > 0 {
            format!("{} ({})", self.display_name, self.badge_count)
        } else {
            self.display_name.clone()
        }
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        self.icon_data.clone()
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        // Left-click: toggle visibility
        if self.visible {
            self.visible = false;
            self.state.request_hide();
        } else {
            self.visible = true;
            self.state.request_show();
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let show_hide_label = if self.visible { "Hide" } else { "Show" };
        vec![
            StandardItem {
                label: show_hide_label.to_string(),
                activate: Box::new(|tray: &mut LoftTray| {
                    if tray.visible {
                        tray.visible = false;
                        tray.state.request_hide();
                    } else {
                        tray.visible = true;
                        tray.state.request_show();
                    }
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            CheckmarkItem {
                label: "Do Not Disturb".to_string(),
                checked: self.dnd,
                activate: Box::new(|tray: &mut LoftTray| {
                    let new_dnd = !tray.dnd;
                    tray.dnd = new_dnd;
                    tray.state.dnd.store(new_dnd, Ordering::Relaxed);
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit".to_string(),
                icon_name: "application-exit".to_string(),
                activate: Box::new(|tray: &mut LoftTray| {
                    tray.state.request_quit();
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}

/// Load a PNG/ICO file and convert to ARGB32 for the tray icon.
fn load_icon(path: &PathBuf) -> Vec<Icon> {
    match std::fs::read(path) {
        Ok(data) => match image::load_from_memory(&data) {
            Ok(img) => {
                let rgba = img.to_rgba8();
                let (w, h) = (rgba.width(), rgba.height());
                let mut argb_data = rgba.into_raw();
                // Convert RGBA to ARGB (rotate each pixel's bytes right by 1)
                for pixel in argb_data.chunks_exact_mut(4) {
                    pixel.rotate_right(1);
                }
                vec![Icon {
                    width: w as i32,
                    height: h as i32,
                    data: argb_data,
                }]
            }
            Err(e) => {
                tracing::warn!("Failed to decode icon {}: {}", path.display(), e);
                vec![]
            }
        },
        Err(e) => {
            tracing::warn!("Failed to read icon {}: {}", path.display(), e);
            vec![]
        }
    }
}

/// Run the tray icon lifecycle: spawn with retry, sync state, and respawn
/// when signalled (e.g. after suspend/resume) or when duplicate registrations
/// are detected (caused by ksni auto-re-registering with the SNI watcher).
///
/// This function runs forever (or until the tray cannot be spawned after retries).
pub async fn run_tray_lifecycle(
    state: Arc<DaemonState>,
    service_name: String,
    display_name: String,
    tray_icon_name: String,
    icon_path: PathBuf,
    respawn: Arc<tokio::sync::Notify>,
) {
    let retry_delays = [0u64, 2, 4, 8, 16];
    let pid = std::process::id();

    loop {
        // Spawn tray with retry backoff
        let mut handle: Option<Handle<LoftTray>> = None;
        for (attempt, &delay_secs) in retry_delays.iter().enumerate() {
            if delay_secs > 0 {
                tracing::info!(
                    "Tray icon unavailable, retrying in {}s (attempt {}/{})",
                    delay_secs,
                    attempt + 1,
                    retry_delays.len()
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }
            let tray = LoftTray::new(
                service_name.clone(),
                display_name.clone(),
                state.is_dnd(),
                tray_icon_name.clone(),
                &icon_path,
                Arc::clone(&state),
            );
            match tray.spawn().await {
                Ok(h) => {
                    handle = Some(h);
                    break;
                }
                Err(e) => {
                    if attempt == retry_delays.len() - 1 {
                        tracing::error!(
                            "Failed to spawn tray icon after {} attempts: {:?}",
                            retry_delays.len(),
                            e
                        );
                        return;
                    }
                    tracing::warn!("Tray icon spawn failed: {:?}", e);
                }
            }
        }

        let handle = handle.unwrap();
        let spawn_time = std::time::Instant::now();
        tracing::info!("Tray icon spawned for {}", display_name);

        // Sync loop: push DaemonState → tray every 500ms, break on respawn signal
        // or when duplicate SNI registrations are detected.
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        let mut should_respawn = false;
        let mut dup_check_interval = tokio::time::interval(std::time::Duration::from_secs(10));

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let badge = state.badge_count.load(Ordering::Relaxed);
                    let visible = state.visible.load(Ordering::Relaxed);
                    let dnd = state.dnd.load(Ordering::Relaxed);

                    let result = handle.update(|tray: &mut LoftTray| {
                        tray.badge_count = badge;
                        tray.visible = visible;
                        tray.dnd = dnd;
                    }).await;

                    if result.is_none() {
                        tracing::warn!("Tray handle closed unexpectedly, respawning");
                        break;
                    }
                }
                _ = dup_check_interval.tick() => {
                    // Skip checks in the first 15s — let things settle after spawn
                    if spawn_time.elapsed() < std::time::Duration::from_secs(15) {
                        continue;
                    }
                    if has_duplicate_registration(pid).await {
                        tracing::info!("Duplicate SNI registration detected, respawning tray icon");
                        should_respawn = true;
                        break;
                    }
                }
                _ = respawn.notified() => {
                    should_respawn = true;
                    break;
                }
            }
        }

        if !should_respawn {
            // Tray died on its own — respawn immediately (outer loop)
            continue;
        }

        // Clean shutdown before respawn
        tracing::info!("Shutting down tray icon for respawn");
        handle.shutdown().await;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// Check the StatusNotifierWatcher for duplicate registrations from this process.
/// Returns true if more than one item is registered for our PID.
async fn has_duplicate_registration(pid: u32) -> bool {
    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(_) => return false,
    };

    // Query RegisteredStatusNotifierItems property
    let reply = conn
        .call_method(
            Some("org.kde.StatusNotifierWatcher"),
            "/StatusNotifierWatcher",
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &("org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"),
        )
        .await;

    let reply = match reply {
        Ok(r) => r,
        Err(_) => return false,
    };

    let items: Vec<String> = match reply.body().deserialize::<(zbus::zvariant::Value,)>() {
        Ok((zbus::zvariant::Value::Array(arr),)) => arr
            .iter()
            .filter_map(|v| {
                if let zbus::zvariant::Value::Str(s) = v {
                    Some(s.to_string())
                } else {
                    None
                }
            })
            .collect(),
        _ => return false,
    };

    // Count items that belong to our PID:
    // - Well-known name format: "org.kde.StatusNotifierItem-{pid}-{N}/..."
    // - Unique name format: ":{N}.{M}/..." — resolve via GetConnectionUnixProcessID
    let pid_prefix = format!("org.kde.StatusNotifierItem-{}-", pid);
    let mut our_count = 0usize;

    for item in &items {
        if item.starts_with(&pid_prefix) {
            our_count += 1;
            continue;
        }
        // Check unique-name entries: extract bus name before the first '/'
        if let Some(bus_name) = item.split('/').next() {
            if bus_name.starts_with(':') {
                let owner_pid = conn
                    .call_method(
                        Some("org.freedesktop.DBus"),
                        "/org/freedesktop/DBus",
                        Some("org.freedesktop.DBus"),
                        "GetConnectionUnixProcessID",
                        &(bus_name,),
                    )
                    .await;
                if let Ok(reply) = owner_pid {
                    if let Ok((p,)) = reply.body().deserialize::<(u32,)>() {
                        if p == pid {
                            our_count += 1;
                        }
                    }
                }
            }
        }
    }

    our_count > 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_state() -> Arc<DaemonState> {
        Arc::new(DaemonState::new(false, false, true))
    }

    #[test]
    fn test_title_no_badge() {
        let tray = LoftTray {
            service_name: "whatsapp".to_string(),
            display_name: "WhatsApp".to_string(),
            badge_count: 0,
            visible: false,
            dnd: false,
            tray_icon_name: String::new(),
            icon_data: vec![],
            state: make_test_state(),
        };
        assert_eq!(tray.title(), "WhatsApp");
    }

    #[test]
    fn test_title_with_badge() {
        let tray = LoftTray {
            service_name: "whatsapp".to_string(),
            display_name: "WhatsApp".to_string(),
            badge_count: 3,
            visible: false,
            dnd: false,
            tray_icon_name: String::new(),
            icon_data: vec![],
            state: make_test_state(),
        };
        assert_eq!(tray.title(), "WhatsApp (3)");
    }

    #[test]
    fn test_id() {
        let tray = LoftTray {
            service_name: "messenger".to_string(),
            display_name: "Messenger".to_string(),
            badge_count: 0,
            visible: false,
            dnd: false,
            tray_icon_name: String::new(),
            icon_data: vec![],
            state: make_test_state(),
        };
        assert_eq!(tray.id(), "loft-messenger");
    }

    #[test]
    fn test_menu_item_count() {
        let tray = LoftTray {
            service_name: "whatsapp".to_string(),
            display_name: "WhatsApp".to_string(),
            badge_count: 0,
            visible: false,
            dnd: false,
            tray_icon_name: String::new(),
            icon_data: vec![],
            state: make_test_state(),
        };
        let menu = tray.menu();
        // Show/Hide, Sep, DND, Sep, Quit
        assert_eq!(menu.len(), 5);
    }

    #[test]
    fn test_category() {
        let tray = LoftTray {
            service_name: "whatsapp".to_string(),
            display_name: "WhatsApp".to_string(),
            badge_count: 0,
            visible: false,
            dnd: false,
            tray_icon_name: String::new(),
            icon_data: vec![],
            state: make_test_state(),
        };
        assert_eq!(tray.category(), ksni::Category::Communications);
    }
}
