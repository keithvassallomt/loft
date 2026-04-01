use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::Result;
use ksni::menu::{CheckmarkItem, StandardItem, SubMenu};
use ksni::{Handle, Icon, MenuItem, Tray, TrayMethods};

use super::CombinedTrayState;

/// Snapshot of a service's state for building tray menus.
/// We need owned data because ksni callbacks take `&mut Self`.
#[derive(Clone, PartialEq)]
pub(crate) struct ServiceSnapshot {
    pub display_name: String,
    pub dbus_name: String,
    pub visible: bool,
    pub badge_count: u32,
    pub dnd: bool,
}

pub struct CombinedLoftTray {
    pub has_unread: bool,
    pub all_dnd: bool,
    pub services: Vec<ServiceSnapshot>,
    pub tray_icon_name: String,
    pub icon_data: Vec<Icon>,
}

impl Tray for CombinedLoftTray {
    fn id(&self) -> String {
        "loft-combined".to_string()
    }

    fn icon_name(&self) -> String {
        self.tray_icon_name.clone()
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::Communications
    }

    fn title(&self) -> String {
        "Loft".to_string()
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        self.icon_data.clone()
    }

    fn overlay_icon_pixmap(&self) -> Vec<Icon> {
        if self.all_dnd {
            vec![generate_dnd_dash_overlay()]
        } else if self.has_unread {
            vec![generate_red_dot_overlay()]
        } else {
            vec![]
        }
    }

    fn activate(&mut self, _x: i32, _y: i32) {
        // No-op: left-click opens the menu on most SNI hosts
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let mut items: Vec<MenuItem<Self>> = Vec::new();

        for (idx, svc) in self.services.iter().enumerate() {
            if idx > 0 {
                items.push(MenuItem::Separator);
            }

            let dbus_name = svc.dbus_name.clone();
            let show_hide_label = if svc.visible { "Hide" } else { "Show" };

            // Add unread indicator to service name
            let label = if svc.badge_count > 0 && !svc.dnd {
                format!("{} \u{2022}", svc.display_name) // bullet •
            } else {
                svc.display_name.clone()
            };

            items.push(
                SubMenu {
                    label,
                    submenu: vec![
                        StandardItem {
                            label: show_hide_label.to_string(),
                            activate: Box::new({
                                let dbus_name = dbus_name.clone();
                                move |_tray: &mut CombinedLoftTray| {
                                    call_service_method_fire_and_forget(&dbus_name, "Toggle");
                                }
                            }),
                            ..Default::default()
                        }
                        .into(),
                        CheckmarkItem {
                            label: "Do Not Disturb".to_string(),
                            checked: svc.dnd,
                            activate: Box::new({
                                let dbus_name = dbus_name.clone();
                                let current_dnd = svc.dnd;
                                move |_tray: &mut CombinedLoftTray| {
                                    call_service_set_dnd(&dbus_name, !current_dnd);
                                }
                            }),
                            ..Default::default()
                        }
                        .into(),
                        StandardItem {
                            label: "Quit".to_string(),
                            icon_name: "application-exit".to_string(),
                            activate: Box::new({
                                let dbus_name = dbus_name.clone();
                                move |_tray: &mut CombinedLoftTray| {
                                    call_service_method_fire_and_forget(&dbus_name, "Quit");
                                }
                            }),
                            ..Default::default()
                        }
                        .into(),
                    ],
                    ..Default::default()
                }
                .into(),
            );
        }

        if items.is_empty() {
            items.push(
                StandardItem {
                    label: "No services running".to_string(),
                    enabled: false,
                    ..Default::default()
                }
                .into(),
            );
        }

        items
    }
}

/// Map service name → D-Bus name (e.g. "whatsapp" → "WhatsApp").
fn dbus_name_for_service(name: &str) -> String {
    match name {
        "whatsapp" => "WhatsApp".to_string(),
        "messenger" => "Messenger".to_string(),
        _ => name.to_string(),
    }
}

/// Fire-and-forget D-Bus call to a per-service daemon.
fn call_service_method_fire_and_forget(dbus_name: &str, method: &'static str) {
    let bus_name = format!("chat.loft.{}", dbus_name);
    let obj_path = format!("/chat/loft/{}", dbus_name);

    // Spawn a blocking task since we're inside a sync ksni callback
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(rt) = rt {
            let _ = rt.block_on(async {
                let conn = zbus::Connection::session().await?;
                conn.call_method(
                    Some(zbus::names::BusName::try_from(bus_name.as_str())
                        .map_err(|e| anyhow::anyhow!("{}", e))?),
                    zbus::zvariant::ObjectPath::try_from(obj_path.as_str())
                        .map_err(|e| anyhow::anyhow!("{}", e))?,
                    Some(zbus::names::InterfaceName::try_from("chat.loft.Service")
                        .map_err(|e| anyhow::anyhow!("{}", e))?),
                    method,
                    &(),
                )
                .await?;
                Ok::<(), anyhow::Error>(())
            });
        }
    });
}

/// Fire-and-forget SetDnd call to a per-service daemon.
fn call_service_set_dnd(dbus_name: &str, enabled: bool) {
    let bus_name = format!("chat.loft.{}", dbus_name);
    let obj_path = format!("/chat/loft/{}", dbus_name);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        if let Ok(rt) = rt {
            let _ = rt.block_on(async {
                let conn = zbus::Connection::session().await?;
                conn.call_method(
                    Some(zbus::names::BusName::try_from(bus_name.as_str())
                        .map_err(|e| anyhow::anyhow!("{}", e))?),
                    zbus::zvariant::ObjectPath::try_from(obj_path.as_str())
                        .map_err(|e| anyhow::anyhow!("{}", e))?,
                    Some(zbus::names::InterfaceName::try_from("chat.loft.Service")
                        .map_err(|e| anyhow::anyhow!("{}", e))?),
                    "SetDnd",
                    &(enabled,),
                )
                .await?;
                Ok::<(), anyhow::Error>(())
            });
        }
    });
}

/// Load the combined Loft icon from the XDG theme data directory.
fn load_combined_icon() -> Vec<Icon> {
    let icon_path = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("icons/hicolor/scalable/apps/loft.svg");

    // SVG can't be directly converted to ARGB pixmap easily,
    // so just return empty and rely on icon_name resolution
    if icon_path.exists() {
        tracing::debug!("Combined icon path exists: {}", icon_path.display());
    }
    vec![]
}

/// Run the combined SNI tray icon lifecycle.
pub async fn run_combined_sni(state: Arc<CombinedTrayState>) -> Result<()> {
    let retry_delays = [0u64, 2, 4, 8, 16];

    loop {
        // Spawn tray with retry backoff
        let mut handle: Option<Handle<CombinedLoftTray>> = None;
        for (attempt, &delay_secs) in retry_delays.iter().enumerate() {
            if delay_secs > 0 {
                tracing::info!(
                    "Combined tray icon unavailable, retrying in {}s (attempt {}/{})",
                    delay_secs,
                    attempt + 1,
                    retry_delays.len()
                );
                tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
            }

            let tray = CombinedLoftTray {
                has_unread: false,
                all_dnd: false,
                services: Vec::new(),
                tray_icon_name: "loft-symbolic".to_string(),
                icon_data: load_combined_icon(),
            };

            match tray.spawn().await {
                Ok(h) => {
                    handle = Some(h);
                    break;
                }
                Err(e) => {
                    if attempt == retry_delays.len() - 1 {
                        tracing::error!(
                            "Failed to spawn combined tray icon after {} attempts: {:?}",
                            retry_delays.len(),
                            e
                        );
                        return Err(anyhow::anyhow!("Failed to spawn combined tray icon"));
                    }
                    tracing::warn!("Combined tray icon spawn failed: {:?}", e);
                }
            }
        }

        let handle = handle.unwrap();
        tracing::info!("Combined tray icon spawned");

        // Sync loop — only push updates to ksni when state actually changes,
        // to avoid menu redraws that break hover highlights.
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        let mut empty_since: Option<std::time::Instant> = None;
        // Grace period: don't exit for being empty until daemons have had time to register.
        let startup = std::time::Instant::now();
        let startup_grace = std::time::Duration::from_secs(10);
        let mut prev_has_unread = false;
        let mut prev_all_dnd = false;
        let mut prev_snapshots: Vec<ServiceSnapshot> = Vec::new();

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    if state.quit_requested.load(Ordering::Relaxed) {
                        handle.shutdown().await;
                        return Ok(());
                    }

                    let services = state.services.read().await;
                    let has_unread = services.values().any(|s| s.badge_count > 0 && !s.dnd);
                    let all_dnd = !services.is_empty() && services.values().all(|s| s.dnd);

                    let snapshots: Vec<ServiceSnapshot> = services
                        .iter()
                        .map(|(name, s)| ServiceSnapshot {
                            display_name: s.display_name.clone(),
                            dbus_name: dbus_name_for_service(name),
                            visible: s.visible,
                            badge_count: s.badge_count,
                            dnd: s.dnd,
                        })
                        .collect();

                    // Track empty state for grace timer
                    if services.is_empty() {
                        if empty_since.is_none() {
                            empty_since = Some(std::time::Instant::now());
                        }
                    } else {
                        empty_since = None;
                    }

                    drop(services);

                    // Exit after 3 seconds with no registered services (but not during startup grace)
                    if let Some(since) = empty_since {
                        if startup.elapsed() > startup_grace && since.elapsed() > std::time::Duration::from_secs(3) {
                            tracing::info!("No services registered for 3 seconds, exiting");
                            handle.shutdown().await;
                            return Ok(());
                        }
                    }

                    // Only update ksni when state has changed
                    if has_unread != prev_has_unread
                        || all_dnd != prev_all_dnd
                        || snapshots != prev_snapshots
                    {
                        prev_has_unread = has_unread;
                        prev_all_dnd = all_dnd;
                        prev_snapshots = snapshots.clone();

                        let result = handle.update(|tray: &mut CombinedLoftTray| {
                            tray.has_unread = has_unread;
                            tray.all_dnd = all_dnd;
                            tray.services = snapshots;
                        }).await;

                        if result.is_none() {
                            tracing::warn!("Combined tray handle closed unexpectedly, respawning");
                            break;
                        }
                    }
                }
            }
        }

        // Respawn after handle dies
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

// Reuse the overlay generators from daemon::tray
// (duplicated here to avoid coupling the combined_tray module to daemon internals)

fn generate_red_dot_overlay() -> Icon {
    const SIZE: i32 = 22;
    const DOT_RADIUS: f32 = 3.5;
    const DOT_CX: f32 = SIZE as f32 - DOT_RADIUS - 1.0;
    const DOT_CY: f32 = SIZE as f32 - DOT_RADIUS - 1.0;
    const R: f32 = 0xE0 as f32;
    const G: f32 = 0x1B as f32;
    const B: f32 = 0x24 as f32;

    let mut data = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 + 0.5 - DOT_CX;
            let dy = y as f32 + 0.5 - DOT_CY;
            let dist = (dx * dx + dy * dy).sqrt();
            let alpha = if dist <= DOT_RADIUS - 0.5 {
                1.0
            } else if dist <= DOT_RADIUS + 0.5 {
                DOT_RADIUS + 0.5 - dist
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

fn generate_dnd_dash_overlay() -> Icon {
    const SIZE: i32 = 22;
    const DASH_W: f32 = 6.0;
    const DASH_H: f32 = 2.0;
    const DASH_X: f32 = SIZE as f32 - DASH_W - 1.0;
    const DASH_Y: f32 = SIZE as f32 - DASH_H - 2.0;
    const R: f32 = 0x88 as f32;
    const G: f32 = 0x88 as f32;
    const B: f32 = 0x88 as f32;

    let mut data = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let fx = x as f32 + 0.5;
            let fy = y as f32 + 0.5;
            let corner_r = DASH_H / 2.0;
            let cx = fx.clamp(DASH_X + corner_r, DASH_X + DASH_W - corner_r);
            let cy = DASH_Y + corner_r;
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
