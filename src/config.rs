use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

/// Which backend to use for tray/panel icons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TrayBackend {
    /// Auto-detect: GNOME → panel icons, otherwise → SNI.
    #[default]
    Auto,
    /// Native GNOME Shell panel icons via the Loft Shell Helper extension.
    GnomePanel,
    /// KStatusNotifierItem (requires AppIndicator/SNI watcher extension on GNOME).
    Sni,
}

impl TrayBackend {
    /// Resolve `Auto` to a concrete backend based on the current desktop.
    pub fn resolve(self) -> TrayBackend {
        match self {
            TrayBackend::Auto => {
                let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
                if desktop.split(':').any(|d| d.eq_ignore_ascii_case("GNOME")) {
                    TrayBackend::GnomePanel
                } else {
                    TrayBackend::Sni
                }
            }
            other => other,
        }
    }
}

impl fmt::Display for TrayBackend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TrayBackend::Auto => write!(f, "auto"),
            TrayBackend::GnomePanel => write!(f, "gnome-panel"),
            TrayBackend::Sni => write!(f, "sni"),
        }
    }
}

/// Global config at ~/.config/loft/config.toml
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GlobalConfig {
    /// Custom Chrome binary path (overrides auto-detection)
    pub chrome_path: Option<String>,
    /// Tray icon backend: auto, gnome-panel, or sni
    #[serde(default)]
    pub tray_backend: TrayBackend,
}

/// Per-service config at ~/.config/loft/services/<name>.toml
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ServiceConfig {
    pub autostart: bool,
    pub do_not_disturb: bool,
    #[serde(default)]
    pub start_hidden: bool,
    #[serde(default = "default_true")]
    pub show_titlebar: bool,
    #[serde(default = "default_true")]
    pub badges_enabled: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            autostart: false,
            do_not_disturb: false,
            start_hidden: false,
            show_titlebar: true,
            badges_enabled: true,
        }
    }
}

fn config_dir() -> Result<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join("loft"))
        .context("Could not determine XDG_CONFIG_HOME")
}

impl GlobalConfig {
    pub fn load() -> Result<Self> {
        let path = config_dir()?.join("config.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        toml::from_str(&content)
            .with_context(|| format!("Failed to parse {}", path.display()))
    }

    pub fn save(&self) -> Result<()> {
        let dir = config_dir()?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("config.toml");
        let content = toml::to_string_pretty(self)?;
        std::fs::write(&path, content)
            .with_context(|| format!("Failed to write {}", path.display()))
    }
}

impl ServiceConfig {
    pub fn load(service: &impl std::fmt::Display) -> Result<Self> {
        let path = config_dir()?
            .join("services")
            .join(format!("{}.toml", service));
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        toml::from_str(&content)
            .with_context(|| format!("Failed to parse {}", path.display()))
    }

    pub fn save(&self, service: &impl std::fmt::Display) -> Result<()> {
        let dir = config_dir()?.join("services");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.toml", service));
        let content = toml::to_string_pretty(self)?;
        std::fs::write(&path, content)
            .with_context(|| format!("Failed to write {}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_global_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");

        let config = GlobalConfig {
            chrome_path: Some("/usr/bin/google-chrome".to_string()),
            tray_backend: TrayBackend::GnomePanel,
        };

        let content = toml::to_string_pretty(&config).unwrap();
        fs::write(&path, &content).unwrap();

        let loaded: GlobalConfig = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config, loaded);
    }

    #[test]
    fn test_global_config_default() {
        let config = GlobalConfig::default();
        assert_eq!(config.chrome_path, None);
        assert_eq!(config.tray_backend, TrayBackend::Auto);
    }

    #[test]
    fn test_global_config_missing_tray_backend() {
        let toml = "chrome_path = \"/usr/bin/google-chrome\"\n";
        let config: GlobalConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.tray_backend, TrayBackend::Auto);
    }

    #[test]
    fn test_tray_backend_serde() {
        let toml = "tray_backend = \"gnome-panel\"\n";
        let config: GlobalConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.tray_backend, TrayBackend::GnomePanel);

        let toml = "tray_backend = \"sni\"\n";
        let config: GlobalConfig = toml::from_str(toml).unwrap();
        assert_eq!(config.tray_backend, TrayBackend::Sni);
    }

    #[test]
    fn test_service_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("whatsapp.toml");

        let config = ServiceConfig {
            autostart: true,
            do_not_disturb: false,
            start_hidden: true,
            show_titlebar: false,
            badges_enabled: false,
        };

        let content = toml::to_string_pretty(&config).unwrap();
        fs::write(&path, &content).unwrap();

        let loaded: ServiceConfig = toml::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config, loaded);
    }

    #[test]
    fn test_service_config_default() {
        let config = ServiceConfig::default();
        assert!(!config.autostart);
        assert!(!config.do_not_disturb);
        assert!(!config.start_hidden);
        assert!(config.show_titlebar);
        assert!(config.badges_enabled);
    }

    #[test]
    fn test_service_config_missing_new_fields() {
        // Old config files without start_hidden/show_titlebar should deserialize with defaults
        let toml = "autostart = true\ndo_not_disturb = false\n";
        let config: ServiceConfig = toml::from_str(toml).unwrap();
        assert!(config.autostart);
        assert!(!config.start_hidden);
        assert!(config.show_titlebar);
        assert!(config.badges_enabled);
    }
}
