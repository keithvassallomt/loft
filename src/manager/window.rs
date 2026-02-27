use std::cell::Cell;
use std::rc::Rc;

use gtk4::glib;
use gtk4::prelude::*;
use libadwaita::prelude::*;

use crate::chrome;
use crate::config::GlobalConfig;
use crate::config::ServiceConfig;
use crate::desktop;
use crate::service;

/// Build a 32x32 image widget from the service's app icon.
fn service_icon(definition: &service::ServiceDefinition) -> gtk4::Image {
    let icon_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("~/.local/share"))
        .join("loft/icons")
        .join(definition.app_icon_filename);

    let image = if icon_path.exists() {
        gtk4::Image::from_file(&icon_path)
    } else {
        gtk4::Image::from_icon_name("application-x-executable")
    };
    image.set_pixel_size(32);
    image
}

pub fn build_window(app: &libadwaita::Application) {
    // Pre-fetch all service icons on first launch (skips if already present)
    desktop::ensure_icons();

    let content = gtk4::Box::new(gtk4::Orientation::Vertical, 0);

    let header = libadwaita::HeaderBar::new();
    content.append(&header);

    // Check if Chrome is available
    let global_config = GlobalConfig::load().unwrap_or_default();
    if chrome::detect_chrome(&global_config).is_err() {
        show_chrome_not_found(&content);
    } else {
        show_service_list(&content);
    }

    let window = libadwaita::ApplicationWindow::builder()
        .application(app)
        .title("Loft")
        .default_width(500)
        .default_height(400)
        .content(&content)
        .build();

    window.present();
}

fn show_chrome_not_found(content: &gtk4::Box) {
    let status = libadwaita::StatusPage::new();
    status.set_title("Google Chrome Not Found");
    status.set_description(Some(
        "Loft requires Google Chrome for voice and video calling.\n\
         Please install Google Chrome and restart Loft.",
    ));
    status.set_icon_name(Some("dialog-warning-symbolic"));
    status.set_vexpand(true);
    content.append(&status);
}

fn show_service_list(content: &gtk4::Box) {
    let list_box = gtk4::ListBox::new();
    list_box.set_selection_mode(gtk4::SelectionMode::None);
    list_box.add_css_class("boxed-list");

    for definition in service::ALL_SERVICES {
        create_service_row(definition, &list_box);
    }

    let clamp = libadwaita::Clamp::new();
    clamp.set_maximum_size(600);
    clamp.set_child(Some(&list_box));

    let scrolled = gtk4::ScrolledWindow::new();
    scrolled.set_child(Some(&clamp));
    scrolled.set_vexpand(true);
    scrolled.set_margin_top(24);
    scrolled.set_margin_bottom(24);
    scrolled.set_margin_start(12);
    scrolled.set_margin_end(12);
    content.append(&scrolled);
}

/// Append the appropriate row (installed or uninstalled) for a service.
fn create_service_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
) {
    if desktop::is_service_installed(definition) {
        let row = create_installed_row(definition, list_box);
        list_box.append(&row);
    } else {
        let row = create_uninstalled_row(definition, list_box);
        list_box.append(&row);
    }
}

/// Row for an uninstalled service: simple ActionRow with an Install button.
fn create_uninstalled_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
) -> libadwaita::ActionRow {
    let row = libadwaita::ActionRow::new();
    row.set_title(definition.display_name);
    row.set_subtitle(definition.url);
    row.add_prefix(&service_icon(definition));

    let button = gtk4::Button::with_label("Install");
    button.set_valign(gtk4::Align::Center);
    button.add_css_class("suggested-action");

    let list_box = list_box.clone();
    button.connect_clicked(move |btn| {
        match desktop::install_service(definition) {
            Ok(()) => {
                // Replace this row with an installed row
                if let Some(old_row) = btn
                    .ancestor(libadwaita::ActionRow::static_type())
                    .and_then(|w| w.downcast::<libadwaita::ActionRow>().ok())
                {
                    let idx = old_row.index();
                    list_box.remove(&old_row);
                    let new_row = create_installed_row(definition, &list_box);
                    list_box.insert(&new_row, idx);
                }
            }
            Err(e) => tracing::error!("Install failed: {}", e),
        }
    });

    row.add_suffix(&button);
    row
}

/// Row for an installed service: ExpanderRow with settings and Uninstall button.
fn create_installed_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
) -> libadwaita::ExpanderRow {
    let row = libadwaita::ExpanderRow::new();
    row.set_title(definition.display_name);
    row.set_subtitle(definition.url);
    row.add_prefix(&service_icon(definition));

    // Uninstall button as suffix on the header
    let button = gtk4::Button::with_label("Uninstall");
    button.set_valign(gtk4::Align::Center);
    button.add_css_class("destructive-action");

    let list_box_clone = list_box.clone();
    button.connect_clicked(move |btn| {
        show_uninstall_dialog(btn, definition, &list_box_clone);
    });
    row.add_suffix(&button);

    // --- Settings ---

    let config = ServiceConfig::load(&definition.name).unwrap_or_default();

    // Autostart toggle
    let autostart_row = libadwaita::SwitchRow::new();
    autostart_row.set_title("Start at Login");

    // Use a suppression flag to avoid recursive notify when reverting programmatically
    let suppress = Rc::new(Cell::new(false));

    autostart_row.set_active(config.autostart);

    let suppress_clone = suppress.clone();
    autostart_row.connect_active_notify(move |switch| {
        if suppress_clone.get() {
            return;
        }

        let enabled = switch.is_active();
        let switch_clone = switch.clone();
        let suppress_inner = suppress_clone.clone();
        let window = switch
            .root()
            .and_then(|r| r.downcast::<gtk4::Window>().ok());

        glib::spawn_future_local(async move {
            let result =
                crate::autostart::set_autostart(definition, enabled, window.as_ref()).await;

            if let Err(e) = result {
                tracing::error!(
                    "Failed to set autostart for {}: {}",
                    definition.display_name,
                    e
                );
                // Revert the switch without re-triggering the handler
                suppress_inner.set(true);
                switch_clone.set_active(!enabled);
                suppress_inner.set(false);
            }
        });
    });

    row.add_row(&autostart_row);

    // Start Hidden toggle
    let start_hidden_row = libadwaita::SwitchRow::new();
    start_hidden_row.set_title("Start Hidden");
    start_hidden_row.set_subtitle("Start with the window hidden in the tray");
    start_hidden_row.set_active(config.start_hidden);

    start_hidden_row.connect_active_notify(move |switch| {
        let enabled = switch.is_active();
        let cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
        let autostart_enabled = cfg.autostart;

        let mut cfg = cfg;
        cfg.start_hidden = enabled;
        if let Err(e) = cfg.save(&definition.name) {
            tracing::error!("Failed to save start_hidden for {}: {}", definition.display_name, e);
        }

        // Regenerate the autostart entry so it picks up the new setting
        if autostart_enabled {
            let window = switch
                .root()
                .and_then(|r| r.downcast::<gtk4::Window>().ok());
            glib::spawn_future_local(async move {
                if let Err(e) = crate::autostart::set_autostart(definition, true, window.as_ref()).await {
                    tracing::error!("Failed to update autostart for {}: {}", definition.display_name, e);
                }
            });
        }
    });

    row.add_row(&start_hidden_row);

    // Show Loft Titlebar toggle
    let titlebar_row = libadwaita::SwitchRow::new();
    titlebar_row.set_title("Show Loft Titlebar");
    titlebar_row.set_subtitle("In-page toolbar with hide-to-tray button");
    titlebar_row.set_active(config.show_titlebar);

    titlebar_row.connect_active_notify(move |switch| {
        let show = switch.is_active();
        let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
        cfg.show_titlebar = show;
        if let Err(e) = cfg.save(&definition.name) {
            tracing::error!("Failed to save show_titlebar for {}: {}", definition.display_name, e);
        }

        // Update running daemon via D-Bus (fire-and-forget)
        glib::spawn_future_local(async move {
            if let Err(e) = crate::daemon::dbus::call_set_show_titlebar(definition, show).await {
                tracing::debug!("Could not update running daemon titlebar setting: {}", e);
            }
        });
    });

    row.add_row(&titlebar_row);

    row
}

fn show_uninstall_dialog(
    btn: &gtk4::Button,
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
) {
    let window = btn
        .root()
        .and_then(|r| r.downcast::<gtk4::Window>().ok());

    let dialog = libadwaita::AlertDialog::new(
        Some(&format!("Uninstall {}?", definition.display_name)),
        Some("The service will be removed from your desktop."),
    );

    let delete_check = gtk4::CheckButton::with_label("Also delete login data and profile");
    delete_check.set_margin_top(12);
    dialog.set_extra_child(Some(&delete_check));

    dialog.add_response("cancel", "Cancel");
    dialog.add_response("uninstall", "Uninstall");
    dialog.set_response_appearance("uninstall", libadwaita::ResponseAppearance::Destructive);
    dialog.set_default_response(Some("cancel"));
    dialog.set_close_response("cancel");

    let list_box = list_box.clone();
    let btn = btn.clone();
    dialog.connect_response(None, move |_, response| {
        if response != "uninstall" {
            return;
        }
        let delete_data = delete_check.is_active();
        match desktop::uninstall_service(definition, delete_data) {
            Ok(()) => {
                // Replace the ExpanderRow with an uninstalled ActionRow
                if let Some(old_row) = btn
                    .ancestor(libadwaita::ExpanderRow::static_type())
                    .and_then(|w| w.downcast::<libadwaita::ExpanderRow>().ok())
                {
                    let idx = old_row.index();
                    list_box.remove(&old_row);
                    let new_row = create_uninstalled_row(definition, &list_box);
                    list_box.insert(&new_row, idx);
                }
            }
            Err(e) => {
                tracing::error!("Uninstall failed: {}", e);
            }
        }
    });

    dialog.present(window.as_ref());
}
