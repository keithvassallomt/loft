//! Report a status string to GNOME's Background Apps list via the
//! `org.freedesktop.portal.Background.SetStatus` portal method.
//!
//! Two modes:
//!
//! * **Flatpak** — every Loft daemon shares the sandbox app ID
//!   `chat.loft.Loft`, so the Background Apps list shows a single "Loft"
//!   entry. Each daemon computes the same aggregate status (summed across
//!   all running `chat.loft.<Service>` D-Bus peers) and writes it; last
//!   writer wins, but the result is stable because they all compute the
//!   same value.
//! * **Native** — each daemon is associated with its own
//!   `loft-<service>.desktop`, so the Background Apps list shows one entry
//!   per running service. Each daemon writes only its own badge count.

use std::sync::OnceLock;

use anyhow::Result;
use zbus::names::{BusName, InterfaceName, WellKnownName};
use zbus::zvariant::{ObjectPath, Value};

use crate::service::ALL_SERVICES;

const PORTAL_BUS: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const PORTAL_IFACE: &str = "org.freedesktop.portal.Background";

const DBUS_BUS: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const DBUS_IFACE: &str = "org.freedesktop.DBus";

const SERVICE_IFACE: &str = "chat.loft.Service";

/// Returns true if we're running inside a Flatpak sandbox.
pub fn is_flatpak() -> bool {
    static CACHED: OnceLock<bool> = OnceLock::new();
    *CACHED.get_or_init(|| {
        std::env::var_os("FLATPAK_ID").is_some()
            || std::path::Path::new("/.flatpak-info").exists()
    })
}

/// Call `org.freedesktop.portal.Background.SetStatus({"message": message})`.
/// Passing an empty string clears the sub-text on GNOME's Background Apps entry.
pub async fn set_status(message: &str) -> Result<()> {
    let connection = zbus::Connection::session().await?;
    let bus = WellKnownName::try_from(PORTAL_BUS)
        .map_err(|e| anyhow::anyhow!("Invalid bus name: {}", e))?;
    let path = ObjectPath::try_from(PORTAL_PATH)
        .map_err(|e| anyhow::anyhow!("Invalid object path: {}", e))?;
    let iface = InterfaceName::try_from(PORTAL_IFACE)
        .map_err(|e| anyhow::anyhow!("Invalid interface name: {}", e))?;

    let mut options: std::collections::HashMap<&str, Value> =
        std::collections::HashMap::new();
    options.insert("message", Value::new(message.to_string()));

    connection
        .call_method(
            Some(BusName::from(bus)),
            path,
            Some(iface),
            "SetStatus",
            &(options,),
        )
        .await?;
    Ok(())
}

/// Aggregate view across all running Loft service daemons.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Aggregate {
    pub service_count: u32,
    pub unread_total: u32,
    /// (display_name, badge) in order of discovery.
    pub per_service: Vec<(String, u32)>,
}

/// Enumerate all `chat.loft.<Service>` D-Bus peers, call `GetStatus()` on
/// each, and sum their badge counts.
pub async fn collect_aggregate() -> Aggregate {
    let mut agg = Aggregate::default();

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!("background_status: session bus unavailable: {}", e);
            return agg;
        }
    };

    // List all bus names
    let names: Vec<String> = match conn
        .call_method(
            Some(BusName::from(
                WellKnownName::try_from(DBUS_BUS).unwrap(),
            )),
            ObjectPath::try_from(DBUS_PATH).unwrap(),
            Some(InterfaceName::try_from(DBUS_IFACE).unwrap()),
            "ListNames",
            &(),
        )
        .await
    {
        Ok(reply) => match reply.body().deserialize::<(Vec<String>,)>() {
            Ok((v,)) => v,
            Err(e) => {
                tracing::debug!("background_status: ListNames parse failed: {}", e);
                return agg;
            }
        },
        Err(e) => {
            tracing::debug!("background_status: ListNames failed: {}", e);
            return agg;
        }
    };

    // For each known service, check if its well-known name is present
    for def in ALL_SERVICES {
        let bus_name = format!("chat.loft.{}", def.dbus_name);
        if !names.iter().any(|n| n == &bus_name) {
            continue;
        }
        let path = format!("/chat/loft/{}", def.dbus_name);

        let bus = match WellKnownName::try_from(bus_name.clone()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let obj = match ObjectPath::try_from(path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let iface = match InterfaceName::try_from(SERVICE_IFACE) {
            Ok(i) => i,
            Err(_) => continue,
        };

        let reply = match conn
            .call_method(Some(BusName::from(bus)), obj, Some(iface), "GetStatus", &())
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(
                    "background_status: GetStatus on {} failed: {}",
                    bus_name,
                    e
                );
                continue;
            }
        };
        let (_visible, badge, _dnd): (bool, u32, bool) = match reply.body().deserialize() {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(
                    "background_status: GetStatus parse for {} failed: {}",
                    bus_name,
                    e
                );
                continue;
            }
        };

        agg.service_count += 1;
        agg.unread_total += badge;
        agg.per_service.push((def.display_name.to_string(), badge));
    }

    agg
}

/// Format the Flatpak-mode aggregate status string.
///
/// * No services → empty string (clears the entry).
/// * Services running, no unread → `"<N> services running"` / `"1 service running"`.
/// * Exactly one service has unread → `"<Name>: <N> unread"`.
/// * Multiple services have unread → `"<Total> unread (<Name> <N>, <Name> <N>)"`.
pub fn format_aggregate(agg: &Aggregate) -> String {
    if agg.service_count == 0 {
        return String::new();
    }
    let unread_services: Vec<&(String, u32)> = agg
        .per_service
        .iter()
        .filter(|(_, b)| *b > 0)
        .collect();

    match unread_services.len() {
        0 => {
            if agg.service_count == 1 {
                "1 service running".to_string()
            } else {
                format!("{} services running", agg.service_count)
            }
        }
        1 => {
            let (name, badge) = unread_services[0];
            format!("{}: {} unread", name, badge)
        }
        _ => {
            let parts: Vec<String> = unread_services
                .iter()
                .map(|(name, badge)| format!("{} {}", name, badge))
                .collect();
            format!("{} unread ({})", agg.unread_total, parts.join(", "))
        }
    }
}

/// Format the native-mode per-service status string.
///
/// `display_name` is unused in the current rule (GNOME already labels the
/// entry with the app name) but is accepted for forward compatibility.
pub fn format_own(_display_name: &str, badge: u32) -> String {
    if badge == 0 {
        String::new()
    } else {
        format!("{} unread", badge)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agg(services: &[(&str, u32)]) -> Aggregate {
        Aggregate {
            service_count: services.len() as u32,
            unread_total: services.iter().map(|(_, b)| *b).sum(),
            per_service: services
                .iter()
                .map(|(n, b)| (n.to_string(), *b))
                .collect(),
        }
    }

    #[test]
    fn format_aggregate_empty() {
        assert_eq!(format_aggregate(&Aggregate::default()), "");
    }

    #[test]
    fn format_aggregate_one_running_no_unread() {
        assert_eq!(format_aggregate(&agg(&[("WhatsApp", 0)])), "1 service running");
    }

    #[test]
    fn format_aggregate_many_running_no_unread() {
        assert_eq!(
            format_aggregate(&agg(&[("WhatsApp", 0), ("Slack", 0)])),
            "2 services running"
        );
    }

    #[test]
    fn format_aggregate_one_unread() {
        assert_eq!(
            format_aggregate(&agg(&[("WhatsApp", 4), ("Slack", 0)])),
            "WhatsApp: 4 unread"
        );
    }

    #[test]
    fn format_aggregate_multi_unread() {
        assert_eq!(
            format_aggregate(&agg(&[("WhatsApp", 4), ("Slack", 3)])),
            "7 unread (WhatsApp 4, Slack 3)"
        );
    }

    #[test]
    fn format_own_zero() {
        assert_eq!(format_own("WhatsApp", 0), "");
    }

    #[test]
    fn format_own_one() {
        assert_eq!(format_own("WhatsApp", 1), "1 unread");
    }

    #[test]
    fn format_own_many() {
        assert_eq!(format_own("Slack", 12), "12 unread");
    }

}
