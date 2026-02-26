pub mod window;

use anyhow::Result;
use gtk4::prelude::*;

pub fn run() -> Result<()> {
    let app = libadwaita::Application::builder()
        .application_id("chat.loft.Manager")
        .build();

    app.connect_activate(|app| {
        window::build_window(app);
    });

    app.run_with_args::<&str>(&[]);
    Ok(())
}
