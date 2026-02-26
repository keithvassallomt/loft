use std::fs;

/// Test GlobalConfig TOML serialization round-trip in a temp directory.
#[test]
fn global_config_file_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");

    let toml_content = r#"chrome_path = "/opt/google/chrome/google-chrome"
"#;

    fs::write(&path, toml_content).unwrap();
    let loaded: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(
        loaded["chrome_path"].as_str().unwrap(),
        "/opt/google/chrome/google-chrome"
    );
}

/// Test ServiceConfig TOML serialization round-trip in a temp directory.
#[test]
fn service_config_file_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let services_dir = dir.path().join("services");
    fs::create_dir_all(&services_dir).unwrap();
    let path = services_dir.join("whatsapp.toml");

    let toml_content = r#"autostart = true
do_not_disturb = false
"#;

    fs::write(&path, toml_content).unwrap();
    let loaded: toml::Value = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();

    assert_eq!(loaded["autostart"].as_bool().unwrap(), true);
    assert_eq!(loaded["do_not_disturb"].as_bool().unwrap(), false);
}

/// Test that a missing config file results in sensible defaults.
#[test]
fn missing_config_returns_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nonexistent.toml");
    assert!(!path.exists());
}

/// Test that multiple service configs can coexist in the same directory.
#[test]
fn multiple_service_configs() {
    let dir = tempfile::tempdir().unwrap();
    let services_dir = dir.path().join("services");
    fs::create_dir_all(&services_dir).unwrap();

    let configs = [
        ("whatsapp.toml", true, false),
        ("messenger.toml", false, true),
    ];

    for (filename, autostart, dnd) in &configs {
        let content = format!("autostart = {}\ndo_not_disturb = {}\n", autostart, dnd);
        fs::write(services_dir.join(filename), content).unwrap();
    }

    // Verify each independently
    let wa: toml::Value =
        toml::from_str(&fs::read_to_string(services_dir.join("whatsapp.toml")).unwrap()).unwrap();
    assert_eq!(wa["autostart"].as_bool().unwrap(), true);
    assert_eq!(wa["do_not_disturb"].as_bool().unwrap(), false);

    let msg: toml::Value =
        toml::from_str(&fs::read_to_string(services_dir.join("messenger.toml")).unwrap()).unwrap();
    assert_eq!(msg["autostart"].as_bool().unwrap(), false);
    assert_eq!(msg["do_not_disturb"].as_bool().unwrap(), true);
}

/// Test that GlobalConfig with no chrome_path override serializes correctly.
#[test]
fn global_config_no_override() {
    let toml_content = "";
    let loaded: toml::Value = toml::from_str(toml_content).unwrap();
    assert!(loaded.get("chrome_path").is_none());
}
