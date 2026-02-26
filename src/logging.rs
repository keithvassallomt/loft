use anyhow::{Context, Result};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

use crate::cli::Args;

/// Initialize the tracing logging system.
///
/// - Stdout: `info` and above by default, `trace` if `--verbose`
/// - File: `debug` and above, written to `~/.local/share/loft/logs/<name>.log`
pub fn init(args: &Args) -> Result<()> {
    let log_dir = dirs::data_dir()
        .context("Could not determine XDG_DATA_HOME")?
        .join("loft/logs");
    std::fs::create_dir_all(&log_dir)
        .with_context(|| format!("Failed to create log directory {}", log_dir.display()))?;

    let log_filename = match &args.service {
        Some(name) => format!("{}.log", name),
        None if args.native_messaging => "native-messaging.log".to_string(),
        None => "loft.log".to_string(),
    };

    let file_appender = tracing_appender::rolling::never(&log_dir, &log_filename);

    let stdout_filter = if args.verbose { "trace" } else { "info" };

    // In native messaging mode, Chrome owns stdout for the NM protocol.
    // Only log to the file — any stdout output would corrupt the message stream.
    if args.native_messaging {
        tracing_subscriber::registry()
            .with(
                fmt::layer()
                    .with_writer(file_appender)
                    .with_ansi(false)
                    .with_filter(EnvFilter::new("debug")),
            )
            .init();
    } else {
        tracing_subscriber::registry()
            .with(
                fmt::layer()
                    .with_target(false)
                    .with_filter(EnvFilter::new(stdout_filter)),
            )
            .with(
                fmt::layer()
                    .with_writer(file_appender)
                    .with_ansi(false)
                    .with_filter(EnvFilter::new("debug")),
            )
            .init();
    }

    tracing::debug!("Logging initialized (file: {})", log_dir.join(&log_filename).display());
    Ok(())
}
