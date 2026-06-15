use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk4::gio;
use gtk4::glib;
use gtk4::prelude::*;
use libadwaita::prelude::*;

use crate::chrome;
use crate::config::{GlobalConfig, ServiceConfig, TrayBackend};
use crate::desktop;
use crate::service;

/// Build an image widget from the service's app icon at the given pixel size.
fn service_icon_sized(definition: &service::ServiceDefinition, size: i32) -> gtk4::Image {
    let icon_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("~/.local/share"))
        .join("loft/icons")
        .join(definition.app_icon_filename);

    let image = if icon_path.exists() {
        gtk4::Image::from_file(&icon_path)
    } else {
        gtk4::Image::from_icon_name("application-x-executable")
    };
    image.set_pixel_size(size);
    image
}

/// Build a 32x32 image widget from the service's app icon.
fn service_icon(definition: &service::ServiceDefinition) -> gtk4::Image {
    service_icon_sized(definition, 32)
}

/// Install the small amount of custom CSS the redesigned manager needs
/// (an unread-count badge pill and tile padding). Adwaita has no badge widget,
/// so we style a plain label with the accent colour.
fn install_css() {
    let provider = gtk4::CssProvider::new();
    provider.load_from_data(
        ".loft-badge { \
            background-color: @accent_bg_color; \
            color: @accent_fg_color; \
            border-radius: 9999px; \
            padding: 0 7px; \
            font-weight: bold; \
            font-size: 0.8em; \
            min-width: 12px; \
        } \
        .loft-tile { padding: 16px; }",
    );
    if let Some(display) = gtk4::gdk::Display::default() {
        gtk4::style_context_add_provider_for_display(
            &display,
            &provider,
            gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }
}

/// Launch (or focus) a service. Spawns `loft --service <name>`; the daemon's
/// singleton enforcement turns this into a `Show()` on the running instance, or
/// starts a fresh daemon if none is running. This is the universal "open".
fn launch_service(definition: &service::ServiceDefinition) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Could not determine loft binary path: {}", e);
            return;
        }
    };
    if let Err(e) = std::process::Command::new(exe)
        .arg("--service")
        .arg(definition.name)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        tracing::error!("Failed to launch service {}: {}", definition.name, e);
    }
}

/// Query running status for the given services and return a map from service
/// name to `(visible, badge, dnd)` for those whose daemon responded. Runs on a
/// dedicated tokio-runtime thread because the manager's GLib main loop has no
/// tokio runtime (zbus's async path would panic there). Services whose daemon
/// isn't running are simply absent from the map.
fn query_statuses(
    defs: &[&'static service::ServiceDefinition],
) -> HashMap<&'static str, (bool, u32, bool)> {
    if defs.is_empty() {
        return HashMap::new();
    }
    let defs: Vec<&'static service::ServiceDefinition> = defs.to_vec();
    let handle = std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                tracing::error!("Failed to create tokio runtime for status query: {}", e);
                return HashMap::new();
            }
        };
        rt.block_on(crate::daemon::dbus::get_statuses(&defs))
    });
    handle.join().unwrap_or_default()
}

/// Reflect a service's status onto its installed-row widgets. `None` means the
/// daemon isn't running.
fn apply_status(
    row: &libadwaita::ActionRow,
    badge: &gtk4::Label,
    status: Option<(bool, u32, bool)>,
) {
    match status {
        Some((_visible, count, _dnd)) => {
            row.set_subtitle("Running");
            if count > 0 {
                badge.set_text(&count.to_string());
                badge.set_visible(true);
            } else {
                badge.set_visible(false);
            }
        }
        None => {
            row.set_subtitle("Not running");
            badge.set_visible(false);
        }
    }
}

pub fn build_window(app: &libadwaita::Application) {
    // Deploy all service icons from embedded assets (instant, no network)
    desktop::ensure_icons();
    // Register the manager's custom CSS (badge pill, tile padding)
    install_css();

    let window = libadwaita::ApplicationWindow::builder()
        .application(app)
        .title("Loft")
        .icon_name("loft")
        // Width is fixed; height is intentionally left unset so the window sizes
        // to its content's natural height (see `propagate_natural_height` on the
        // scroller). The scrollbar is the fallback when content exceeds the
        // screen (e.g. the fresh-install 6-tile grid).
        .default_width(500)
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

    // On GNOME, check if the shell extension is installed
    if !global_config.skip_extension_prompt && is_gnome() {
        check_gnome_extension(&window);
    }

    window.present();
}

/// Returns true if the current desktop is GNOME.
fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .any(|d| d.eq_ignore_ascii_case("GNOME"))
}

/// Tell the user to log out and back in for the Loft Shell Helper to load.
/// Shown after Loft (re)deploys the bundled extension, since GNOME Shell only
/// loads new extension JS at session start.
fn show_relogin_dialog(window: Option<&libadwaita::ApplicationWindow>) {
    let dialog = libadwaita::AlertDialog::new(
        Some("Log Out to Finish Setup"),
        Some(
            "Loft installed (or updated) its GNOME Shell integration. Log out and \
             back in for window management — show/hide, panel icons, and overview \
             handling — to work correctly.",
        ),
    );
    dialog.add_response("ok", "Got It");
    dialog.set_default_response(Some("ok"));
    dialog.set_close_response("ok");
    dialog.present(window);
}

/// Check whether the Loft Shell Helper GNOME extension is installed.
/// If not, show a dialog offering to install it from EGO.
fn check_gnome_extension(window: &libadwaita::ApplicationWindow) {
    // Check the host filesystem (bypasses Flatpak path remapping)
    let ext_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("~"))
        .join(".local/share/gnome-shell/extensions/loft-shell-helper@loft.chat");

    if ext_dir.exists() {
        return;
    }

    // Also check via gnome-extensions CLI on the host
    if let Ok(output) = chrome::host_command("gnome-extensions")
        .args(["info", "loft-shell-helper@loft.chat"])
        .output()
    {
        if output.status.success() {
            return;
        }
    }

    let dialog = libadwaita::AlertDialog::new(
        Some("Install Loft Shell Helper?"),
        Some(
            "The Loft Shell Helper GNOME extension provides native window management \
             and panel icons. Without it, Loft will fall back to system tray (SNI) icons.",
        ),
    );

    let dont_ask = gtk4::CheckButton::with_label("Don\u{2019}t ask me again");
    dont_ask.set_margin_top(12);
    dialog.set_extra_child(Some(&dont_ask));

    dialog.add_response("skip", "Do Not Install");
    dialog.add_response("install", "Install");
    dialog.set_response_appearance("install", libadwaita::ResponseAppearance::Suggested);
    dialog.set_default_response(Some("install"));
    dialog.set_close_response("skip");

    dialog.connect_response(None, move |_, response| {
        if dont_ask.is_active() {
            let mut config = GlobalConfig::load().unwrap_or_default();
            config.skip_extension_prompt = true;
            if let Err(e) = config.save() {
                tracing::error!("Failed to save skip_extension_prompt: {}", e);
            }
        }

        if response == "install" {
            let _ = gtk4::UriLauncher::new(
                "https://extensions.gnome.org/extension/9647/loft-shell-helper/",
            )
            .launch(gtk4::Window::NONE, gio::Cancellable::NONE, |_| {});
        }
    });

    dialog.present(Some(window));
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
    let main_page = ManagerUi::build_main_page(&nav_view);
    nav_view.add(&main_page);
    window.set_content(Some(&nav_view));
}

/// The status-bearing widgets of one installed row, kept so the periodic
/// running-status poll can update them in place (no row rebuild → no flicker).
struct RowWidgets {
    row: libadwaita::ActionRow,
    badge: gtk4::Label,
}

/// Holds the widgets that make up the main page so install/uninstall actions can
/// repopulate both sections (moving a service between Installed and Available)
/// and toggle the empty states, without surgical per-row mutation.
struct ManagerUi {
    nav_view: libadwaita::NavigationView,
    welcome: gtk4::Widget,
    installed_group: libadwaita::PreferencesGroup,
    installed_list: gtk4::ListBox,
    available_group: libadwaita::PreferencesGroup,
    available_flow: gtk4::FlowBox,
    /// Installed-row widgets keyed by service name, for live status updates.
    rows: RefCell<HashMap<&'static str, RowWidgets>>,
}

impl ManagerUi {
    fn build_main_page(nav_view: &libadwaita::NavigationView) -> libadwaita::NavigationPage {
        let toolbar_view = libadwaita::ToolbarView::new();
        let header = libadwaita::HeaderBar::new();
        header.pack_end(&create_menu_button());
        toolbar_view.add_top_bar(&header);

        let scrolled = gtk4::ScrolledWindow::new();
        scrolled.set_vexpand(true);
        // Request the content's full natural height so the window can size to fit
        // it (no clipping); the scrollbar is the fallback for the tall cases.
        scrolled.set_propagate_natural_height(true);

        let clamp = libadwaita::Clamp::new();
        clamp.set_maximum_size(600);
        clamp.set_margin_top(24);
        clamp.set_margin_bottom(24);
        clamp.set_margin_start(12);
        clamp.set_margin_end(12);

        let outer = gtk4::Box::new(gtk4::Orientation::Vertical, 24);

        // --- Welcome empty-state (shown only when nothing is installed) ---
        let welcome = gtk4::Box::new(gtk4::Orientation::Vertical, 6);
        welcome.set_halign(gtk4::Align::Center);
        welcome.set_margin_top(24);
        welcome.set_margin_bottom(12);
        let welcome_icon = gtk4::Image::from_icon_name("chat.loft.Loft");
        welcome_icon.set_pixel_size(64);
        let welcome_title = gtk4::Label::new(Some("Welcome to Loft"));
        welcome_title.add_css_class("title-2");
        let welcome_sub = gtk4::Label::new(Some("Add a messaging service below to get started."));
        welcome_sub.add_css_class("dim-label");
        welcome_sub.set_wrap(true);
        welcome_sub.set_justify(gtk4::Justification::Center);
        welcome.append(&welcome_icon);
        welcome.append(&welcome_title);
        welcome.append(&welcome_sub);
        outer.append(&welcome);

        // --- Installed group: status list ---
        let installed_group = libadwaita::PreferencesGroup::new();
        installed_group.set_title("Installed");
        let installed_list = gtk4::ListBox::new();
        installed_list.set_selection_mode(gtk4::SelectionMode::None);
        installed_list.add_css_class("boxed-list");
        installed_group.add(&installed_list);
        outer.append(&installed_group);

        // --- Available group: reflowing grid of tiles ---
        let available_group = libadwaita::PreferencesGroup::new();
        available_group.set_title("Available");
        let available_flow = gtk4::FlowBox::new();
        available_flow.set_selection_mode(gtk4::SelectionMode::None);
        available_flow.set_homogeneous(true);
        available_flow.set_min_children_per_line(2);
        available_flow.set_max_children_per_line(2);
        available_flow.set_column_spacing(12);
        available_flow.set_row_spacing(12);
        available_group.add(&available_flow);
        outer.append(&available_group);

        clamp.set_child(Some(&outer));
        scrolled.set_child(Some(&clamp));
        toolbar_view.set_content(Some(&scrolled));

        let ui = Rc::new(ManagerUi {
            nav_view: nav_view.clone(),
            welcome: welcome.upcast(),
            installed_group,
            installed_list,
            available_group,
            available_flow,
            rows: RefCell::new(HashMap::new()),
        });
        ui.populate();

        // Poll running status while the window is open so rows flip
        // Running/Not-running and badges update as daemons start, stop, or
        // receive messages. The timer holds a weak ref and stops itself once the
        // UI is gone (all rows/tiles — which hold the strong refs — destroyed).
        let ui_weak = Rc::downgrade(&ui);
        glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            match ui_weak.upgrade() {
                Some(ui) => {
                    ui.refresh_running_status();
                    glib::ControlFlow::Continue
                }
                None => glib::ControlFlow::Break,
            }
        });

        libadwaita::NavigationPage::new(&toolbar_view, "Loft")
    }

    /// Clear and rebuild both sections from the current install state, toggling
    /// the welcome / Available-group visibility for the empty cases.
    fn populate(self: &Rc<Self>) {
        self.rows.borrow_mut().clear();
        while let Some(child) = self.installed_list.first_child() {
            self.installed_list.remove(&child);
        }
        while let Some(child) = self.available_flow.first_child() {
            self.available_flow.remove(&child);
        }

        let installed_defs: Vec<&'static service::ServiceDefinition> = service::ALL_SERVICES
            .iter()
            .copied()
            .filter(|d| desktop::is_service_installed(d))
            .collect();
        let statuses = query_statuses(&installed_defs);

        let mut installed = 0u32;
        let mut available = 0u32;
        for definition in service::ALL_SERVICES {
            if desktop::is_service_installed(definition) {
                installed += 1;
                let status = statuses.get(definition.name).copied();
                let row = self.build_installed_row(definition, status);
                self.installed_list.append(&row);
            } else {
                available += 1;
                let tile = self.build_available_tile(definition);
                self.available_flow.insert(&tile, -1);
            }
        }

        // Empty states: welcome replaces an empty Installed list; an empty
        // Available group is hidden entirely.
        self.welcome.set_visible(installed == 0);
        self.installed_group.set_visible(installed > 0);
        self.available_group.set_visible(available > 0);
    }

    /// Re-query the running status of every installed service and update its row
    /// widgets in place. Called on a timer and shortly after an `Open` click.
    fn refresh_running_status(self: &Rc<Self>) {
        let rows = self.rows.borrow();
        if rows.is_empty() {
            return;
        }
        let defs: Vec<&'static service::ServiceDefinition> = service::ALL_SERVICES
            .iter()
            .copied()
            .filter(|d| rows.contains_key(d.name))
            .collect();
        let statuses = query_statuses(&defs);
        for (name, widgets) in rows.iter() {
            apply_status(&widgets.row, &widgets.badge, statuses.get(name).copied());
        }
    }

    /// Installed row: app + status, with a separate `Open` button (launch/focus)
    /// and a gear button (settings) so the two intents don't share one target.
    fn build_installed_row(
        self: &Rc<Self>,
        definition: &'static service::ServiceDefinition,
        status: Option<(bool, u32, bool)>,
    ) -> libadwaita::ActionRow {
        let row = libadwaita::ActionRow::new();
        row.set_title(definition.display_name);
        row.add_prefix(&service_icon(definition));

        let suffix = gtk4::Box::new(gtk4::Orientation::Horizontal, 6);
        suffix.set_valign(gtk4::Align::Center);

        let badge = gtk4::Label::new(None);
        badge.add_css_class("loft-badge");
        badge.set_valign(gtk4::Align::Center);
        badge.set_visible(false);

        let open = gtk4::Button::with_label("Open");
        open.add_css_class("suggested-action");
        open.set_valign(gtk4::Align::Center);
        open.set_tooltip_text(Some(&format!("Open {}", definition.display_name)));
        let ui = self.clone();
        open.connect_clicked(move |_| {
            launch_service(definition);
            // Reflect the new running state promptly rather than waiting for the
            // next poll tick (the daemon needs a moment to claim its bus name).
            let ui = ui.clone();
            glib::timeout_add_local_once(std::time::Duration::from_millis(1200), move || {
                ui.refresh_running_status();
            });
        });

        let gear = gtk4::Button::from_icon_name("emblem-system-symbolic");
        gear.add_css_class("flat");
        gear.set_valign(gtk4::Align::Center);
        gear.set_tooltip_text(Some("Settings"));
        let ui = self.clone();
        gear.connect_clicked(move |_| {
            let page = ui.create_detail_page(definition);
            ui.nav_view.push(&page);
        });

        suffix.append(&badge);
        suffix.append(&open);
        suffix.append(&gear);
        row.add_suffix(&suffix);

        // Reflect the pre-fetched status, and register the widgets so the
        // periodic poll can update them in place.
        apply_status(&row, &badge, status);
        self.rows.borrow_mut().insert(
            definition.name,
            RowWidgets {
                row: row.clone(),
                badge: badge.clone(),
            },
        );

        row
    }

    /// Available tile: icon-forward card with an inline `Add` button. Returned as
    /// an explicit `FlowBoxChild` so the grid keeps consistent cells.
    fn build_available_tile(
        self: &Rc<Self>,
        definition: &'static service::ServiceDefinition,
    ) -> gtk4::FlowBoxChild {
        let card = gtk4::Box::new(gtk4::Orientation::Vertical, 8);
        card.add_css_class("card");
        card.add_css_class("loft-tile");

        let icon = service_icon_sized(definition, 48);
        icon.set_halign(gtk4::Align::Center);

        let name = gtk4::Label::new(Some(definition.display_name));
        name.add_css_class("heading");
        name.set_halign(gtk4::Align::Center);
        name.set_wrap(true);
        name.set_justify(gtk4::Justification::Center);

        let add = gtk4::Button::with_label("Add");
        add.add_css_class("suggested-action");
        add.add_css_class("pill");
        add.set_halign(gtk4::Align::Center);
        let ui = self.clone();
        add.connect_clicked(move |btn| {
            // NextCloud Talk has no default server, so prompt for the instance
            // URL up front rather than installing a broken service.
            if definition.name == "talk" {
                ui.prompt_talk_url_then_install(btn, definition);
            } else {
                ui.install(btn, definition);
            }
        });

        card.append(&icon);
        card.append(&name);
        card.append(&add);

        let child = gtk4::FlowBoxChild::new();
        child.set_child(Some(&card));
        child
    }

    /// Perform the install and rebuild both sections.
    fn install(self: &Rc<Self>, btn: &gtk4::Button, definition: &'static service::ServiceDefinition) {
        match desktop::install_service(definition) {
            Ok(helper_deployed) => {
                self.populate();
                // GNOME loads new extension JS only at session start.
                if helper_deployed && is_gnome() {
                    let window = btn
                        .root()
                        .and_then(|r| r.downcast::<libadwaita::ApplicationWindow>().ok());
                    show_relogin_dialog(window.as_ref());
                }
            }
            Err(e) => tracing::error!("Install failed: {}", e),
        }
    }

    /// Prompt for the NextCloud server URL, then install Talk with it. The URL is
    /// saved after `install_service` (which writes a default config) and the
    /// extension is re-deployed so its manifest is templated with the instance
    /// origin.
    fn prompt_talk_url_then_install(
        self: &Rc<Self>,
        btn: &gtk4::Button,
        definition: &'static service::ServiceDefinition,
    ) {
        let window = btn
            .root()
            .and_then(|r| r.downcast::<libadwaita::ApplicationWindow>().ok());

        let dialog = libadwaita::AlertDialog::new(
            Some("NextCloud Server"),
            Some(
                "Enter the address of your NextCloud server (e.g. cloud.example.com). \
                 Loft adds the Talk path for you.",
            ),
        );

        let entry = gtk4::Entry::new();
        entry.set_placeholder_text(Some("cloud.example.com"));
        entry.set_hexpand(true);
        entry.set_margin_top(12);
        entry.set_activates_default(true);
        if let Some(existing) = ServiceConfig::load(&definition.name)
            .ok()
            .and_then(|c| c.custom_url)
        {
            entry.set_text(&existing);
        }
        dialog.set_extra_child(Some(&entry));

        dialog.add_response("cancel", "Cancel");
        dialog.add_response("install", "Install");
        dialog.set_response_appearance("install", libadwaita::ResponseAppearance::Suggested);
        dialog.set_default_response(Some("install"));
        dialog.set_close_response("cancel");

        // Keep Install disabled until the user has typed something.
        dialog.set_response_enabled("install", !entry.text().trim().is_empty());
        let dlg = dialog.clone();
        entry.connect_changed(move |e| {
            dlg.set_response_enabled("install", !e.text().trim().is_empty());
        });

        let ui = self.clone();
        let btn = btn.clone();
        dialog.connect_response(None, move |_, response| {
            if response != "install" {
                return;
            }
            let Some(url) = normalize_talk_url(&entry.text()) else {
                return;
            };
            ui.install(&btn, definition);
            // Persist the URL and re-template the extension with its origin.
            let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
            cfg.custom_url = Some(url);
            if let Err(e) = cfg.save(&definition.name) {
                tracing::error!("Failed to save NextCloud Talk URL: {}", e);
                return;
            }
            if let Err(e) = desktop::deploy_extension() {
                tracing::error!("Failed to re-deploy extension after Talk install: {}", e);
            }
        });

        dialog.present(window.as_ref());
    }

    /// Detail page for an installed service with settings and uninstall.
    fn create_detail_page(
        self: &Rc<Self>,
        definition: &'static service::ServiceDefinition,
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

        // Start Hidden toggle (created before autostart handler so it can be referenced)
        let start_hidden_row = libadwaita::SwitchRow::new();
        start_hidden_row.set_title("Start Hidden");
        start_hidden_row.set_subtitle("Start with the window hidden in the tray");
        start_hidden_row.set_active(config.start_hidden);
        start_hidden_row.set_sensitive(config.autostart);

        let suppress = Rc::new(Cell::new(false));
        autostart_row.set_active(config.autostart);

        let suppress_clone = suppress.clone();
        let start_hidden_row_ref = start_hidden_row.clone();
        autostart_row.connect_active_notify(move |switch| {
            if suppress_clone.get() {
                return;
            }

            let enabled = switch.is_active();
            let switch_clone = switch.clone();
            let suppress_inner = suppress_clone.clone();
            let hidden_row = start_hidden_row_ref.clone();
            let window = switch
                .root()
                .and_then(|r| r.downcast::<gtk4::Window>().ok());

            // Enable/disable the Start Hidden row based on autostart state
            hidden_row.set_sensitive(enabled);
            if !enabled {
                hidden_row.set_active(false);
                // Persist start_hidden = false when autostart is disabled
                let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
                cfg.start_hidden = false;
                if let Err(e) = cfg.save(&definition.name) {
                    tracing::error!(
                        "Failed to save start_hidden for {}: {}",
                        definition.display_name,
                        e
                    );
                }
            }

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
                    // Revert Start Hidden row sensitivity on failure
                    hidden_row.set_sensitive(!enabled);
                    suppress_inner.set(false);
                }
            });
        });

        startup_group.add(&autostart_row);

        start_hidden_row.connect_active_notify(move |switch| {
            let enabled = switch.is_active();
            let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
            cfg.start_hidden = enabled;
            if let Err(e) = cfg.save(&definition.name) {
                tracing::error!(
                    "Failed to save start_hidden for {}: {}",
                    definition.display_name,
                    e
                );
            }

            // Regenerate the autostart entry so it picks up the new --minimized flag
            if cfg.autostart {
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

        // --- Connection group (custom server URL) ---
        // Self-hostable services (Element, NextCloud Talk) let the user point at
        // their own instance. Loft templates the extension manifest with this
        // origin at deploy time. NextCloud Talk has no public default, so the URL
        // is effectively required for it.
        if definition.name == "element" || definition.name == "talk" {
            let description = if definition.name == "talk" {
                "Enter the address of your NextCloud server \
                 (e.g. cloud.example.com) — Loft adds the Talk path for you. \
                 Required: NextCloud Talk has no default server. Takes effect \
                 next time the service starts."
            } else {
                "Use a self-hosted Element Web instance instead of app.element.io. \
                 Leave empty for the default. Takes effect next time the service starts."
            };
            let connection_group = libadwaita::PreferencesGroup::new();
            connection_group.set_title("Connection");
            connection_group.set_description(Some(description));

            let url_row = libadwaita::EntryRow::new();
            url_row.set_title(if definition.name == "talk" {
                "NextCloud Server URL"
            } else {
                "Custom Server URL"
            });
            url_row.set_show_apply_button(true);
            if let Some(u) = config.custom_url.as_deref() {
                url_row.set_text(u);
            }

            url_row.connect_apply(move |row| {
                let normalized = if definition.name == "talk" {
                    // Talk lives under /apps/spreed/; let the user enter just their
                    // server address and reflect the resolved URL back into the row.
                    let u = normalize_talk_url(&row.text());
                    if let Some(ref u) = u {
                        row.set_text(u);
                    }
                    u
                } else {
                    // Normalise a bare host to https:// so it forms a valid origin.
                    let mut text = row.text().trim().to_string();
                    if text.is_empty() {
                        None
                    } else {
                        if !text.contains("://") {
                            text = format!("https://{text}");
                        }
                        Some(text)
                    }
                };

                let mut cfg = ServiceConfig::load(&definition.name).unwrap_or_default();
                cfg.custom_url = normalized;
                if let Err(e) = cfg.save(&definition.name) {
                    tracing::error!(
                        "Failed to save custom_url for {}: {}",
                        definition.display_name,
                        e
                    );
                    return;
                }
                // Re-template the extension so the new origin is in the manifest.
                if let Err(e) = desktop::deploy_extension() {
                    tracing::error!("Failed to re-deploy extension after URL change: {}", e);
                }
            });

            connection_group.add(&url_row);
            outer.append(&connection_group);
        }

        // --- Uninstall button ---
        let uninstall_button = gtk4::Button::with_label("Uninstall\u{2026}");
        uninstall_button.add_css_class("destructive-action");
        uninstall_button.add_css_class("pill");
        uninstall_button.set_halign(gtk4::Align::Center);
        uninstall_button.set_margin_top(12);

        let ui = self.clone();
        uninstall_button.connect_clicked(move |btn| {
            ui.show_uninstall_dialog(btn, definition);
        });

        outer.append(&uninstall_button);

        clamp.set_child(Some(&outer));
        scrolled.set_child(Some(&clamp));
        toolbar_view.set_content(Some(&scrolled));

        libadwaita::NavigationPage::new(&toolbar_view, definition.display_name)
    }

    fn show_uninstall_dialog(
        self: &Rc<Self>,
        btn: &gtk4::Button,
        definition: &'static service::ServiceDefinition,
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

        let ui = self.clone();
        dialog.connect_response(None, move |_, response| {
            if response != "uninstall" {
                return;
            }
            let delete_data = delete_check.is_active();
            match desktop::uninstall_service(definition, delete_data) {
                Ok(()) => {
                    // Pop back to the main page and rebuild both sections.
                    ui.nav_view.pop();
                    ui.populate();
                }
                Err(e) => {
                    tracing::error!("Uninstall failed: {}", e);
                }
            }
        });

        dialog.present(window.as_ref());
    }
}

/// Normalise a user-entered NextCloud address into a full Talk URL, or `None`
/// for empty input. Adds `https://` when no scheme is given and appends
/// `/apps/spreed/` unless the address already points at it (so pasting the full
/// URL is idempotent, and a NextCloud-in-a-subdirectory setup still works).
fn normalize_talk_url(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    let mut text = text.to_string();
    if !text.contains("://") {
        text = format!("https://{text}");
    }
    let base = text.trim_end_matches('/');
    Some(if base.ends_with("/apps/spreed") {
        format!("{base}/")
    } else {
        format!("{base}/apps/spreed/")
    })
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
