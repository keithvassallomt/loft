use anyhow::Result;

use crate::config::ServiceConfig;
use crate::service::ServiceDefinition;

/// Set autostart for a service and persist the setting.
///
/// Uses the XDG Background portal when running in a Flatpak sandbox,
/// or XDG autostart `.desktop` files when running natively.
pub async fn set_autostart(
    definition: &ServiceDefinition,
    enabled: bool,
    window: Option<&impl gtk4::prelude::IsA<gtk4::Native>>,
) -> Result<()> {
    if crate::chrome::is_flatpak() {
        set_autostart_portal(definition, enabled, window).await?;
    } else {
        crate::desktop::set_autostart(definition, enabled)?;
    }

    // Persist to config only after the effectful operation succeeds
    let mut config = ServiceConfig::load(&definition.name).unwrap_or_default();
    config.autostart = enabled;
    config.save(&definition.name)?;

    tracing::info!(
        "Autostart for {} set to {}",
        definition.display_name,
        enabled
    );
    Ok(())
}

/// Portal path: use org.freedesktop.portal.Background.
async fn set_autostart_portal(
    definition: &ServiceDefinition,
    enabled: bool,
    window: Option<&impl gtk4::prelude::IsA<gtk4::Native>>,
) -> Result<()> {
    use ashpd::desktop::background::Background;
    use ashpd::WindowIdentifier;

    let identifier = match window {
        Some(native) => WindowIdentifier::from_native(native).await,
        None => None,
    };

    let reason = format!(
        "{} — start at login via Loft",
        definition.display_name
    );
    let response = Background::request()
        .identifier(identifier)
        .reason(reason.as_str())
        .auto_start(enabled)
        .command(&["loft", "--service", definition.name, "--minimized"])
        .dbus_activatable(false)
        .send()
        .await?
        .response()?;

    if enabled && !response.auto_start() {
        return Err(anyhow::anyhow!("Autostart permission denied by the portal"));
    }

    Ok(())
}
