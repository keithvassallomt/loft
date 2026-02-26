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

/// Spawn the tray icon and start a background task that syncs daemon state to it.
pub async fn spawn_tray(
    tray: LoftTray,
    state: Arc<DaemonState>,
) -> Result<Handle<LoftTray>, ksni::Error> {
    let handle = tray.spawn().await?;

    // Background task: sync DaemonState -> tray every 500ms
    let sync_handle = handle.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            interval.tick().await;
            let badge = state.badge_count.load(Ordering::Relaxed);
            let visible = state.visible.load(Ordering::Relaxed);
            let dnd = state.dnd.load(Ordering::Relaxed);

            let updated = sync_handle
                .update(|tray| {
                    tray.badge_count = badge;
                    tray.visible = visible;
                    tray.dnd = dnd;
                })
                .await;

            if updated.is_none() {
                // Handle closed, tray shut down
                break;
            }
        }
    });

    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_state() -> Arc<DaemonState> {
        Arc::new(DaemonState::new(false))
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
