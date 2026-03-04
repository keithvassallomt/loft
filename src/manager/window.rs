use std::cell::Cell;
use std::rc::Rc;

use gtk4::gio;
use gtk4::glib;
use gtk4::prelude::*;
use libadwaita::prelude::*;

use crate::chrome;
use crate::config::{GlobalConfig, ServiceConfig, TrayBackend};
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

    let window = libadwaita::ApplicationWindow::builder()
        .application(app)
        .title("Loft")
        .default_width(500)
        .default_height(550)
        .build();

    // Setup window actions (preferences, about)
    setup_actions(&window);

    // Check if Chrome is available
    let global_config = GlobalConfig::load().unwrap_or_default();
    if chrome::detect_chrome(&global_config).is_err() {
        show_chrome_not_found(&window);
    } else {
        show_main_content(&window);
    }

    window.present();
}

fn setup_actions(window: &libadwaita::ApplicationWindow) {
    let prefs_action = gio::SimpleAction::new("preferences", None);
    let win = window.clone();
    prefs_action.connect_activate(move |_, _| {
        show_preferences_window(&win);
    });
    window.add_action(&prefs_action);

    let about_action = gio::SimpleAction::new("about", None);
    let win = window.clone();
    about_action.connect_activate(move |_, _| {
        show_about_dialog(&win);
    });
    window.add_action(&about_action);
}

fn create_menu_button() -> gtk4::MenuButton {
    let menu = gio::Menu::new();
    menu.append(Some("Preferences"), Some("win.preferences"));
    menu.append(Some("About Loft"), Some("win.about"));

    let button = gtk4::MenuButton::new();
    button.set_icon_name("open-menu-symbolic");
    button.set_menu_model(Some(&menu));
    button
}

fn show_chrome_not_found(window: &libadwaita::ApplicationWindow) {
    let toolbar_view = libadwaita::ToolbarView::new();
    let header = libadwaita::HeaderBar::new();
    header.pack_end(&create_menu_button());
    toolbar_view.add_top_bar(&header);

    let status = libadwaita::StatusPage::new();
    status.set_title("Google Chrome Not Found");
    status.set_description(Some(
        "Loft requires Google Chrome for voice and video calling.\n\
         Please install Google Chrome and restart Loft.",
    ));
    status.set_icon_name(Some("dialog-warning-symbolic"));
    status.set_vexpand(true);
    toolbar_view.set_content(Some(&status));

    window.set_content(Some(&toolbar_view));
}

fn show_main_content(window: &libadwaita::ApplicationWindow) {
    let nav_view = libadwaita::NavigationView::new();
    let main_page = create_main_page(&nav_view);
    nav_view.add(&main_page);
    window.set_content(Some(&nav_view));
}

fn create_main_page(nav_view: &libadwaita::NavigationView) -> libadwaita::NavigationPage {
    let toolbar_view = libadwaita::ToolbarView::new();
    let header = libadwaita::HeaderBar::new();
    header.pack_end(&create_menu_button());
    toolbar_view.add_top_bar(&header);

    let scrolled = gtk4::ScrolledWindow::new();
    scrolled.set_vexpand(true);

    let clamp = libadwaita::Clamp::new();
    clamp.set_maximum_size(600);
    clamp.set_margin_top(24);
    clamp.set_margin_bottom(24);
    clamp.set_margin_start(12);
    clamp.set_margin_end(12);

    let group = libadwaita::PreferencesGroup::new();

    let list_box = gtk4::ListBox::new();
    list_box.set_selection_mode(gtk4::SelectionMode::None);
    list_box.add_css_class("boxed-list");

    for definition in service::ALL_SERVICES {
        create_service_row(definition, &list_box, nav_view);
    }

    group.add(&list_box);
    clamp.set_child(Some(&group));
    scrolled.set_child(Some(&clamp));
    toolbar_view.set_content(Some(&scrolled));

    libadwaita::NavigationPage::new(&toolbar_view, "Loft")
}

/// Append the appropriate row (installed or uninstalled) for a service.
fn create_service_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
    nav_view: &libadwaita::NavigationView,
) {
    if desktop::is_service_installed(definition) {
        let row = create_installed_row(definition, list_box, nav_view);
        list_box.append(&row);
    } else {
        let row = create_uninstalled_row(definition, list_box, nav_view);
        list_box.append(&row);
    }
}

/// Row for an installed service: clickable ActionRow that navigates to a detail page.
fn create_installed_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
    nav_view: &libadwaita::NavigationView,
) -> libadwaita::ActionRow {
    let row = libadwaita::ActionRow::new();
    row.set_title(definition.display_name);
    row.add_prefix(&service_icon(definition));
    row.set_activatable(true);

    let chevron = gtk4::Image::from_icon_name("go-next-symbolic");
    row.add_suffix(&chevron);

    let nav = nav_view.clone();
    let lb = list_box.clone();
    row.connect_activated(move |_| {
        let detail_page = create_detail_page(definition, &nav, &lb);
        nav.push(&detail_page);
    });

    row
}

/// Row for an uninstalled service: ActionRow with an Install button.
fn create_uninstalled_row(
    definition: &'static service::ServiceDefinition,
    list_box: &gtk4::ListBox,
    nav_view: &libadwaita::NavigationView,
) -> libadwaita::ActionRow {
    let row = libadwaita::ActionRow::new();
    row.set_title(definition.display_name);
    row.add_prefix(&service_icon(definition));

    let button = gtk4::Button::with_label("Install");
    button.set_valign(gtk4::Align::Center);
    button.add_css_class("suggested-action");

    let lb = list_box.clone();
    let nv = nav_view.clone();
    button.connect_clicked(move |btn| {
        match desktop::install_service(definition) {
            Ok(()) => {
                if let Some(old_row) = btn
                    .ancestor(libadwaita::ActionRow::static_type())
                    .and_then(|w| w.downcast::<libadwaita::ActionRow>().ok())
                {
                    let idx = old_row.index();
                    lb.remove(&old_row);
                    let new_row = create_installed_row(definition, &lb, &nv);
                    lb.insert(&new_row, idx);
                }
            }
            Err(e) => tracing::error!("Install failed: {}", e),
        }
    });

    row.add_suffix(&button);
    row
}

/// Detail page for an installed service with settings and uninstall.
fn create_detail_page(
    definition: &'static service::ServiceDefinition,
    nav_view: &libadwaita::NavigationView,
    list_box: &gtk4::ListBox,
) -> libadwaita::NavigationPage {
    let toolbar_view = libadwaita::ToolbarView::new();
    let header = libadwaita::HeaderBar::new();
    toolbar_view.add_top_bar(&header);

    let scrolled = gtk4::ScrolledWindow::new();
    scrolled.set_vexpand(true);

    let clamp = libadwaita::Clamp::new();
    clamp.set_maximum_size(600);
    clamp.set_margin_top(24);
    clamp.set_margin_bottom(24);
    clamp.set_margin_start(12);
    clamp.set_margin_end(12);

    let outer = gtk4::Box::new(gtk4::Orientation::Vertical, 24);

    // --- Startup group ---
    let startup_group = libadwaita::PreferencesGroup::new();
    startup_group.set_title("Startup");

    let config = ServiceConfig::load(&definition.name).unwrap_or_default();

    // Autostart toggle
    let autostart_row = libadwaita::SwitchRow::new();
    autostart_row.set_title("Start at Login");

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
                suppress_inner.set(true);
                switch_clone.set_active(!enabled);
                suppress_inner.set(false);
            }
        });
    });

    startup_group.add(&autostart_row);

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
            tracing::error!(
                "Failed to save start_hidden for {}: {}",
                definition.display_name,
                e
            );
        }

        // Regenerate the autostart entry so it picks up the new setting
        if autostart_enabled {
            let window = switch
                .root()
                .and_then(|r| r.downcast::<gtk4::Window>().ok());
            glib::spawn_future_local(async move {
                if let Err(e) =
                    crate::autostart::set_autostart(definition, true, window.as_ref()).await
                {
                    tracing::error!(
                        "Failed to update autostart for {}: {}",
                        definition.display_name,
                        e
                    );
                }
            });
        }
    });

    startup_group.add(&start_hidden_row);
    outer.append(&startup_group);

    // --- Appearance group ---
    let appearance_group = libadwaita::PreferencesGroup::new();
    appearance_group.set_title("Appearance");

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
            tracing::error!(
                "Failed to save show_titlebar for {}: {}",
                definition.display_name,
                e
            );
        }

        // Update running daemon via D-Bus (fire-and-forget)
        glib::spawn_future_local(async move {
            if let Err(e) = crate::daemon::dbus::call_set_show_titlebar(definition, show).await {
                tracing::debug!("Could not update running daemon titlebar setting: {}", e);
            }
        });
    });

    appearance_group.add(&titlebar_row);

    // Show Badges toggle
    let badges_row = libadwaita::SwitchRow::new();
    badges_row.set_title("Show Badges");
    badges_row.set_subtitle("Display unread message indicator on tray icon");
    badges_row.set_active(config.badges_enabled);

    badges_row.connect_active_notify(move |switch| {
        let enabled = switch.is_active();
        let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
        cfg.badges_enabled = enabled;
        if let Err(e) = cfg.save(&definition.name) {
            tracing::error!(
                "Failed to save badges_enabled for {}: {}",
                definition.display_name,
                e
            );
        }

        // Update running daemon via D-Bus (fire-and-forget)
        glib::spawn_future_local(async move {
            if let Err(e) =
                crate::daemon::dbus::call_set_badges_enabled(definition, enabled).await
            {
                tracing::debug!("Could not update running daemon badges setting: {}", e);
            }
        });
    });

    appearance_group.add(&badges_row);
    outer.append(&appearance_group);

    // --- Uninstall button ---
    let uninstall_button = gtk4::Button::with_label("Uninstall\u{2026}");
    uninstall_button.add_css_class("destructive-action");
    uninstall_button.add_css_class("pill");
    uninstall_button.set_halign(gtk4::Align::Center);
    uninstall_button.set_margin_top(12);

    let nav = nav_view.clone();
    let lb = list_box.clone();
    uninstall_button.connect_clicked(move |btn| {
        show_uninstall_dialog(btn, definition, &nav, &lb);
    });

    outer.append(&uninstall_button);

    clamp.set_child(Some(&outer));
    scrolled.set_child(Some(&clamp));
    toolbar_view.set_content(Some(&scrolled));

    libadwaita::NavigationPage::new(&toolbar_view, definition.display_name)
}

fn show_uninstall_dialog(
    btn: &gtk4::Button,
    definition: &'static service::ServiceDefinition,
    nav_view: &libadwaita::NavigationView,
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

    let nav = nav_view.clone();
    let lb = list_box.clone();
    dialog.connect_response(None, move |_, response| {
        if response != "uninstall" {
            return;
        }
        let delete_data = delete_check.is_active();
        match desktop::uninstall_service(definition, delete_data) {
            Ok(()) => {
                // Pop back to main page
                nav.pop();
                // Find and replace the row for this service
                let mut idx = 0;
                while let Some(row) = lb.row_at_index(idx) {
                    if let Ok(action_row) = row.clone().downcast::<libadwaita::ActionRow>() {
                        if action_row.title() == definition.display_name {
                            let i = action_row.index();
                            lb.remove(&action_row);
                            let new_row = create_uninstalled_row(definition, &lb, &nav);
                            lb.insert(&new_row, i);
                            break;
                        }
                    }
                    idx += 1;
                }
            }
            Err(e) => {
                tracing::error!("Uninstall failed: {}", e);
            }
        }
    });

    dialog.present(window.as_ref());
}

fn show_preferences_window(parent: &libadwaita::ApplicationWindow) {
    let prefs_window = libadwaita::PreferencesWindow::new();
    prefs_window.set_transient_for(Some(parent));
    prefs_window.set_modal(true);
    prefs_window.set_search_enabled(false);

    let page = libadwaita::PreferencesPage::new();
    page.set_title("General");
    page.set_icon_name(Some("preferences-system-symbolic"));

    let group = libadwaita::PreferencesGroup::new();

    let global_config = GlobalConfig::load().unwrap_or_default();

    // Tray backend combo
    let tray_combo = libadwaita::ComboRow::new();
    tray_combo.set_title("Tray Icon Backend");
    tray_combo.set_subtitle("Panel icons require the Loft Shell Helper GNOME extension");
    let model = gtk4::StringList::new(&[
        "Auto (recommended)",
        "GNOME Panel",
        "System Tray (SNI)",
    ]);
    tray_combo.set_model(Some(&model));
    tray_combo.set_selected(match global_config.tray_backend {
        TrayBackend::Auto => 0,
        TrayBackend::GnomePanel => 1,
        TrayBackend::Sni => 2,
    });

    tray_combo.connect_selected_notify(move |combo| {
        let backend = match combo.selected() {
            1 => TrayBackend::GnomePanel,
            2 => TrayBackend::Sni,
            _ => TrayBackend::Auto,
        };
        let mut config = GlobalConfig::load().unwrap_or_default();
        config.tray_backend = backend;
        if let Err(e) = config.save() {
            tracing::error!("Failed to save tray backend setting: {}", e);
        }
    });

    group.add(&tray_combo);

    // Combine tray icons toggle
    let combine_row = libadwaita::SwitchRow::new();
    combine_row.set_title("Combine Tray Icons");
    combine_row.set_subtitle("Show a single Loft icon instead of per-service icons");
    combine_row.set_active(global_config.combine_tray_icons);

    combine_row.connect_active_notify(move |switch| {
        let enabled = switch.is_active();
        let mut config = GlobalConfig::load().unwrap_or_default();
        config.combine_tray_icons = enabled;
        if let Err(e) = config.save() {
            tracing::error!("Failed to save combine tray setting: {}", e);
        }

        // Run D-Bus calls on a dedicated thread with its own tokio runtime,
        // since the manager runs on the GLib main loop (no tokio runtime).
        std::thread::spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::error!("Failed to create tokio runtime for tray toggle: {}", e);
                    return;
                }
            };
            rt.block_on(async move {
                emit_combine_tray_changed(enabled).await;
                if enabled {
                    if let Err(e) = spawn_combined_tray_if_needed().await {
                        tracing::error!("Failed to spawn combined tray: {}", e);
                    }
                } else {
                    let _ = call_combined_tray_quit().await;
                }
            });
        });
    });

    group.add(&combine_row);

    // Chrome path selector
    let detected_chromes = chrome::detect_all_chrome();
    let chrome_combo = libadwaita::ComboRow::new();
    chrome_combo.set_title("Chrome Path");

    let mut chrome_labels: Vec<String> = detected_chromes
        .iter()
        .map(|c| c.display_name.clone())
        .collect();
    chrome_labels.push("Custom\u{2026}".to_string());
    let chrome_model = gtk4::StringList::new(
        &chrome_labels.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    );
    chrome_combo.set_model(Some(&chrome_model));

    let custom_index = detected_chromes.len() as u32;
    let initial_index = if let Some(ref configured) = global_config.chrome_path {
        detected_chromes
            .iter()
            .position(|c| c.path == *configured)
            .map(|i| i as u32)
            .unwrap_or(custom_index)
    } else {
        0
    };
    chrome_combo.set_selected(initial_index);

    let initial_subtitle = if initial_index < custom_index {
        detected_chromes[initial_index as usize].path.clone()
    } else if let Some(ref p) = global_config.chrome_path {
        p.clone()
    } else {
        String::new()
    };
    chrome_combo.set_subtitle(&initial_subtitle);

    let chrome_paths: Vec<String> = detected_chromes.iter().map(|c| c.path.clone()).collect();

    chrome_combo.connect_selected_notify(move |combo| {
        let selected = combo.selected();
        if selected < custom_index {
            let path = &chrome_paths[selected as usize];
            combo.set_subtitle(path);
            let mut config = GlobalConfig::load().unwrap_or_default();
            if selected == 0 {
                config.chrome_path = None;
            } else {
                config.chrome_path = Some(path.clone());
            }
            if let Err(e) = config.save() {
                tracing::error!("Failed to save Chrome path setting: {}", e);
            }
        } else {
            let combo_clone = combo.clone();
            let dialog = gtk4::FileDialog::new();
            dialog.set_title("Select Chrome Binary");

            let initial_folder = gio::File::for_path("/usr/bin");
            dialog.set_initial_folder(Some(&initial_folder));

            let window = combo
                .root()
                .and_then(|r| r.downcast::<gtk4::Window>().ok());

            dialog.open(window.as_ref(), gio::Cancellable::NONE, move |result| {
                match result {
                    Ok(file) => {
                        if let Some(path) = file.path() {
                            let path_str = path.to_string_lossy().to_string();
                            combo_clone.set_subtitle(&path_str);
                            let mut config = GlobalConfig::load().unwrap_or_default();
                            config.chrome_path = Some(path_str);
                            if let Err(e) = config.save() {
                                tracing::error!("Failed to save Chrome path: {}", e);
                            }
                        }
                    }
                    Err(_) => {
                        // User cancelled — keep current selection
                    }
                }
            });
        }
    });

    group.add(&chrome_combo);

    page.add(&group);
    prefs_window.add(&page);
    prefs_window.present();
}

/// Emit the `CombineTrayChanged` D-Bus signal on the session bus.
/// Both service daemons and the combined tray process listen for this.
async fn emit_combine_tray_changed(enabled: bool) {
    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Failed to connect to session bus: {}", e);
            return;
        }
    };
    if let Err(e) = conn
        .emit_signal(
            Option::<zbus::names::BusName>::None,
            "/chat/loft/Tray",
            "chat.loft.Tray",
            "CombineTrayChanged",
            &(enabled,),
        )
        .await
    {
        tracing::error!("Failed to emit CombineTrayChanged signal: {}", e);
    }
}

/// Spawn the combined tray process if it's not already running.
async fn spawn_combined_tray_if_needed() -> anyhow::Result<()> {
    // Check if already running
    let conn = zbus::Connection::session().await?;
    let dbus = zbus::fdo::DBusProxy::new(&conn).await?;
    let name = zbus::names::BusName::try_from("chat.loft.Tray")
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    if dbus.name_has_owner(name).await.unwrap_or(false) {
        return Ok(());
    }

    let exe = std::env::current_exe()?;
    std::process::Command::new(exe)
        .arg("--tray")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(())
}

/// Tell the combined tray process to quit via D-Bus.
async fn call_combined_tray_quit() -> anyhow::Result<()> {
    let conn = zbus::Connection::session().await?;
    conn.call_method(
        Some(zbus::names::BusName::try_from("chat.loft.Tray")
            .map_err(|e| anyhow::anyhow!("{}", e))?),
        zbus::zvariant::ObjectPath::try_from("/chat/loft/Tray")
            .map_err(|e| anyhow::anyhow!("{}", e))?,
        Some(zbus::names::InterfaceName::try_from("chat.loft.Tray")
            .map_err(|e| anyhow::anyhow!("{}", e))?),
        "Quit",
        &(),
    )
    .await?;
    Ok(())
}

fn show_about_dialog(parent: &libadwaita::ApplicationWindow) {
    let dialog = libadwaita::AboutDialog::builder()
        .application_name("Loft")
        .developer_name("Keith Vassallo")
        .version(env!("CARGO_PKG_VERSION"))
        .website("https://github.com/keithvassallomt/loft")
        .issue_url("https://github.com/keithvassallomt/loft/issues")
        .license_type(gtk4::License::Gpl30)
        .comments("Desktop integration for Meta web apps on Linux")
        .build();

    dialog.present(Some(parent));
}
