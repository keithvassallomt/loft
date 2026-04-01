use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::Result;
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::ObjectPath;

use super::CombinedTrayState;

const SHELL_DBUS_NAME: &str = "chat.loft.ShellHelper";
const SHELL_DBUS_PATH: &str = "/chat/loft/ShellHelper";
const SHELL_DBUS_IFACE: &str = "chat.loft.ShellHelper";

fn bus_name() -> Result<WellKnownName<'static>> {
    WellKnownName::try_from(SHELL_DBUS_NAME.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid bus name: {}", e))
}

fn object_path() -> Result<ObjectPath<'static>> {
    ObjectPath::try_from(SHELL_DBUS_PATH.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid object path: {}", e))
}

fn iface_name() -> Result<InterfaceName<'static>> {
    InterfaceName::try_from(SHELL_DBUS_IFACE.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid interface name: {}", e))
}

/// Register the combined panel icon with the GNOME Shell extension.
pub async fn register_combined(icon_name: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "RegisterCombined",
            &(icon_name,),
        )
        .await?;
    Ok(())
}

/// Unregister the combined panel icon from the GNOME Shell extension.
pub async fn unregister_combined() -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UnregisterCombined",
            &(),
        )
        .await?;
    Ok(())
}

/// Add or update a service section in the combined panel icon's menu.
pub async fn update_combined_service(
    name: &str,
    display_name: &str,
    visible: bool,
    badge: u32,
    dnd: bool,
    wm_class: &str,
) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UpdateCombinedService",
            &(name, display_name, visible, badge, dnd, wm_class),
        )
        .await?;
    Ok(())
}

/// Remove a service section from the combined panel icon's menu.
pub async fn remove_combined_service(name: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "RemoveCombinedService",
            &(name,),
        )
        .await?;
    Ok(())
}

/// Run the combined GNOME panel icon lifecycle.
pub async fn run_combined_gnome_panel(state: Arc<CombinedTrayState>) -> Result<()> {
    // Register combined icon with retry
    let retry_delays = [0u64, 2, 4, 8, 16];
    for (attempt, &delay_secs) in retry_delays.iter().enumerate() {
        if delay_secs > 0 {
            tracing::info!(
                "GNOME combined panel icon unavailable, retrying in {}s (attempt {}/{})",
                delay_secs,
                attempt + 1,
                retry_delays.len()
            );
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }
        match register_combined("loft-symbolic").await {
            Ok(()) => {
                tracing::info!("Registered combined GNOME panel icon");
                break;
            }
            Err(e) => {
                if attempt == retry_delays.len() - 1 {
                    tracing::error!(
                        "Failed to register combined GNOME panel icon after {} attempts: {}",
                        retry_delays.len(),
                        e
                    );
                } else {
                    tracing::warn!("Combined GNOME panel icon registration failed: {}", e);
                }
            }
        }
    }

    // Monitor shell helper restarts
    let restart_state = Arc::clone(&state);
    tokio::spawn(async move {
        monitor_shell_helper_restart(restart_state).await;
    });

    // Sync loop: push service state to GNOME Shell extension.
    // Only send D-Bus calls when state actually changes, to avoid menu rebuilds
    // that cause hover highlight flashing.
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    let mut empty_since: Option<std::time::Instant> = None;
    // Grace period: don't exit for being empty until daemons have had time to register.
    let startup = std::time::Instant::now();
    let startup_grace = std::time::Duration::from_secs(10);
    let mut prev_snapshots: std::collections::HashMap<String, (String, bool, u32, bool, String)> =
        std::collections::HashMap::new();

    loop {
        interval.tick().await;

        if state.quit_requested.load(Ordering::Relaxed) {
            let _ = unregister_combined().await;
            return Ok(());
        }

        let services = state.services.read().await;

        // Track empty state for grace timer
        if services.is_empty() {
            if empty_since.is_none() {
                empty_since = Some(std::time::Instant::now());
            }
        } else {
            empty_since = None;
        }

        // Build current snapshot
        let current_snapshots: std::collections::HashMap<String, (String, bool, u32, bool, String)> =
            services
                .iter()
                .map(|(name, svc)| {
                    (
                        name.clone(),
                        (
                            svc.display_name.clone(),
                            svc.visible,
                            svc.badge_count,
                            svc.dnd,
                            svc.wm_class.clone(),
                        ),
                    )
                })
                .collect();

        drop(services);

        // Remove services that are no longer registered
        for name in prev_snapshots.keys() {
            if !current_snapshots.contains_key(name) {
                let _ = remove_combined_service(name).await;
            }
        }

        // Only update services whose state has changed
        for (name, (display_name, visible, badge, dnd, wm_class)) in &current_snapshots {
            if prev_snapshots.get(name) != Some(&(display_name.clone(), *visible, *badge, *dnd, wm_class.clone())) {
                let _ = update_combined_service(name, display_name, *visible, *badge, *dnd, wm_class).await;
            }
        }

        prev_snapshots = current_snapshots;

        // Exit after 3 seconds with no registered services (but not during startup grace)
        if let Some(since) = empty_since {
            if startup.elapsed() > startup_grace && since.elapsed() > std::time::Duration::from_secs(3) {
                tracing::info!("No services registered for 3 seconds, exiting");
                let _ = unregister_combined().await;
                return Ok(());
            }
        }
    }
}

/// Monitor `chat.loft.ShellHelper` D-Bus name. When the GNOME Shell extension
/// restarts, re-register the combined icon and sync all services.
async fn monitor_shell_helper_restart(state: Arc<CombinedTrayState>) {
    use futures_util::StreamExt;

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Cannot monitor ShellHelper restart: {}", e);
            return;
        }
    };

    let rule = "type='signal',sender='org.freedesktop.DBus',\
                interface='org.freedesktop.DBus',\
                member='NameOwnerChanged',\
                arg0='chat.loft.ShellHelper'";
    if let Err(e) = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule,),
        )
        .await
    {
        tracing::warn!("Failed to subscribe to ShellHelper name changes: {}", e);
        return;
    }

    let mut stream = zbus::MessageStream::from(&conn);
    while let Some(Ok(msg)) = stream.next().await {
        if state.quit_requested.load(Ordering::Relaxed) {
            break;
        }
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("NameOwnerChanged") {
            continue;
        }
        if let Ok((name, old_owner, new_owner)) =
            msg.body().deserialize::<(String, String, String)>()
        {
            if name == "chat.loft.ShellHelper"
                && old_owner.is_empty()
                && !new_owner.is_empty()
            {
                tracing::info!("GNOME Shell helper restarted, re-registering combined icon");
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;

                let _ = register_combined("loft-symbolic").await;

                // Re-sync all services
                let services = state.services.read().await;
                for (name, svc) in services.iter() {
                    let _ = update_combined_service(
                        name,
                        &svc.display_name,
                        svc.visible,
                        svc.badge_count,
                        svc.dnd,
                        &svc.wm_class,
                    )
                    .await;
                }
            }
        }
    }
}
