use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use ksni::menu::{CheckmarkItem, StandardItem};
use ksni::{Handle, Icon, MenuItem, Tray, TrayMethods};

use super::{messaging, DaemonState};
use crate::config::ServiceConfig;

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

    fn icon_theme_path(&self) -> String {
        dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("~/.local/share"))
            .join("icons")
            .to_string_lossy()
            .to_string()
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

    fn overlay_icon_pixmap(&self) -> Vec<Icon> {
        let has_badge = self.badge_count > 0;
        let has_dnd = self.dnd;
        // DND suppresses the badge indicator — the dash replaces it
        if has_dnd {
            vec![generate_dnd_dash_overlay()]
        } else if has_badge {
            vec![generate_red_dot_overlay()]
        } else {
            vec![]
        }
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
                    let _ = tray.state.cmd_tx.send(messaging::DaemonMessage::DndChanged {
                        enabled: new_dnd,
                    });
                    // Persist to config
                    if let Ok(mut config) = ServiceConfig::load(&tray.service_name) {
                        config.do_not_disturb = new_dnd;
                        if let Err(e) = config.save(&tray.service_name) {
                            tracing::error!("Failed to save DND config: {}", e);
                        }
                    }
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

/// Load a raster image file and convert to ARGB32 for the tray icon pixmap fallback.
/// SVG files are not supported by the `image` crate — the DE resolves those via
/// the `icon_name` property instead, so a missing pixmap is harmless.
fn load_icon(path: &PathBuf) -> Vec<Icon> {
    // Skip SVG files — they can't be decoded as raster images.
    if path.extension().and_then(|e| e.to_str()) == Some("svg") {
        tracing::debug!("Skipping pixmap for SVG icon {}, relying on icon_name", path.display());
        return vec![];
    }
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

/// Generate a small red dot overlay icon (ARGB32) for the badge indicator.
/// Matches the GNOME panel dot: #e01b24, positioned at bottom-right.
fn generate_red_dot_overlay() -> Icon {
    const SIZE: i32 = 22;
    const DOT_RADIUS: f32 = 3.5;
    // Centre the dot in the bottom-right corner with a small margin
    const DOT_CX: f32 = SIZE as f32 - DOT_RADIUS - 1.0;
    const DOT_CY: f32 = SIZE as f32 - DOT_RADIUS - 1.0;
    // GNOME Adwaita red: #e01b24
    const R: f32 = 0xE0 as f32;
    const G: f32 = 0x1B as f32;
    const B: f32 = 0x24 as f32;

    let mut data = vec![0u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - DOT_CX;
            let dy = y as f32 + 0.5 - DOT_CY;
            let dist = (dx * dx + dy * dy).sqrt();

            // Anti-aliased edge: smooth over a 1px transition band
            let alpha = if dist <= DOT_RADIUS - 0.5 {
                1.0
            } else if dist <= DOT_RADIUS + 0.5 {
                DOT_RADIUS + 0.5 - dist
            } else {
                continue;
            };

            let idx = ((y * SIZE + x) * 4) as usize;
            // ARGB32, network byte order (big-endian): A R G B
            data[idx] = (alpha * 255.0) as u8;
            data[idx + 1] = (alpha * R) as u8;
            data[idx + 2] = (alpha * G) as u8;
            data[idx + 3] = (alpha * B) as u8;
        }
    }

    Icon {
        width: SIZE,
        height: SIZE,
        data,
    }
}

/// Generate a small horizontal dash overlay icon (ARGB32) for DND mode.
/// Grey (#888888), positioned at bottom-right (same corner as the badge dot,
/// which is hidden during DND).
fn generate_dnd_dash_overlay() -> Icon {
    const SIZE: i32 = 22;
    // Dash dimensions and position (bottom-right corner)
    const DASH_W: f32 = 6.0;
    const DASH_H: f32 = 2.0;
    const DASH_X: f32 = SIZE as f32 - DASH_W - 1.0; // right margin
    const DASH_Y: f32 = SIZE as f32 - DASH_H - 2.0; // bottom margin
    // Muted grey: #888888
    const R: f32 = 0x88 as f32;
    const G: f32 = 0x88 as f32;
    const B: f32 = 0x88 as f32;

    let mut data = vec![0u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;

            // Anti-aliased rounded rectangle (pill shape)
            let corner_r = DASH_H / 2.0;
            // Clamp to the straight segment for distance calculation
            let cx = fx.clamp(DASH_X + corner_r, DASH_X + DASH_W - corner_r);
            let cy = DASH_Y + corner_r; // vertical centre
            let dx = fx - cx;
            let dy = fy - cy;
            let dist = (dx * dx + dy * dy).sqrt();

            let alpha = if dist <= corner_r - 0.5 {
                1.0
            } else if dist <= corner_r + 0.5 {
                corner_r + 0.5 - dist
            } else {
                continue;
            };

            let idx = ((y * SIZE + x) * 4) as usize;
            data[idx] = (alpha * 255.0) as u8;
            data[idx + 1] = (alpha * R) as u8;
            data[idx + 2] = (alpha * G) as u8;
            data[idx + 3] = (alpha * B) as u8;
        }
    }

    Icon {
        width: SIZE,
        height: SIZE,
        data,
    }
}

/// Run the tray icon lifecycle: spawn with retry, sync state, and respawn
/// when signalled (e.g. after suspend/resume) or when duplicate registrations
/// are detected (caused by ksni auto-re-registering with the SNI watcher).
///
/// This function runs forever (or until the tray cannot be spawned after retries,
/// or until `stop` is notified).
pub async fn run_tray_lifecycle(
    state: Arc<DaemonState>,
    service_name: String,
    display_name: String,
    tray_icon_name: String,
    icon_path: PathBuf,
    respawn: Arc<tokio::sync::Notify>,
    stop: Arc<tokio::sync::Notify>,
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
        // Only update ksni when state changes, to avoid menu redraws that break hover.
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        let mut should_respawn = false;
        let mut dup_check_interval = tokio::time::interval(std::time::Duration::from_secs(10));
        let mut prev_badge: u32 = u32::MAX; // force first update
        let mut prev_visible = !state.visible.load(Ordering::Relaxed);
        let mut prev_dnd = !state.dnd.load(Ordering::Relaxed);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let raw_badge = state.badge_count.load(Ordering::Relaxed);
                    let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
                    let visible = state.visible.load(Ordering::Relaxed);
                    let dnd = state.dnd.load(Ordering::Relaxed);

                    if badge != prev_badge || visible != prev_visible || dnd != prev_dnd {
                        prev_badge = badge;
                        prev_visible = visible;
                        prev_dnd = dnd;

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
                _ = stop.notified() => {
                    tracing::info!("Tray stop signal received");
                    handle.shutdown().await;
                    return;
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
        Arc::new(DaemonState::new(false, false, true, true, false))
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
