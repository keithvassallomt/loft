use anyhow::Result;
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::ObjectPath;

const DBUS_NAME: &str = "chat.loft.ShellHelper";
const DBUS_PATH: &str = "/chat/loft/ShellHelper";
const DBUS_IFACE: &str = "chat.loft.ShellHelper";

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

/// Call the GNOME Shell extension's FocusWindow method via D-Bus.
pub async fn focus_window(wm_class: &str) -> Result<bool> {
    let connection = zbus::Connection::session().await?;
    let reply = connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "FocusWindow",
            &(wm_class,),
        )
        .await?;
    let (success,): (bool,) = reply.body().deserialize()?;
    Ok(success)
}

/// Call the GNOME Shell extension's HideWindow method via D-Bus.
pub async fn hide_window(wm_class: &str) -> Result<bool> {
    let connection = zbus::Connection::session().await?;
    let reply = connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "HideWindow",
            &(wm_class,),
        )
        .await?;
    let (success,): (bool,) = reply.body().deserialize()?;
    Ok(success)
}

/// Register a service panel icon in the GNOME Shell extension.
pub async fn register_service(
    name: &str,
    display_name: &str,
    icon_name: &str,
    wm_class: &str,
) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "RegisterService",
            &(name, display_name, icon_name, wm_class),
        )
        .await?;
    Ok(())
}

/// Remove a service panel icon from the GNOME Shell extension.
pub async fn unregister_service(name: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UnregisterService",
            &(name,),
        )
        .await?;
    Ok(())
}

/// Update the badge count on a service's panel icon.
pub async fn update_badge(name: &str, count: u32) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UpdateBadge",
            &(name, count),
        )
        .await?;
    Ok(())
}

/// Update the DND state on a service's panel icon.
pub async fn update_dnd(name: &str, enabled: bool) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UpdateDnd",
            &(name, enabled),
        )
        .await?;
    Ok(())
}

/// Update the visibility state on a service's panel icon.
pub async fn update_visible(name: &str, visible: bool) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    connection
        .call_method(
            Some(BusName::from(bus_name()?)),
            object_path()?,
            Some(iface_name()?),
            "UpdateVisible",
            &(name, visible),
        )
        .await?;
    Ok(())
}

/// Check if the GNOME Shell extension's D-Bus name is available.
pub async fn is_available() -> bool {
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
