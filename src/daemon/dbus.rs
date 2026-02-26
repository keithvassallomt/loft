use std::sync::Arc;

use anyhow::Result;
use zbus::interface;
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::ObjectPath;

use crate::service::ServiceDefinition;

use super::DaemonState;

pub struct LoftService {
    pub state: Arc<DaemonState>,
}

#[interface(name = "chat.loft.Service")]
impl LoftService {
    async fn show(&self) {
        tracing::info!("D-Bus Show() called");
        self.state.request_show();
    }

    async fn hide(&self) {
        tracing::info!("D-Bus Hide() called");
        self.state.request_hide();
    }

    async fn toggle(&self) {
        tracing::info!("D-Bus Toggle() called");
        if self.state.is_visible() {
            self.state.request_hide();
        } else {
            self.state.request_show();
        }
    }

    async fn quit(&self) {
        tracing::info!("D-Bus Quit() called");
        self.state.request_quit();
    }

    async fn get_status(&self) -> (bool, u32, bool) {
        (
            self.state.is_visible(),
            self.state.get_badge_count(),
            self.state.is_dnd(),
        )
    }
}

fn bus_name_for(definition: &ServiceDefinition) -> Result<WellKnownName<'static>> {
    let name = format!("chat.loft.{}", definition.dbus_name);
    WellKnownName::try_from(name).map_err(|e| anyhow::anyhow!("Invalid bus name: {}", e))
}

fn object_path_for(definition: &ServiceDefinition) -> Result<ObjectPath<'static>> {
    let path = format!("/chat/loft/{}", definition.dbus_name);
    ObjectPath::try_from(path).map_err(|e| anyhow::anyhow!("Invalid object path: {}", e))
}

/// Check if a daemon for this service is already running on the session bus.
pub async fn is_already_running(definition: &ServiceDefinition) -> Result<bool> {
    let connection = zbus::Connection::session().await?;
    let bus_name = bus_name_for(definition)?;
    let dbus = zbus::fdo::DBusProxy::new(&connection).await?;
    Ok(dbus.name_has_owner(BusName::from(bus_name)).await?)
}

/// Send a Show() call to the already-running daemon instance.
pub async fn call_show(definition: &ServiceDefinition) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    let bus_name = bus_name_for(definition)?;
    let path = object_path_for(definition)?;
    let iface = InterfaceName::try_from("chat.loft.Service")
        .map_err(|e| anyhow::anyhow!("Invalid interface: {}", e))?;
    connection
        .call_method(
            Some(BusName::from(bus_name)),
            path,
            Some(iface),
            "Show",
            &(),
        )
        .await?;
    Ok(())
}

/// Register the D-Bus service for this daemon instance.
pub async fn register(
    definition: &ServiceDefinition,
    service: LoftService,
) -> Result<zbus::Connection> {
    let bus_name = bus_name_for(definition)?;
    let path = object_path_for(definition)?;

    let connection = zbus::connection::Builder::session()?
        .name(bus_name.clone())?
        .serve_at(path.clone(), service)?
        .build()
        .await?;

    tracing::info!("Registered D-Bus service: {} at {}", bus_name, path);
    Ok(connection)
}
