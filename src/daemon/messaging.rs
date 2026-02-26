use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::DaemonState;

// ============================================================
// Message types
// ============================================================

/// Messages sent from the Chrome extension to the daemon.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtensionMessage {
    Ready { service: String },
    BadgeUpdate { count: u32 },
    Notification {
        title: String,
        body: String,
        icon: Option<String>,
    },
    /// Extension reports the user closed the window (X button).
    /// Chrome is still alive with a minimized background window.
    WindowHidden,
    /// Extension reports the window was restored/focused (e.g. via alt-tab).
    WindowShown,
}

/// Messages sent from the daemon to the Chrome extension.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonMessage {
    DndChanged { enabled: bool },
    HideWindow,
    ShowWindow,
    Ping,
}

// ============================================================
// Native messaging wire format (4-byte LE length + JSON)
// ============================================================

/// Read a length-prefixed JSON message from a synchronous reader.
pub fn read_nm_message(reader: &mut impl Read) -> Result<serde_json::Value> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .context("Failed to read message length")?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > 1_048_576 {
        return Err(anyhow!("Message too large: {} bytes", len));
    }
    let mut msg_buf = vec![0u8; len];
    reader
        .read_exact(&mut msg_buf)
        .context("Failed to read message body")?;
    serde_json::from_slice(&msg_buf).context("Failed to parse message JSON")
}

/// Write a length-prefixed JSON message to a synchronous writer.
pub fn write_nm_message(writer: &mut impl Write, msg: &serde_json::Value) -> Result<()> {
    let data = serde_json::to_vec(msg)?;
    let len = (data.len() as u32).to_le_bytes();
    writer.write_all(&len)?;
    writer.write_all(&data)?;
    writer.flush()?;
    Ok(())
}

/// Read a length-prefixed JSON message from an async reader.
async fn read_nm_message_async(
    reader: &mut (impl AsyncReadExt + Unpin),
) -> Result<serde_json::Value> {
    let len = reader
        .read_u32_le()
        .await
        .context("Failed to read message length")?;
    if len > 1_048_576 {
        return Err(anyhow!("Message too large: {} bytes", len));
    }
    let mut msg_buf = vec![0u8; len as usize];
    reader
        .read_exact(&mut msg_buf)
        .await
        .context("Failed to read message body")?;
    serde_json::from_slice(&msg_buf).context("Failed to parse message JSON")
}

/// Write a length-prefixed JSON message to an async writer.
async fn write_nm_message_async(
    writer: &mut (impl AsyncWriteExt + Unpin),
    msg: &DaemonMessage,
) -> Result<()> {
    let data = serde_json::to_vec(msg)?;
    let len = (data.len() as u32).to_le_bytes();
    writer.write_all(&len).await?;
    writer.write_all(&data).await?;
    writer.flush().await?;
    Ok(())
}

// ============================================================
// Socket path helpers
// ============================================================

fn socket_dir() -> PathBuf {
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| {
        format!(
            "/run/user/{}",
            unsafe { libc::getuid() }
        )
    });
    PathBuf::from(runtime_dir).join("loft")
}

fn socket_path(service_name: &str) -> PathBuf {
    socket_dir().join(format!("{}.sock", service_name))
}

// ============================================================
// Daemon side: Unix socket server
// ============================================================

/// Start the Unix socket server that listens for NM relay connections.
pub async fn start_socket_server(
    service_name: String,
    state: Arc<DaemonState>,
    cmd_tx: tokio::sync::broadcast::Sender<DaemonMessage>,
) -> Result<()> {
    let dir = socket_dir();
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create socket dir {}", dir.display()))?;

    let path = socket_path(&service_name);
    // Remove stale socket
    let _ = std::fs::remove_file(&path);

    let listener = tokio::net::UnixListener::bind(&path)
        .with_context(|| format!("Failed to bind socket {}", path.display()))?;

    tracing::info!("Listening on {}", path.display());

    loop {
        let (stream, _) = listener.accept().await?;
        let state = Arc::clone(&state);
        let cmd_rx = cmd_tx.subscribe();

        tokio::spawn(async move {
            if let Err(e) = handle_relay_connection(stream, state, cmd_rx).await {
                tracing::debug!("Relay connection ended: {}", e);
            }
        });
    }
}

/// Handle a single relay connection: read extension messages, send daemon messages.
async fn handle_relay_connection(
    stream: tokio::net::UnixStream,
    state: Arc<DaemonState>,
    mut cmd_rx: tokio::sync::broadcast::Receiver<DaemonMessage>,
) -> Result<()> {
    let (mut reader, mut writer) = stream.into_split();

    loop {
        tokio::select! {
            msg = read_nm_message_async(&mut reader) => {
                let value = msg?;
                match serde_json::from_value::<ExtensionMessage>(value) {
                    Ok(ExtensionMessage::Ready { service }) => {
                        tracing::info!("Extension ready for service: {}", service);
                    }
                    Ok(ExtensionMessage::BadgeUpdate { count }) => {
                        tracing::debug!("Badge update: {}", count);
                        state.badge_count.store(count, Ordering::Relaxed);
                    }
                    Ok(ExtensionMessage::Notification { title, body, .. }) => {
                        // Notification metadata from extension — Chrome shows
                        // the native notification itself, we just log it.
                        tracing::debug!("Notification: {} - {}", title, body);
                    }
                    Ok(ExtensionMessage::WindowHidden) => {
                        tracing::info!("Extension reports window hidden (user closed)");
                        state.visible.store(false, Ordering::Relaxed);
                    }
                    Ok(ExtensionMessage::WindowShown) => {
                        tracing::info!("Extension reports window shown (user restored)");
                        state.visible.store(true, Ordering::Relaxed);
                    }
                    Err(e) => {
                        tracing::warn!("Unknown message from extension: {}", e);
                    }
                }
            }
            msg = cmd_rx.recv() => {
                match msg {
                    Ok(daemon_msg) => {
                        write_nm_message_async(&mut writer, &daemon_msg).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("Socket relay lagged, skipped {} messages", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }
        }
    }
    Ok(())
}

// ============================================================
// Relay mode: loft --native-messaging
// ============================================================

/// Run the native messaging relay process (launched by Chrome).
/// Bridges Chrome stdin/stdout to the daemon's Unix socket.
pub async fn run_relay() -> Result<()> {
    // Read the first message from Chrome to determine the service.
    // The lock must be dropped before spawning relay threads.
    let first_msg = {
        let stdin = std::io::stdin();
        let mut stdin_lock = stdin.lock();
        read_nm_message(&mut stdin_lock)
            .context("Failed to read initial message from Chrome")?
    };

    let service = first_msg
        .get("service")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("First message must be 'ready' with a 'service' field"))?
        .to_string();

    tracing::info!("Native messaging relay starting for service: {}", service);

    // Connect to the daemon's Unix socket
    let path = socket_path(&service);
    let mut socket = std::os::unix::net::UnixStream::connect(&path)
        .with_context(|| format!("Failed to connect to daemon socket {}", path.display()))?;

    // Forward the first message
    write_nm_message(&mut socket, &first_msg)?;

    // Bidirectional relay using two threads:
    // Thread 1: Chrome stdin -> socket
    // Thread 2: socket -> Chrome stdout
    let socket_for_read = socket
        .try_clone()
        .context("Failed to clone socket for reading")?;

    let t1 = std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut sock = socket;
        loop {
            match read_nm_message(&mut stdin) {
                Ok(msg) => {
                    if write_nm_message(&mut sock, &msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let t2 = std::thread::spawn(move || {
        let mut sock = socket_for_read;
        let mut stdout = std::io::stdout().lock();
        loop {
            match read_nm_message(&mut sock) {
                Ok(msg) => {
                    if write_nm_message(&mut stdout, &msg).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    t1.join().ok();
    t2.join().ok();
    Ok(())
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_write_read_roundtrip() {
        let msg = serde_json::json!({"type": "badge_update", "count": 5});
        let mut buf = Vec::new();
        write_nm_message(&mut buf, &msg).unwrap();

        let mut cursor = Cursor::new(buf);
        let result = read_nm_message(&mut cursor).unwrap();
        assert_eq!(result, msg);
    }

    #[test]
    fn test_extension_message_deserialize() {
        let json = r#"{"type":"ready","service":"whatsapp"}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ExtensionMessage::Ready { service } if service == "whatsapp"));
    }

    #[test]
    fn test_badge_update_deserialize() {
        let json = r#"{"type":"badge_update","count":3}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ExtensionMessage::BadgeUpdate { count } if count == 3));
    }

    #[test]
    fn test_notification_deserialize() {
        let json = r#"{"type":"notification","title":"Hello","body":"World","icon":null}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ExtensionMessage::Notification { .. }));
    }

    #[test]
    fn test_window_hidden_deserialize() {
        let json = r#"{"type":"window_hidden"}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ExtensionMessage::WindowHidden));
    }

    #[test]
    fn test_window_shown_deserialize() {
        let json = r#"{"type":"window_shown"}"#;
        let msg: ExtensionMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ExtensionMessage::WindowShown));
    }

    #[test]
    fn test_daemon_message_serialize() {
        let msg = DaemonMessage::DndChanged { enabled: true };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("dnd_changed"));
        assert!(json.contains("true"));
    }

    #[test]
    fn test_ping_serialize() {
        let msg = DaemonMessage::Ping;
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("ping"));
    }

    #[test]
    fn test_message_too_large() {
        // Create a message with length header claiming 2MB
        let len_bytes = (2_000_000u32).to_le_bytes();
        let mut data = Vec::new();
        data.extend_from_slice(&len_bytes);
        data.extend_from_slice(&[0u8; 100]); // Only 100 bytes of actual data

        let mut cursor = Cursor::new(data);
        let result = read_nm_message(&mut cursor);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("too large"));
    }
}
