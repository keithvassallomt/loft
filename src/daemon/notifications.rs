use anyhow::{Context, Result};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// Persistent D-Bus connection for notifications.
/// KDE closes notifications when the sender disconnects, so we must
/// keep the connection alive for the lifetime of the daemon.
static CONN: OnceLock<Mutex<Option<zbus::Connection>>> = OnceLock::new();

/// Tracks notification IDs sent by THIS daemon instance, so we only
/// respond to ActionInvoked signals for our own notifications.
static SENT_IDS: OnceLock<Mutex<HashMap<u32, Option<String>>>> = OnceLock::new();

fn sent_ids() -> &'static Mutex<HashMap<u32, Option<String>>> {
    SENT_IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn get_connection() -> Result<zbus::Connection> {
    let mutex = CONN.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;
    if let Some(ref conn) = *guard {
        return Ok(conn.clone());
    }
    let conn = zbus::Connection::session().await
        .context("failed to connect to session D-Bus for notifications")?;
    *guard = Some(conn.clone());
    Ok(conn)
}

/// Send a desktop notification via org.freedesktop.Notifications D-Bus.
pub async fn send(
    service_name: &str,
    display_name: &str,
    summary: &str,
    body: &str,
    icon_url: Option<&str>,
    href: Option<&str>,
) -> Result<u32> {
    let app_icon = resolve_app_icon(service_name);

    // Resolve avatar: data URI → decode to file, HTTP URL → download
    let avatar_path = match icon_url {
        Some(url) if url.starts_with("data:") => decode_data_uri_avatar(url).ok(),
        Some(url) if !url.is_empty() => download_avatar(url).await.ok(),
        _ => None,
    };

    let conn = get_connection().await?;

    let mut hints: std::collections::HashMap<&str, zbus::zvariant::Value> =
        std::collections::HashMap::new();
    if let Some(ref path) = avatar_path {
        hints.insert(
            "image-path",
            zbus::zvariant::Value::from(path.to_string_lossy().to_string()),
        );
    }

    let actions: Vec<&str> = vec!["default", "Open"];

    let reply = conn
        .call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                display_name,
                0u32,
                &app_icon,
                summary,
                body,
                &actions,
                &hints,
                -1i32,
            ),
        )
        .await
        .context("failed to call Notify")?;

    let notification_id: u32 = reply.body().deserialize()
        .context("failed to parse notification ID")?;

    tracing::debug!(
        "Sent D-Bus notification (id={}) for {}: {} - {}",
        notification_id, display_name, summary, body
    );

    // Track this notification ID so we only handle ActionInvoked for our own
    let href_val = href.filter(|h| !h.is_empty()).map(|h| h.to_string());
    sent_ids().lock().await.insert(notification_id, href_val);

    Ok(notification_id)
}

/// Resolve the local path for a service's app icon.
fn resolve_app_icon(service_name: &str) -> String {
    let icons_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("~/.local/share"))
        .join("loft/icons");

    let svg_path = icons_dir.join(format!("{}.svg", service_name));
    if svg_path.exists() {
        return svg_path.to_string_lossy().to_string();
    }

    let png_path = icons_dir.join(format!("{}.png", service_name));
    if png_path.exists() {
        return png_path.to_string_lossy().to_string();
    }

    format!("loft-{}", service_name)
}

/// Decode a data: URI avatar to a temp file.
fn decode_data_uri_avatar(data_uri: &str) -> Result<PathBuf> {
    use base64::Engine;

    let mut hasher = DefaultHasher::new();
    // Hash just the first 200 chars to avoid hashing megabytes of base64
    data_uri[..data_uri.len().min(200)].hash(&mut hasher);
    let hash = hasher.finish();
    let cache_path = std::env::temp_dir().join(format!("loft-avatar-{:x}.png", hash));

    // Reuse cached file if recent
    if let Ok(metadata) = std::fs::metadata(&cache_path) {
        if let Ok(modified) = metadata.modified() {
            if modified.elapsed().unwrap_or_default() < std::time::Duration::from_secs(3600) {
                return Ok(cache_path);
            }
        }
    }

    // Parse "data:<mime>;base64,<data>"
    let base64_data = data_uri
        .find(",")
        .map(|i| &data_uri[i + 1..])
        .context("invalid data URI: no comma")?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .context("failed to decode base64 avatar")?;

    std::fs::write(&cache_path, &bytes)
        .context("failed to write avatar to temp file")?;

    Ok(cache_path)
}

/// Download an avatar image from URL to a temp file.
/// Reuses cached files for the same URL (cache valid for 1 hour).
async fn download_avatar(url: &str) -> Result<PathBuf> {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();
    let cache_path = std::env::temp_dir().join(format!("loft-avatar-{:x}.png", hash));

    if let Ok(metadata) = std::fs::metadata(&cache_path) {
        if let Ok(modified) = metadata.modified() {
            if modified.elapsed().unwrap_or_default() < std::time::Duration::from_secs(3600) {
                return Ok(cache_path);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .context("failed to build HTTP client")?;

    let response = client.get(url).send().await
        .context("failed to fetch avatar")?;

    let bytes = response.bytes().await
        .context("failed to read avatar response")?;

    std::fs::write(&cache_path, &bytes)
        .context("failed to write avatar to temp file")?;

    Ok(cache_path)
}

/// Listen for notification click actions via the ActionInvoked D-Bus signal.
/// When a notification is clicked, shows the window and (for Messenger)
/// navigates to the conversation.
pub async fn listen_for_actions(
    state: Arc<super::DaemonState>,
    cmd_tx: tokio::sync::broadcast::Sender<super::messaging::DaemonMessage>,
) -> Result<std::convert::Infallible> {
    use futures_util::StreamExt;

    let conn = get_connection().await?;

    // Listen for both ActionInvoked (click) and NotificationClosed (dismiss)
    let action_rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.Notifications")?
        .member("ActionInvoked")?
        .build();
    let close_rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.Notifications")?
        .member("NotificationClosed")?
        .build();

    let mut action_stream = zbus::MessageStream::for_match_rule(action_rule, &conn, None).await?;
    let mut close_stream = zbus::MessageStream::for_match_rule(close_rule, &conn, None).await?;

    tracing::info!("Listening for notification action signals");

    loop {
        tokio::select! {
            Some(msg) = action_stream.next() => {
                let msg = match msg {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!("Error receiving action signal: {}", e);
                        continue;
                    }
                };

                let (notif_id, action): (u32, String) = match msg.body().deserialize() {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                tracing::info!("Notification {} action: {}", notif_id, action);

                if action == "default" {
                    // Only handle notifications we sent
                    let entry = sent_ids().lock().await.remove(&notif_id);
                    let Some(href) = entry else { continue };

                    state.request_show();

                    if let Some(url) = href {
                        let nav_msg = super::messaging::DaemonMessage::NavigateToConversation { url };
                        let _ = cmd_tx.send(nav_msg);
                    }
                }
            }
            Some(msg) = close_stream.next() => {
                // Clean up stale entries when notifications are dismissed
                if let Ok(msg) = msg {
                    if let Ok((notif_id, _reason)) = msg.body().deserialize::<(u32, u32)>() {
                        sent_ids().lock().await.remove(&notif_id);
                    }
                }
            }
        }
    }
}
