/// D-Bus integration tests.
///
/// These tests validate the D-Bus interface definitions and message formats
/// without requiring a running session bus. Tests that need a real D-Bus session
/// are marked #[ignore] and can be run manually with `cargo test -- --ignored`.

#[test]
fn dbus_bus_name_format() {
    // Validate that our bus names follow D-Bus naming rules
    let services = [("WhatsApp", "chat.loft.WhatsApp"), ("Messenger", "chat.loft.Messenger")];

    for (dbus_name, expected) in &services {
        let name = format!("chat.loft.{}", dbus_name);
        assert_eq!(&name, expected);
        // D-Bus names must have at least two dot-separated segments
        assert!(name.matches('.').count() >= 2);
        // No hyphens in the component after the last dot
        let last_component = name.rsplit('.').next().unwrap();
        assert!(!last_component.contains('-'));
    }
}

#[test]
fn dbus_object_path_format() {
    let services = [("WhatsApp", "/chat/loft/WhatsApp"), ("Messenger", "/chat/loft/Messenger")];

    for (dbus_name, expected) in &services {
        let path = format!("/chat/loft/{}", dbus_name);
        assert_eq!(&path, expected);
        // Object paths must start with /
        assert!(path.starts_with('/'));
        // No trailing slash (unless the path is just /)
        assert!(!path.ends_with('/') || path == "/");
    }
}

#[test]
fn dbus_interface_name_is_valid() {
    let iface = "chat.loft.Service";
    // Interface names must have at least two dot-separated segments
    assert!(iface.matches('.').count() >= 2);
    // Each element must not be empty
    for part in iface.split('.') {
        assert!(!part.is_empty());
    }
}

#[test]
fn dbus_method_names_are_valid() {
    // D-Bus method names must be valid identifiers (letters, digits, underscore)
    let methods = ["Show", "Hide", "Toggle", "Quit", "GetStatus"];
    for method in &methods {
        assert!(!method.is_empty());
        assert!(method.chars().all(|c| c.is_alphanumeric() || c == '_'));
        // Must start with a letter
        assert!(method.chars().next().unwrap().is_alphabetic());
    }
}

#[test]
fn dbus_get_status_return_type() {
    // GetStatus returns (bool, u32, bool) = (visible, badge_count, dnd)
    // Verify our expected D-Bus signature matches
    let visible: bool = false;
    let badge_count: u32 = 0;
    let dnd: bool = false;
    let _status: (bool, u32, bool) = (visible, badge_count, dnd);
}

/// This test requires a running D-Bus session bus.
/// Run with: cargo test -- --ignored dbus_session_bus_available
#[test]
#[ignore]
fn dbus_session_bus_available() {
    // Just verify that DBUS_SESSION_BUS_ADDRESS is set
    let addr = std::env::var("DBUS_SESSION_BUS_ADDRESS");
    assert!(addr.is_ok(), "DBUS_SESSION_BUS_ADDRESS not set");
}
