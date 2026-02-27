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
