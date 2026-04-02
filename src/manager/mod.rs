pub mod window;

use anyhow::Result;
use gtk4::prelude::*;

pub fn run() -> Result<()> {
    // Ensure the manager has a .desktop file so GNOME shows its icon in the dock
    if let Err(e) = crate::desktop::ensure_manager_desktop_entry() {
        tracing::warn!("Failed to install manager .desktop file: {}", e);
    }

    let app = libadwaita::Application::builder()
        .application_id("chat.loft.Manager")
        .build();

    app.connect_activate(|app| {
        window::build_window(app);
    });

    app.run_with_args::<&str>(&[]);
    Ok(())
}
