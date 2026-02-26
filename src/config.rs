use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Global config at ~/.config/loft/config.toml
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GlobalConfig {
    /// Custom Chrome binary path (overrides auto-detection)
    pub chrome_path: Option<String>,
}

/// Per-service config at ~/.config/loft/services/<name>.toml
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ServiceConfig {
    pub autostart: bool,
    pub do_not_disturb: bool,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            autostart: false,
            do_not_disturb: false,
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
    }

    #[test]
    fn test_service_config_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("whatsapp.toml");

        let config = ServiceConfig {
            autostart: true,
            do_not_disturb: false,
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
    }
}
