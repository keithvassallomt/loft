use crate::cli::ServiceName;

pub struct ServiceDefinition {
    pub name: &'static str,
    pub display_name: &'static str,
    pub url: &'static str,
    pub dbus_name: &'static str,
    /// App icon SVG, embedded at compile time.
    pub app_icon_svg: &'static str,
    /// App icon PNG, embedded at compile time (for SNI tray pixmaps on KDE).
    pub app_icon_png: &'static [u8],
    /// Symbolic tray icon SVG, embedded at compile time.
    pub tray_icon_svg: &'static str,
    /// Local filename for the app icon, stored in `~/.local/share/loft/icons/`.
    pub app_icon_filename: &'static str,
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
    app_icon_svg: include_str!("../assets/icons/whatsapp.svg"),
    app_icon_png: include_bytes!("../assets/icons/whatsapp.png"),
    tray_icon_svg: include_str!("../assets/icons/whatsapp-symbolic.svg"),
    app_icon_filename: "whatsapp.svg",
    chrome_desktop_id: "chrome-web.whatsapp.com__-Default",
};

pub const MESSENGER: ServiceDefinition = ServiceDefinition {
    name: "messenger",
    display_name: "Messenger",
    url: "https://facebook.com/messages/",
    dbus_name: "Messenger",
    app_icon_svg: include_str!("../assets/icons/messenger.svg"),
    app_icon_png: include_bytes!("../assets/icons/messenger.png"),
    tray_icon_svg: include_str!("../assets/icons/messenger-symbolic.svg"),
    app_icon_filename: "messenger.svg",
    chrome_desktop_id: "chrome-facebook.com__messages_-Default",
};

pub const SLACK: ServiceDefinition = ServiceDefinition {
    name: "slack",
    display_name: "Slack",
    url: "https://app.slack.com/client/",
    dbus_name: "Slack",
    app_icon_svg: include_str!("../assets/icons/slack.svg"),
    app_icon_png: include_bytes!("../assets/icons/slack.png"),
    tray_icon_svg: include_str!("../assets/icons/slack-symbolic.svg"),
    app_icon_filename: "slack.svg",
    chrome_desktop_id: "chrome-app.slack.com__client_-Default",
};

pub const TELEGRAM: ServiceDefinition = ServiceDefinition {
    name: "telegram",
    display_name: "Telegram",
    url: "https://web.telegram.org/a/",
    dbus_name: "Telegram",
    app_icon_svg: include_str!("../assets/icons/telegram.svg"),
    app_icon_png: include_bytes!("../assets/icons/telegram.png"),
    tray_icon_svg: include_str!("../assets/icons/telegram-symbolic.svg"),
    app_icon_filename: "telegram.svg",
    chrome_desktop_id: "chrome-web.telegram.org__a_-Default",
};

pub const ELEMENT: ServiceDefinition = ServiceDefinition {
    name: "element",
    display_name: "Element",
    url: "https://app.element.io/",
    dbus_name: "Element",
    app_icon_svg: include_str!("../assets/icons/element.svg"),
    app_icon_png: include_bytes!("../assets/icons/element.png"),
    tray_icon_svg: include_str!("../assets/icons/element-symbolic.svg"),
    app_icon_filename: "element.svg",
    chrome_desktop_id: "chrome-app.element.io__-Default",
};

// NextCloud Talk is always self-hosted — there is no central instance like
// app.element.io. The `url`/`chrome_desktop_id` below are placeholders; Talk
// only integrates once the user sets a `custom_url` (manager → Connection),
// at which point the daemon derives the window class from that URL and templates
// the extension manifest with its origin (see deploy_extension).
pub const TALK: ServiceDefinition = ServiceDefinition {
    name: "talk",
    display_name: "NextCloud Talk",
    url: "https://cloud.nextcloud.com/apps/spreed/",
    dbus_name: "Talk",
    app_icon_svg: include_str!("../assets/icons/talk.svg"),
    app_icon_png: include_bytes!("../assets/icons/talk.png"),
    tray_icon_svg: include_str!("../assets/icons/talk-symbolic.svg"),
    app_icon_filename: "talk.svg",
    chrome_desktop_id: "chrome-cloud.nextcloud.com__apps_spreed_-Default",
};

pub const ALL_SERVICES: &[&ServiceDefinition] =
    &[&WHATSAPP, &MESSENGER, &SLACK, &TELEGRAM, &ELEMENT, &TALK];

pub fn get_definition(name: &ServiceName) -> &'static ServiceDefinition {
    match name {
        ServiceName::Whatsapp => &WHATSAPP,
        ServiceName::Messenger => &MESSENGER,
        ServiceName::Slack => &SLACK,
        ServiceName::Telegram => &TELEGRAM,
        ServiceName::Element => &ELEMENT,
        ServiceName::Talk => &TALK,
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
        }
    }

    #[test]
    fn test_all_services_have_embedded_icons() {
        for service in ALL_SERVICES {
            assert!(!service.app_icon_svg.is_empty());
            assert!(!service.app_icon_png.is_empty());
            assert!(!service.tray_icon_svg.is_empty());
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

        let element = get_definition(&ServiceName::Element);
        assert_eq!(element.name, "element");

        let talk = get_definition(&ServiceName::Talk);
        assert_eq!(talk.name, "talk");
    }
}
