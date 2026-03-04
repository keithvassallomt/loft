use anyhow::{Context, Result};
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::ObjectPath;

const DBUS_NAME: &str = "chat.loft.Tray";
const DBUS_PATH: &str = "/chat/loft/Tray";
const DBUS_IFACE: &str = "chat.loft.Tray";

fn bus_name() -> Result<WellKnownName<'static>> {
    WellKnownName::try_from(DBUS_NAME.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid bus name: {}", e))
}

fn object_path() -> Result<ObjectPath<'static>> {
    ObjectPath::try_from(DBUS_PATH.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid object path: {}", e))
}

fn iface_name() -> Result<InterfaceName<'static>> {
    InterfaceName::try_from(DBUS_IFACE.to_string())
        .map_err(|e| anyhow::anyhow!("Invalid interface name: {}", e))
}

/// Check if the combined tray process (`loft --tray`) is running.
pub async fn is_tray_running() -> bool {
    let connection = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(_) => return false,
    };
    let bus_name = match bus_name() {
        Ok(n) => n,
        Err(_) => return false,
    };
    let dbus = match zbus::fdo::DBusProxy::new(&connection).await {
        Ok(p) => p,
        Err(_) => return false,
    };
    dbus.name_has_owner(BusName::from(bus_name))
        .await
        .unwrap_or(false)
}

/// Spawn `loft --tray` if it's not already running. Waits up to 5 seconds
/// for the D-Bus name to appear.
pub async fn spawn_tray_if_needed() -> Result<()> {
    if is_tray_running().await {
        return Ok(());
    }

    let exe = std::env::current_exe().context("Could not determine loft binary path")?;
    std::process::Command::new(exe)
        .arg("--tray")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("Failed to spawn loft --tray")?;

    // Wait for the D-Bus name to appear
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if is_tray_running().await {
            return Ok(());
        }
    }

    Err(anyhow::anyhow!("Combined tray did not start in time"))
}

/// Register this service with the combined tray process.
pub async fn register(
    name: &str,
    display_name: &str,
    icon_name: &str,
    wm_class: &str,
    visible: bool,
    badge: u32,
    dnd: bool,
) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "Register",
            &(name, display_name, icon_name, wm_class, visible, badge, dnd),
        )
        .await?;
    Ok(())
}

/// Unregister this service from the combined tray process.
pub async fn unregister(name: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "Unregister",
            &(name,),
        )
        .await?;
    Ok(())
}

/// Push a state update to the combined tray process.
pub async fn update_state(name: &str, visible: bool, badge: u32, dnd: bool) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UpdateState",
            &(name, visible, badge, dnd),
        )
        .await?;
    Ok(())
}
