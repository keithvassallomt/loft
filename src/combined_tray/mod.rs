pub mod gnome;
pub mod tray;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use tokio::sync::{Notify, RwLock};

use crate::config::{GlobalConfig, TrayBackend};

/// State for a single registered service in the combined tray.
#[derive(Clone, Debug)]
pub struct ServiceTrayState {
    pub display_name: String,
    pub wm_class: String,
    pub visible: bool,
    pub badge_count: u32,
    pub dnd: bool,
}

/// Shared state for the combined tray process.
pub struct CombinedTrayState {
    pub services: RwLock<HashMap<String, ServiceTrayState>>,
    pub quit_requested: AtomicBool,
    /// Notified whenever the service map changes (register/unregister/update).
    pub changed: Notify,
}

impl CombinedTrayState {
    pub fn new() -> Self {
        Self {
            services: RwLock::new(HashMap::new()),
            quit_requested: AtomicBool::new(false),
            changed: Notify::new(),
        }
    }

}

/// D-Bus interface served by the combined tray process.
pub struct CombinedTrayService {
    pub state: Arc<CombinedTrayState>,
}

#[zbus::interface(name = "chat.loft.Tray")]
impl CombinedTrayService {
    async fn register(
        &self,
        name: &str,
        display_name: &str,
        _icon_name: &str,
        wm_class: &str,
        visible: bool,
        badge: u32,
        dnd: bool,
    ) {
        tracing::info!("Combined tray: Register({}, badge={}, dnd={})", name, badge, dnd);
        let entry = ServiceTrayState {
            display_name: display_name.to_string(),
            wm_class: wm_class.to_string(),
            visible,
            badge_count: badge,
            dnd,
        };
        self.state.services.write().await.insert(name.to_string(), entry);
        self.state.changed.notify_waiters();
    }

    async fn unregister(&self, name: &str) {
        tracing::info!("Combined tray: Unregister({})", name);
        self.state.services.write().await.remove(name);
        self.state.changed.notify_waiters();
    }

    async fn update_state(&self, name: &str, visible: bool, badge: u32, dnd: bool) {
        let mut services = self.state.services.write().await;
        if let Some(entry) = services.get_mut(name) {
            entry.visible = visible;
            entry.badge_count = badge;
            entry.dnd = dnd;
        }
        drop(services);
        self.state.changed.notify_waiters();
    }

    async fn quit(&self) {
        tracing::info!("Combined tray: Quit() called");
        self.state.quit_requested.store(true, Ordering::Relaxed);
        self.state.changed.notify_waiters();
    }
}

/// Main entry point for `loft --tray`.
pub async fn run() -> Result<()> {
    // Ensure the combined icon is installed in the XDG icon theme
    if let Err(e) = crate::desktop::ensure_combined_icon() {
        tracing::warn!("Failed to install combined tray icon: {}", e);
    }

    let state = Arc::new(CombinedTrayState::new());

    // Register D-Bus service. Request the well-known name with DoNotQueue so
    // only one instance wins when multiple daemons autostart simultaneously and
    // race to spawn `loft --tray`. The old approach (name_has_owner + Builder
    // .name()) was racy: all racers saw "no owner", all built connections with
    // .name() which queues by default, and orphan instances later unregistered
    // the panel icon when their empty-services timeout fired.
    let service = CombinedTrayService {
        state: Arc::clone(&state),
    };
    let conn = zbus::connection::Builder::session()?
        .serve_at("/chat/loft/Tray", service)?
        .build()
        .await
        .context("Failed to build combined tray D-Bus connection")?;

    let reply = conn
        .request_name_with_flags(
            "chat.loft.Tray",
            zbus::fdo::RequestNameFlags::DoNotQueue.into(),
        )
        .await?;
    match reply {
        zbus::fdo::RequestNameReply::PrimaryOwner | zbus::fdo::RequestNameReply::AlreadyOwner => {}
        _ => {
            tracing::info!("Combined tray already running, exiting");
            return Ok(());
        }
    }

    tracing::info!("Combined tray D-Bus service registered");

    // 3. Resolve backend
    let global_config = GlobalConfig::load().unwrap_or_default();
    let effective_backend = global_config.tray_backend.resolve();
    tracing::info!("Combined tray backend: {} (resolved: {})", global_config.tray_backend, effective_backend);

    // 4. Signal handling
    let signal_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("Failed to register SIGTERM handler");
        let mut sigint =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("Failed to register SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => tracing::info!("Combined tray received SIGTERM"),
            _ = sigint.recv() => tracing::info!("Combined tray received SIGINT"),
        }
        signal_state.quit_requested.store(true, Ordering::Relaxed);
        signal_state.changed.notify_waiters();
    });

    // 5. Listen for CombineTrayChanged signal (if user disables combine, exit)
    {
        let listen_state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = listen_combine_changed(listen_state).await {
                tracing::debug!("CombineTrayChanged listener ended: {}", e);
            }
        });
    }

    // 6. Spawn the appropriate tray icon backend
    match effective_backend {
        TrayBackend::GnomePanel => {
            gnome::run_combined_gnome_panel(Arc::clone(&state)).await?;
        }
        TrayBackend::Sni | TrayBackend::Auto => {
            tray::run_combined_sni(Arc::clone(&state)).await?;
        }
    }

    tracing::info!("Combined tray shutting down");
    Ok(())
}

/// Listen for the `CombineTrayChanged` D-Bus signal. When `enabled=false`,
/// signal the tray to quit.
async fn listen_combine_changed(state: Arc<CombinedTrayState>) -> Result<()> {
    use futures_util::StreamExt;

    let conn = zbus::Connection::session().await?;

    let rule = "type='signal',\
                interface='chat.loft.Tray',\
                member='CombineTrayChanged',\
                path='/chat/loft/Tray'";
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "AddMatch",
        &(rule,),
    )
    .await?;

    let mut stream = zbus::MessageStream::from(&conn);
    while let Some(Ok(msg)) = stream.next().await {
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("CombineTrayChanged") {
            continue;
        }
        if let Ok((enabled,)) = msg.body().deserialize::<(bool,)>() {
            if !enabled {
                tracing::info!("CombineTrayChanged(false) received, shutting down");
                state.quit_requested.store(true, Ordering::Relaxed);
                state.changed.notify_waiters();
                break;
            }
        }
    }

    Ok(())
}
