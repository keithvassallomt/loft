use anyhow::Result;

use crate::config::ServiceConfig;
use crate::service::ServiceDefinition;

/// Set autostart for a service and persist the setting.
///
/// Uses XDG autostart `.desktop` files in `~/.config/autostart/`.
pub async fn set_autostart(
    definition: &ServiceDefinition,
    enabled: bool,
    _window: Option<&impl gtk4::prelude::IsA<gtk4::Native>>,
) -> Result<()> {
    crate::desktop::set_autostart(definition, enabled)?;

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
