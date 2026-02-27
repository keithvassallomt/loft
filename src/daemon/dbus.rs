use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::Result;
use zbus::interface;
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::ObjectPath;

use crate::config::ServiceConfig;
use crate::service::ServiceDefinition;

use super::messaging::DaemonMessage;
use super::DaemonState;

pub struct LoftService {
    pub state: Arc<DaemonState>,
    pub service_name: String,
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

    async fn set_show_titlebar(&self, show: bool) {
        tracing::info!("D-Bus SetShowTitlebar({}) called", show);
        self.state.show_titlebar.store(show, Ordering::Relaxed);
        let _ = self.state.cmd_tx.send(DaemonMessage::TitlebarConfig { show });

        // Persist to config
        if let Ok(mut config) = ServiceConfig::load(&self.service_name) {
            config.show_titlebar = show;
            if let Err(e) = config.save(&self.service_name) {
                tracing::error!("Failed to save config: {}", e);
            }
        }
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

/// Send a SetShowTitlebar() call to the already-running daemon instance.
pub async fn call_set_show_titlebar(definition: &ServiceDefinition, show: bool) -> Result<()> {
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
            "SetShowTitlebar",
            &(show,),
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
