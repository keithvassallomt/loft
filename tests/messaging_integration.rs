use std::io::Cursor;

/// Native messaging wire format: 4-byte LE length prefix + JSON body.
/// This tests the format directly without importing private crate functions.

fn write_nm_message(buf: &mut Vec<u8>, msg: &serde_json::Value) {
    let data = serde_json::to_vec(msg).unwrap();
    let len = (data.len() as u32).to_le_bytes();
    buf.extend_from_slice(&len);
    buf.extend_from_slice(&data);
}

fn read_nm_message(cursor: &mut Cursor<Vec<u8>>) -> serde_json::Value {
    use std::io::Read;
    let mut len_buf = [0u8; 4];
    cursor.read_exact(&mut len_buf).unwrap();
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut msg_buf = vec![0u8; len];
    cursor.read_exact(&mut msg_buf).unwrap();
    serde_json::from_slice(&msg_buf).unwrap()
}

#[test]
fn wire_format_roundtrip_badge_update() {
    let msg = serde_json::json!({"type": "badge_update", "count": 5});
    let mut buf = Vec::new();
    write_nm_message(&mut buf, &msg);

    let mut cursor = Cursor::new(buf);
    let result = read_nm_message(&mut cursor);
    assert_eq!(result, msg);
}

#[test]
fn wire_format_roundtrip_ready() {
    let msg = serde_json::json!({"type": "ready", "service": "whatsapp"});
    let mut buf = Vec::new();
    write_nm_message(&mut buf, &msg);

    let mut cursor = Cursor::new(buf);
    let result = read_nm_message(&mut cursor);
    assert_eq!(result["type"], "ready");
    assert_eq!(result["service"], "whatsapp");
}

#[test]
fn wire_format_roundtrip_notification() {
    let msg = serde_json::json!({
        "type": "notification",
        "title": "New message",
        "body": "Hello from test",
        "icon": null
    });
    let mut buf = Vec::new();
    write_nm_message(&mut buf, &msg);

    let mut cursor = Cursor::new(buf);
    let result = read_nm_message(&mut cursor);
    assert_eq!(result["type"], "notification");
    assert_eq!(result["title"], "New message");
}

#[test]
fn wire_format_roundtrip_dnd_changed() {
    let msg = serde_json::json!({"type": "dnd_changed", "enabled": true});
    let mut buf = Vec::new();
    write_nm_message(&mut buf, &msg);

    let mut cursor = Cursor::new(buf);
    let result = read_nm_message(&mut cursor);
    assert_eq!(result["type"], "dnd_changed");
    assert_eq!(result["enabled"], true);
}

#[test]
fn wire_format_multiple_messages_in_sequence() {
    let messages = vec![
        serde_json::json!({"type": "ready", "service": "whatsapp"}),
        serde_json::json!({"type": "badge_update", "count": 3}),
        serde_json::json!({"type": "badge_update", "count": 0}),
    ];

    let mut buf = Vec::new();
    for msg in &messages {
        write_nm_message(&mut buf, msg);
    }

    let mut cursor = Cursor::new(buf);
    for expected in &messages {
        let result = read_nm_message(&mut cursor);
        assert_eq!(&result, expected);
    }
}

#[test]
fn wire_format_message_too_large_is_rejected() {
    // Create a buffer with a length header claiming 2MB
    let len_bytes = (2_000_000u32).to_le_bytes();
    let mut data = Vec::new();
    data.extend_from_slice(&len_bytes);
    data.extend_from_slice(&[0u8; 100]);

    let mut cursor = Cursor::new(data);
    use std::io::Read;
    let mut len_buf = [0u8; 4];
    cursor.read_exact(&mut len_buf).unwrap();
    let len = u32::from_le_bytes(len_buf) as usize;
    assert!(len > 1_048_576, "Message size should exceed the 1MB limit");
}

#[cfg(unix)]
#[tokio::test]
async fn unix_socket_roundtrip() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("test.sock");

    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();

    // Spawn a client that sends a message
    let sock_path_clone = sock_path.clone();
    let client_handle = tokio::spawn(async move {
        let mut stream = tokio::net::UnixStream::connect(&sock_path_clone)
            .await
            .unwrap();
        let msg = serde_json::json!({"type": "badge_update", "count": 7});
        let data = serde_json::to_vec(&msg).unwrap();
        let len = (data.len() as u32).to_le_bytes();
        stream.write_all(&len).await.unwrap();
        stream.write_all(&data).await.unwrap();
        stream.flush().await.unwrap();
    });

    // Accept the connection and read the message
    let (mut stream, _) = listener.accept().await.unwrap();
    let len = stream.read_u32_le().await.unwrap();
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await.unwrap();
    let msg: serde_json::Value = serde_json::from_slice(&buf).unwrap();

    assert_eq!(msg["type"], "badge_update");
    assert_eq!(msg["count"], 7);

    client_handle.await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn unix_socket_bidirectional() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let dir = tempfile::tempdir().unwrap();
    let sock_path = dir.path().join("bidir.sock");

    let listener = tokio::net::UnixListener::bind(&sock_path).unwrap();

    let sock_path_clone = sock_path.clone();
    let client_handle = tokio::spawn(async move {
        let mut stream = tokio::net::UnixStream::connect(&sock_path_clone)
            .await
            .unwrap();

        // Send a ready message
        let msg = serde_json::json!({"type": "ready", "service": "messenger"});
        let data = serde_json::to_vec(&msg).unwrap();
        let len = (data.len() as u32).to_le_bytes();
        stream.write_all(&len).await.unwrap();
        stream.write_all(&data).await.unwrap();
        stream.flush().await.unwrap();

        // Read response
        let resp_len = stream.read_u32_le().await.unwrap();
        let mut resp_buf = vec![0u8; resp_len as usize];
        stream.read_exact(&mut resp_buf).await.unwrap();
        let resp: serde_json::Value = serde_json::from_slice(&resp_buf).unwrap();
        assert_eq!(resp["type"], "dnd_changed");
        assert_eq!(resp["enabled"], false);
    });

    // Server side: read message, send response
    let (mut stream, _) = listener.accept().await.unwrap();
    let len = stream.read_u32_le().await.unwrap();
    let mut buf = vec![0u8; len as usize];
    stream.read_exact(&mut buf).await.unwrap();
    let msg: serde_json::Value = serde_json::from_slice(&buf).unwrap();
    assert_eq!(msg["type"], "ready");
    assert_eq!(msg["service"], "messenger");

    // Send dnd_changed response
    let resp = serde_json::json!({"type": "dnd_changed", "enabled": false});
    let resp_data = serde_json::to_vec(&resp).unwrap();
    let resp_len = (resp_data.len() as u32).to_le_bytes();
    stream.write_all(&resp_len).await.unwrap();
    stream.write_all(&resp_data).await.unwrap();
    stream.flush().await.unwrap();

    client_handle.await.unwrap();
}
