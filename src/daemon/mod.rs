pub mod dbus;
pub mod gnome_shell;
pub mod messaging;
pub mod tray;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use tokio::process::Child;
use tokio::sync::Notify;

use crate::chrome::{self, ChromeInfo};
use crate::cli::ServiceName;
use crate::config::{GlobalConfig, ServiceConfig};
use crate::service::{self, ServiceDefinition};

/// Shared mutable state across all daemon components (D-Bus, tray, messaging).
pub struct DaemonState {
    pub visible: AtomicBool,
    pub badge_count: AtomicU32,
    pub dnd: AtomicBool,
    pub quit_requested: AtomicBool,
    /// When true, the messaging handler will immediately hide the window
    /// on the first `WindowShown` event (for `--minimized` startup).
    pub start_minimized: AtomicBool,
    pub show_signal: Notify,
    pub chrome_pid: tokio::sync::Mutex<Option<u32>>,
    /// Broadcast channel for sending commands to the extension via native messaging.
    pub cmd_tx: tokio::sync::broadcast::Sender<messaging::DaemonMessage>,
}

impl DaemonState {
    pub fn new(dnd: bool, minimized: bool) -> Self {
        let (cmd_tx, _) = tokio::sync::broadcast::channel(16);
        Self {
            visible: AtomicBool::new(false),
            badge_count: AtomicU32::new(0),
            dnd: AtomicBool::new(dnd),
            quit_requested: AtomicBool::new(false),
            start_minimized: AtomicBool::new(minimized),
            show_signal: Notify::new(),
            chrome_pid: tokio::sync::Mutex::new(None),
            cmd_tx,
        }
    }

    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::Relaxed)
    }

    pub fn get_badge_count(&self) -> u32 {
        self.badge_count.load(Ordering::Relaxed)
    }

    pub fn is_dnd(&self) -> bool {
        self.dnd.load(Ordering::Relaxed)
    }

    pub fn request_show(&self) {
        self.visible.store(true, Ordering::Relaxed);
        let _ = self.cmd_tx.send(messaging::DaemonMessage::ShowWindow);
        // notify_waiters (not notify_one) so no permit is stored when
        // nobody is waiting — prevents spurious Chrome respawns.
        self.show_signal.notify_waiters();
    }

    pub fn request_hide(&self) {
        self.visible.store(false, Ordering::Relaxed);
        let _ = self.cmd_tx.send(messaging::DaemonMessage::HideWindow);
    }

    pub fn request_quit(&self) {
        self.quit_requested.store(true, Ordering::Relaxed);
        // Send SIGTERM to Chrome process
        if let Ok(guard) = self.chrome_pid.try_lock() {
            if let Some(pid) = *guard {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
        }
        // Wake the show_signal in case we're waiting on it
        self.show_signal.notify_waiters();
    }

}

/// Main entry point for the service daemon.
pub async fn run(service_name: ServiceName, minimized: bool) -> Result<()> {
    let definition = service::get_definition(&service_name);
    let global_config = GlobalConfig::load()?;
    let service_config = ServiceConfig::load(&service_name)?;

    // 1. Singleton check via D-Bus
    match dbus::is_already_running(definition).await {
        Ok(true) => {
            tracing::info!("Service {} is already running, sending Show() and exiting", definition.display_name);
            dbus::call_show(definition).await?;
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => {
            tracing::warn!("Could not check D-Bus singleton (continuing anyway): {}", e);
        }
    }

    // 2. Shared state
    let state = Arc::new(DaemonState::new(service_config.do_not_disturb, minimized));

    // 3. Register D-Bus service
    let _dbus_conn = dbus::register(
        definition,
        dbus::LoftService {
            state: Arc::clone(&state),
        },
    )
    .await
    .context("Failed to register D-Bus service")?;

    // 4. Detect Chrome
    let chrome_info = chrome::detect_chrome(&global_config)?;
    tracing::info!(
        "Found Chrome: {} ({})",
        chrome_info.path,
        match chrome_info.launch_method {
            chrome::LaunchMethod::Direct => "direct",
            chrome::LaunchMethod::Flatpak => "flatpak",
            chrome::LaunchMethod::AppImage => "appimage",
        }
    );

    // 5. Spawn tray icon (retry with backoff — at login the SNI watcher
    //    D-Bus service may not be available yet)
    let icon_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("~/.local/share"))
        .join("loft/icons")
        .join(definition.app_icon_filename);

    let mut tray_handle = None;
    let retry_delays = [0, 2, 4, 8, 16];
    for (attempt, &delay_secs) in retry_delays.iter().enumerate() {
        if delay_secs > 0 {
            tracing::info!(
                "Tray icon unavailable, retrying in {}s (attempt {}/{})",
                delay_secs,
                attempt + 1,
                retry_delays.len()
            );
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }
        let loft_tray = tray::LoftTray::new(
            definition.name.to_string(),
            definition.display_name.to_string(),
            service_config.do_not_disturb,
            definition.tray_icon_name(),
            &icon_path,
            Arc::clone(&state),
        );
        match tray::spawn_tray(loft_tray, Arc::clone(&state)).await {
            Ok(handle) => {
                tray_handle = Some(handle);
                break;
            }
            Err(e) => {
                if attempt == retry_delays.len() - 1 {
                    return Err(anyhow::anyhow!("Failed to spawn tray icon after {} attempts: {:?}", retry_delays.len(), e));
                }
                tracing::warn!("Tray icon spawn failed: {:?}", e);
            }
        }
    }
    let _tray_handle = tray_handle.unwrap();
    tracing::info!("Tray icon spawned for {}", definition.display_name);

    // 6. Start native messaging socket server
    let cmd_tx = state.cmd_tx.clone();
    tokio::spawn(messaging::start_socket_server(
        definition.name.to_string(),
        Arc::clone(&state),
        cmd_tx,
    ));

    // 6b. Start GNOME Shell extension handler (parallel to NM relay)
    {
        let wm_class = definition.chrome_desktop_id.to_string();
        let mut cmd_rx = state.cmd_tx.subscribe();
        tokio::spawn(async move {
            loop {
                match cmd_rx.recv().await {
                    Ok(messaging::DaemonMessage::ShowWindow) => {
                        match gnome_shell::focus_window(&wm_class).await {
                            Ok(true) => tracing::debug!("GNOME Shell focused window"),
                            Ok(false) => tracing::debug!("GNOME Shell: window not found"),
                            Err(e) => tracing::debug!("GNOME Shell helper unavailable: {}", e),
                        }
                    }
                    Ok(messaging::DaemonMessage::HideWindow) => {
                        match gnome_shell::hide_window(&wm_class).await {
                            Ok(true) => tracing::debug!("GNOME Shell hid window"),
                            Ok(false) => tracing::debug!("GNOME Shell: window not found"),
                            Err(e) => tracing::debug!("GNOME Shell helper unavailable: {}", e),
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("GNOME Shell handler lagged {} messages", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // 7. Set up signal handling
    let signal_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("Failed to register SIGTERM handler");
        let mut sigint =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
                .expect("Failed to register SIGINT handler");
        tokio::select! {
            _ = sigterm.recv() => tracing::info!("Received SIGTERM"),
            _ = sigint.recv() => tracing::info!("Received SIGINT"),
        }
        signal_state.request_quit();
    });

    // 8. Run Chrome lifecycle loop
    let manager = ChromeManager::new(chrome_info, definition, Arc::clone(&state));
    manager.run_loop().await
}

/// Manages the Chrome process lifecycle: spawn, monitor, respawn, hide, quit.
struct ChromeManager {
    chrome_info: ChromeInfo,
    definition: &'static ServiceDefinition,
    state: Arc<DaemonState>,
}

impl ChromeManager {
    fn new(
        chrome_info: ChromeInfo,
        definition: &'static ServiceDefinition,
        state: Arc<DaemonState>,
    ) -> Self {
        Self {
            chrome_info,
            definition,
            state,
        }
    }

    async fn run_loop(&self) -> Result<()> {
        let mut wait_for_show = false;

        loop {
            // Wait for Show signal when Chrome has exited (hide-to-tray state)
            if wait_for_show {
                tracing::info!("Chrome hidden, waiting for Show signal...");
                self.state.show_signal.notified().await;

                if self.state.quit_requested.load(Ordering::Relaxed) {
                    tracing::info!("Quit requested, shutting down daemon");
                    return Ok(());
                }
                wait_for_show = false;
            }

            // Spawn Chrome
            let mut child = self.spawn_chrome().await?;
            let pid = child.id();
            *self.state.chrome_pid.lock().await = pid;
            self.state.visible.store(true, Ordering::Relaxed);
            tracing::info!("Chrome launched (pid: {:?})", pid);

            let start_time = Instant::now();

            // Wait for Chrome to exit (extension handles show/hide via
            // chrome.windows.update while Chrome is running).
            child.wait().await?;
            *self.state.chrome_pid.lock().await = None;
            self.state.visible.store(false, Ordering::Relaxed);

            let run_duration = start_time.elapsed();

            if self.state.quit_requested.load(Ordering::Relaxed) {
                tracing::info!("Quit requested, shutting down daemon");
                return Ok(());
            }

            tracing::info!(
                "Chrome exited after {:.1}s — hiding to tray",
                run_duration.as_secs_f64()
            );
            wait_for_show = true;
        }
    }

    async fn spawn_chrome(&self) -> Result<Child> {
        let profile = chrome::profile_path(self.definition.name);
        let extension = chrome::extension_path();

        // Ensure profile directory exists
        std::fs::create_dir_all(&profile)
            .with_context(|| format!("Failed to create profile dir {}", profile.display()))?;

        let args = chrome::build_chrome_args(self.definition, &profile);
        let mut cmd = chrome::build_chrome_command(&self.chrome_info, &args);

        // Set up CDP pipes for loading the extension.
        // Chrome 137+ removed --load-extension from branded builds, so we use
        // --remote-debugging-pipe + CDP Extensions.loadUnpacked instead.
        // Chrome reads commands from fd 3, writes responses to fd 4.
        let (daemon_read_fd, daemon_write_fd, chrome_read_fd, chrome_write_fd) = unsafe {
            let mut pipe_in = [0i32; 2]; // daemon writes -> Chrome reads on fd 3
            let mut pipe_out = [0i32; 2]; // Chrome writes on fd 4 -> daemon reads

            if libc::pipe(pipe_in.as_mut_ptr()) != 0 {
                return Err(anyhow::anyhow!("Failed to create CDP input pipe"));
            }
            if libc::pipe(pipe_out.as_mut_ptr()) != 0 {
                libc::close(pipe_in[0]);
                libc::close(pipe_in[1]);
                return Err(anyhow::anyhow!("Failed to create CDP output pipe"));
            }

            let chrome_read_fd = pipe_in[0];
            let daemon_write_fd = pipe_in[1];
            let daemon_read_fd = pipe_out[0];
            let chrome_write_fd = pipe_out[1];

            use std::os::unix::process::CommandExt;
            cmd.pre_exec(move || {
                // Chrome expects its CDP pipe on fd 3 (read) and fd 4 (write)
                if libc::dup2(chrome_read_fd, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::dup2(chrome_write_fd, 4) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                // Close the original fds (they're now on 3 and 4)
                libc::close(chrome_read_fd);
                libc::close(chrome_write_fd);
                // Close daemon-side fds in the child
                libc::close(daemon_write_fd);
                libc::close(daemon_read_fd);
                Ok(())
            });

            (daemon_read_fd, daemon_write_fd, chrome_read_fd, chrome_write_fd)
        };

        // Spawn Chrome
        let child = tokio::process::Command::from(cmd)
            .spawn()
            .context("Failed to spawn Chrome")?;

        // Close Chrome's side of the pipes in the parent
        unsafe {
            libc::close(chrome_read_fd);
            libc::close(chrome_write_fd);
        }

        // Load extension via CDP in a blocking task (pipe I/O is synchronous)
        let ext_path = extension.to_string_lossy().to_string();
        tokio::task::spawn_blocking(move || {
            load_extension_via_cdp(daemon_read_fd, daemon_write_fd, &ext_path)
        })
        .await??;

        // Fix Chrome's auto-generated .desktop file for --app= mode.
        // Chrome overwrites e.g. "chrome-web.whatsapp.com__-Default.desktop"
        // with NoDisplay=true and NO Exec= line on every launch. This causes:
        // 1. GNOME crash on notification click (strlen(NULL) in Mutter)
        // 2. Generic icon / raw class name in alt-tab
        // Overwrite it with our version that has a valid Exec=, Name, and Icon.
        // We write immediately AND again after a delay, because Chrome may
        // (re)create its broken version after our first write.
        if let Err(e) = crate::desktop::create_chrome_desktop_file(self.definition) {
            tracing::warn!("Failed to fix Chrome desktop file: {}", e);
        }
        let definition = self.definition;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if let Err(e) = crate::desktop::create_chrome_desktop_file(definition) {
                tracing::warn!("Failed to fix Chrome desktop file (delayed): {}", e);
            }
        });

        Ok(child)
    }
}

/// Load an unpacked extension via Chrome DevTools Protocol pipe.
///
/// Sends `Extensions.loadUnpacked` on the CDP pipe and reads the response.
/// The pipe fds are intentionally kept open (leaked) — Chrome exits on pipe EOF.
fn load_extension_via_cdp(read_fd: i32, write_fd: i32, extension_path: &str) -> Result<()> {
    use std::io::{Read, Write};
    use std::os::unix::io::FromRawFd;

    // ManuallyDrop prevents the File destructors from closing the pipe fds.
    // Chrome exits if the debugging pipe is closed (EOF = shutdown), so the
    // fds must remain open for the lifetime of the Chrome process.
    let mut writer = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(write_fd) });
    let mut reader = std::mem::ManuallyDrop::new(unsafe { std::fs::File::from_raw_fd(read_fd) });

    // Wait briefly for Chrome to initialize the CDP pipe
    std::thread::sleep(std::time::Duration::from_secs(2));

    // Send Extensions.loadUnpacked command
    let cmd = serde_json::json!({
        "id": 1,
        "method": "Extensions.loadUnpacked",
        "params": {
            "path": extension_path
        }
    });
    let mut msg = serde_json::to_vec(&cmd)?;
    msg.push(0x00); // CDP pipe delimiter

    writer.write_all(&msg)?;
    writer.flush()?;
    tracing::debug!("Sent CDP Extensions.loadUnpacked for {}", extension_path);

    // Read response (may be preceded by events, look for our id:1 response)
    let mut buf = vec![0u8; 8192];
    let mut accumulated = Vec::new();

    // Read with a timeout (Chrome may take a moment to respond)
    // Set the read fd to non-blocking temporarily
    unsafe {
        let flags = libc::fcntl(read_fd, libc::F_GETFL);
        libc::fcntl(read_fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => {
                accumulated.extend_from_slice(&buf[..n]);
                // Check for null-delimited messages
                while let Some(pos) = accumulated.iter().position(|&b| b == 0x00) {
                    let msg_bytes = &accumulated[..pos];
                    if let Ok(response) = serde_json::from_slice::<serde_json::Value>(msg_bytes) {
                        if response.get("id") == Some(&serde_json::json!(1)) {
                            if let Some(result) = response.get("result") {
                                let ext_id = result.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                                tracing::info!("Extension loaded via CDP (id: {})", ext_id);
                                return Ok(());
                            }
                            if let Some(error) = response.get("error") {
                                let err_msg = error.get("message").and_then(|v| v.as_str()).unwrap_or("unknown");
                                return Err(anyhow::anyhow!("CDP Extensions.loadUnpacked failed: {}", err_msg));
                            }
                        } else {
                            tracing::trace!("CDP event: {}", response);
                        }
                    }
                    accumulated = accumulated[pos + 1..].to_vec();
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() > deadline {
                    return Err(anyhow::anyhow!("Timeout waiting for CDP response"));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e.into()),
        }
    }

    Err(anyhow::anyhow!("CDP pipe closed without response"))
}
