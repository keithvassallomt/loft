use crate::cli::ServiceName;

pub struct ServiceDefinition {
    pub name: &'static str,
    pub display_name: &'static str,
    pub url: &'static str,
    pub dbus_name: &'static str,
    /// URL for the application icon (used in .desktop files, manager GUI, notifications).
    pub app_icon_url: &'static str,
    /// Local filename for the app icon, stored in `~/.local/share/loft/icons/`.
    pub app_icon_filename: &'static str,
    /// URL for the system tray icon. Installed into the XDG icon theme so the
    /// desktop environment renders it natively via the SNI `IconName` property.
    pub tray_icon_url: &'static str,
    /// Chrome's auto-generated desktop entry ID for --app= mode notifications.
    /// Found by inspecting `dbus-monitor` or notification source names on GNOME.
    pub chrome_desktop_id: &'static str,
}

impl ServiceDefinition {
    /// XDG icon theme name for the app icon (e.g. `"loft-whatsapp"`).
    pub fn app_icon_name(&self) -> String {
        format!("loft-{}", self.name)
    }

    /// XDG icon theme name for the tray icon.
    ///
    /// On GNOME, returns `"loft-whatsapp-symbolic"` — the `-symbolic` suffix tells
    /// GNOME to recolour the icon to match the panel theme.
    ///
    /// On KDE and other desktops, returns `"loft-whatsapp"` (the coloured app icon)
    /// because those DEs don't recolour symbolic icons and the black fill is
    /// invisible on dark panels.
    pub fn tray_icon_name(&self) -> String {
        let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
        let is_gnome = desktop.split(':').any(|d| d.eq_ignore_ascii_case("GNOME"));
        if is_gnome {
            format!("loft-{}-symbolic", self.name)
        } else {
            format!("loft-{}", self.name)
        }
    }
}

pub const WHATSAPP: ServiceDefinition = ServiceDefinition {
    name: "whatsapp",
    display_name: "WhatsApp",
    url: "https://web.whatsapp.com/",
    dbus_name: "WhatsApp",
    app_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/whatsapp.svg",
    app_icon_filename: "whatsapp.svg",
    tray_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/whatsapp-symbolic.svg",
    chrome_desktop_id: "chrome-web.whatsapp.com__-Default",
};

pub const MESSENGER: ServiceDefinition = ServiceDefinition {
    name: "messenger",
    display_name: "Messenger",
    url: "https://facebook.com/messages/",
    dbus_name: "Messenger",
    app_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/messenger.svg",
    app_icon_filename: "messenger.svg",
    tray_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/messenger-symbolic.svg",
    chrome_desktop_id: "chrome-facebook.com__messages_-Default",
};

pub const SLACK: ServiceDefinition = ServiceDefinition {
    name: "slack",
    display_name: "Slack",
    url: "https://app.slack.com/client/",
    dbus_name: "Slack",
    app_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/slack.svg",
    app_icon_filename: "slack.svg",
    tray_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/slack-symbolic.svg",
    chrome_desktop_id: "chrome-app.slack.com__client_-Default",
};

pub const TELEGRAM: ServiceDefinition = ServiceDefinition {
    name: "telegram",
    display_name: "Telegram",
    url: "https://web.telegram.org/a/",
    dbus_name: "Telegram",
    app_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/telegram.svg",
    app_icon_filename: "telegram.svg",
    tray_icon_url: "https://raw.githubusercontent.com/keithvassallomt/loft/main/assets/icons/telegram-symbolic.svg",
    chrome_desktop_id: "chrome-web.telegram.org__a_-Default",
};

pub const ALL_SERVICES: &[&ServiceDefinition] = &[&WHATSAPP, &MESSENGER, &SLACK, &TELEGRAM];

pub fn get_definition(name: &ServiceName) -> &'static ServiceDefinition {
    match name {
        ServiceName::Whatsapp => &WHATSAPP,
        ServiceName::Messenger => &MESSENGER,
        ServiceName::Slack => &SLACK,
        ServiceName::Telegram => &TELEGRAM,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_services_have_unique_names() {
        let names: Vec<&str> = ALL_SERVICES.iter().map(|s| s.name).collect();
        let mut dedup = names.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(names.len(), dedup.len());
    }

    #[test]
    fn test_all_services_have_valid_urls() {
        for service in ALL_SERVICES {
            assert!(service.url.starts_with("https://"));
            assert!(service.app_icon_url.starts_with("https://"));
            assert!(service.tray_icon_url.starts_with("https://"));
        }
    }

    #[test]
    fn test_get_definition() {
        let wa = get_definition(&ServiceName::Whatsapp);
        assert_eq!(wa.name, "whatsapp");

        let msg = get_definition(&ServiceName::Messenger);
        assert_eq!(msg.name, "messenger");

        let slack = get_definition(&ServiceName::Slack);
        assert_eq!(slack.name, "slack");

        let telegram = get_definition(&ServiceName::Telegram);
        assert_eq!(telegram.name, "telegram");
    }
}
