mod autostart;
mod chrome;
mod cli;
mod config;
mod daemon;
mod desktop;
mod logging;
mod manager;
mod service;

use anyhow::Result;
use clap::Parser;

fn main() -> Result<()> {
    let args = cli::Args::parse();
    logging::init(&args)?;

    if args.native_messaging {
        tracing::info!("Starting native messaging relay");
        let rt = tokio::runtime::Runtime::new()?;
        return rt.block_on(daemon::messaging::run_relay());
    }

    if let Some(service_name) = args.service {
        tracing::info!("Starting service daemon: {}", service_name);
        let rt = tokio::runtime::Runtime::new()?;
        return rt.block_on(daemon::run(service_name));
    }

    tracing::info!("Starting Loft manager");
    manager::run()
}
