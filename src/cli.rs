use clap::{Parser, ValueEnum};

#[derive(Parser)]
#[command(name = "loft", about = "Linux desktop integration for Meta web apps")]
pub struct Args {
    /// Run a service daemon
    #[arg(long, value_enum)]
    pub service: Option<ServiceName>,

    /// Run as native messaging relay (internal, launched by Chrome)
    #[arg(long, hide = true)]
    pub native_messaging: bool,

    /// Start minimized to tray (no Chrome window until activated)
    #[arg(long)]
    pub minimized: bool,

    /// Enable verbose logging (debug + trace to stdout)
    #[arg(short, long)]
    pub verbose: bool,

    /// Extra arguments (Chrome passes the extension origin to the NM host)
    #[arg(trailing_var_arg = true, hide = true)]
    pub extra: Vec<String>,
}

#[derive(Clone, Debug, ValueEnum)]
pub enum ServiceName {
    Whatsapp,
    Messenger,
}

impl std::fmt::Display for ServiceName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServiceName::Whatsapp => write!(f, "whatsapp"),
            ServiceName::Messenger => write!(f, "messenger"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn test_no_args() {
        let args = Args::try_parse_from(["loft"]).unwrap();
        assert!(args.service.is_none());
        assert!(!args.native_messaging);
        assert!(!args.verbose);
    }

    #[test]
    fn test_service_whatsapp() {
        let args = Args::try_parse_from(["loft", "--service", "whatsapp"]).unwrap();
        assert!(matches!(args.service, Some(ServiceName::Whatsapp)));
    }

    #[test]
    fn test_service_messenger() {
        let args = Args::try_parse_from(["loft", "--service", "messenger"]).unwrap();
        assert!(matches!(args.service, Some(ServiceName::Messenger)));
    }

    #[test]
    fn test_verbose() {
        let args = Args::try_parse_from(["loft", "-v"]).unwrap();
        assert!(args.verbose);
    }

    #[test]
    fn test_native_messaging() {
        let args = Args::try_parse_from(["loft", "--native-messaging"]).unwrap();
        assert!(args.native_messaging);
    }

    #[test]
    fn test_minimized() {
        let args =
            Args::try_parse_from(["loft", "--service", "whatsapp", "--minimized"]).unwrap();
        assert!(matches!(args.service, Some(ServiceName::Whatsapp)));
        assert!(args.minimized);
    }

    #[test]
    fn test_service_with_verbose() {
        let args =
            Args::try_parse_from(["loft", "--service", "whatsapp", "--verbose"]).unwrap();
        assert!(matches!(args.service, Some(ServiceName::Whatsapp)));
        assert!(args.verbose);
    }
}
