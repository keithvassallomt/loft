pub mod combined_tray;
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
use crate::config::{GlobalConfig, ServiceConfig, TrayBackend};
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
    pub show_titlebar: AtomicBool,
    pub badges_enabled: AtomicBool,
    /// Whether to use the combined tray icon instead of per-service icons.
    pub combine_tray: AtomicBool,
    /// Notified when `combine_tray` changes, causing the tray lifecycle to switch modes.
    pub tray_mode_changed: Notify,
    pub show_signal: Notify,
    pub chrome_pid: tokio::sync::Mutex<Option<u32>>,
    /// Broadcast channel for sending commands to the extension via native messaging.
    pub cmd_tx: tokio::sync::broadcast::Sender<messaging::DaemonMessage>,
}

impl DaemonState {
    pub fn new(
        dnd: bool,
        minimized: bool,
        show_titlebar: bool,
        badges_enabled: bool,
        combine_tray: bool,
    ) -> Self {
        let (cmd_tx, _) = tokio::sync::broadcast::channel(16);
        Self {
            visible: AtomicBool::new(false),
            badge_count: AtomicU32::new(0),
            dnd: AtomicBool::new(dnd),
            quit_requested: AtomicBool::new(false),
            start_minimized: AtomicBool::new(minimized),
            show_titlebar: AtomicBool::new(show_titlebar),
            badges_enabled: AtomicBool::new(badges_enabled),
            combine_tray: AtomicBool::new(combine_tray),
            tray_mode_changed: Notify::new(),
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

    pub fn show_titlebar(&self) -> bool {
        self.show_titlebar.load(Ordering::Relaxed)
    }

    pub fn is_badges_enabled(&self) -> bool {
        self.badges_enabled.load(Ordering::Relaxed)
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
        // Kill Chrome's entire process group (negative pid) so renderer,
        // GPU, crashpad, and other helper processes all receive SIGTERM.
        if let Ok(guard) = self.chrome_pid.try_lock() {
            if let Some(pid) = *guard {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGTERM);
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
    let minimized = minimized || service_config.start_hidden;
    let state = Arc::new(DaemonState::new(
        service_config.do_not_disturb,
        minimized,
        service_config.show_titlebar,
        service_config.badges_enabled,
        global_config.combine_tray_icons,
    ));

    // 3. Register D-Bus service
    let _dbus_conn = dbus::register(
        definition,
        dbus::LoftService {
            state: Arc::clone(&state),
            service_name: service_name.to_string(),
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
            chrome::LaunchMethod::AppImage => "appimage",
        }
    );

    // 5. Tray/panel icon backend — switchable lifecycle
    let effective_backend = global_config.tray_backend.resolve();
    tracing::info!("Tray backend: {} (resolved: {})", global_config.tray_backend, effective_backend);

    // Spawn switchable tray lifecycle
    let tray_handle = tokio::spawn(manage_tray_lifecycle(
        Arc::clone(&state),
        definition,
        effective_backend,
    ));

    // Listen for CombineTrayChanged D-Bus signal (live toggle from Manager)
    {
        let signal_state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = listen_combine_tray_changed(signal_state).await {
                tracing::debug!("CombineTrayChanged listener ended: {}", e);
            }
        });
    }

    // 6. Start native messaging socket server
    let cmd_tx = state.cmd_tx.clone();
    tokio::spawn(messaging::start_socket_server(
        definition.name.to_string(),
        Arc::clone(&state),
        cmd_tx,
    ));

    // 6b. Start GNOME Shell extension handler for window focus/hide
    //     (always runs — handles FocusWindow/HideWindow D-Bus calls regardless of tray backend)
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
    let result = manager.run_loop().await;

    // 9. Wait for tray lifecycle to clean up (unregister from combined tray, etc.)
    //    Notify it so it wakes up and sees quit_requested.
    state.tray_mode_changed.notify_waiters();
    // Give the tray task a moment to unregister before the process exits
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tray_handle,
    ).await;

    result
}

/// Switchable tray lifecycle: runs either individual or combined tray mode,
/// switching between them when the CombineTrayChanged signal is received.
async fn manage_tray_lifecycle(
    state: Arc<DaemonState>,
    definition: &'static ServiceDefinition,
    effective_backend: TrayBackend,
) {
    let mut was_combined = false;

    loop {
        if state.quit_requested.load(Ordering::Relaxed) {
            break;
        }

        if state.combine_tray.load(Ordering::Relaxed) {
            was_combined = true;
            tracing::info!("Tray mode: combined");
            run_combined_tray_client(Arc::clone(&state), definition).await;
        } else {
            was_combined = false;
            match effective_backend {
                TrayBackend::GnomePanel => {
                    tracing::info!("Tray mode: GNOME panel (individual)");
                    run_gnome_panel_icon(Arc::clone(&state), definition).await;
                }
                TrayBackend::Sni | TrayBackend::Auto => {
                    tracing::info!("Tray mode: SNI (individual)");
                    run_sni_tray_icon(Arc::clone(&state), definition).await;
                }
            }
        }

        // The inner functions (run_combined_tray_client, run_gnome_panel_icon,
        // run_sni_tray_icon) already consume tray_mode_changed and return.
        // Just loop back to re-check the current mode.
    }

    // Clean up on quit: if we were in combined mode, unregister from the tray
    if was_combined {
        let _ = combined_tray::unregister(definition.name).await;
    }
}

/// Run the individual GNOME panel icon. Returns when `tray_mode_changed` fires
/// or quit is requested.
async fn run_gnome_panel_icon(state: Arc<DaemonState>, definition: &'static ServiceDefinition) {
    let svc_name = definition.name.to_string();
    let display_name = definition.display_name.to_string();
    let icon = definition.tray_icon_name();
    let wm_class = definition.chrome_desktop_id.to_string();

    // Register with retry
    let retry_delays = [0u64, 2, 4, 8, 16];
    for (attempt, &delay_secs) in retry_delays.iter().enumerate() {
        if delay_secs > 0 {
            tracing::info!(
                "GNOME panel icon unavailable, retrying in {}s (attempt {}/{})",
                delay_secs,
                attempt + 1,
                retry_delays.len()
            );
            tokio::time::sleep(std::time::Duration::from_secs(delay_secs)).await;
        }
        match gnome_shell::register_service(&svc_name, &display_name, &icon, &wm_class).await {
            Ok(()) => {
                tracing::info!("Registered GNOME panel icon for {}", display_name);
                break;
            }
            Err(e) => {
                if attempt == retry_delays.len() - 1 {
                    tracing::error!(
                        "Failed to register GNOME panel icon after {} attempts: {}",
                        retry_delays.len(),
                        e
                    );
                } else {
                    tracing::warn!("GNOME panel icon registration failed: {}", e);
                }
            }
        }
    }

    // Spawn shell helper restart monitor (cancel on mode change)
    let helper_state = Arc::clone(&state);
    let helper_svc = svc_name.clone();
    let helper_display = display_name.clone();
    let helper_icon = icon.clone();
    let helper_wm = wm_class.clone();
    let helper_handle = tokio::spawn(monitor_shell_helper_restart(
        helper_state,
        helper_svc,
        helper_display,
        helper_icon,
        helper_wm,
    ));

    // Sync loop: push DaemonState → GNOME Shell panel icon
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    let mut last_badge: u32 = u32::MAX;
    let mut last_visible: bool = false;
    let mut last_dnd: bool = false;

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if state.quit_requested.load(Ordering::Relaxed) {
                    break;
                }

                let raw_badge = state.badge_count.load(Ordering::Relaxed);
                let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
                let visible = state.visible.load(Ordering::Relaxed);
                let dnd = state.dnd.load(Ordering::Relaxed);

                if badge != last_badge {
                    last_badge = badge;
                    let _ = gnome_shell::update_badge(&svc_name, badge).await;
                }
                if visible != last_visible {
                    last_visible = visible;
                    let _ = gnome_shell::update_visible(&svc_name, visible).await;
                }
                if dnd != last_dnd {
                    last_dnd = dnd;
                    let _ = gnome_shell::update_dnd(&svc_name, dnd).await;
                }
            }
            _ = state.tray_mode_changed.notified() => {
                break;
            }
        }
    }

    // Clean up
    helper_handle.abort();
    let _ = gnome_shell::unregister_service(&svc_name).await;
}

/// Run the individual SNI tray icon. Returns when `tray_mode_changed` fires
/// or quit is requested.
async fn run_sni_tray_icon(state: Arc<DaemonState>, definition: &'static ServiceDefinition) {
    let icon_path = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("~/.local/share"))
        .join("loft/icons")
        .join(definition.app_icon_filename);

    let tray_respawn = Arc::new(tokio::sync::Notify::new());
    let stop = Arc::new(tokio::sync::Notify::new());

    let tray_handle = tokio::spawn(tray::run_tray_lifecycle(
        Arc::clone(&state),
        definition.name.to_string(),
        definition.display_name.to_string(),
        definition.tray_icon_name(),
        icon_path,
        Arc::clone(&tray_respawn),
        Arc::clone(&stop),
    ));

    let suspend_handle = tokio::spawn(monitor_suspend_resume(Arc::clone(&tray_respawn)));
    let watcher_handle = tokio::spawn(monitor_watcher_restart(Arc::clone(&tray_respawn)));

    // Wait for mode change
    state.tray_mode_changed.notified().await;

    // Stop everything
    stop.notify_waiters();
    tray_handle.abort();
    suspend_handle.abort();
    watcher_handle.abort();
}

/// Register with the combined tray process and sync state to it.
/// Returns when `tray_mode_changed` fires or quit is requested.
async fn run_combined_tray_client(
    state: Arc<DaemonState>,
    definition: &'static ServiceDefinition,
) {
    let svc_name = definition.name;
    let display_name = definition.display_name;
    let icon = definition.tray_icon_name();
    let wm_class = definition.chrome_desktop_id;

    // Spawn tray process if needed and register
    if let Err(e) = combined_tray::spawn_tray_if_needed().await {
        tracing::error!("Failed to start combined tray: {}", e);
    }

    let visible = state.visible.load(Ordering::Relaxed);
    let raw_badge = state.badge_count.load(Ordering::Relaxed);
    let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
    let dnd = state.dnd.load(Ordering::Relaxed);

    let mut registered = combined_tray::register(svc_name, display_name, &icon, wm_class, visible, badge, dnd).await.is_ok();
    if !registered {
        tracing::warn!("Initial registration with combined tray failed, will retry");
    }

    // Monitor combined tray D-Bus name — if it vanishes, re-spawn and re-register
    let respawn_state = Arc::clone(&state);
    let respawn_handle = tokio::spawn(async move {
        monitor_combined_tray_restart(respawn_state, definition).await;
    });

    // Sync loop — use register() instead of update_state() so that if
    // initial registration failed (tray not ready), the sync loop retries.
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    let mut last_badge: u32 = badge;
    let mut last_visible: bool = visible;
    let mut last_dnd: bool = dnd;

    loop {
        tokio::select! {
            _ = interval.tick() => {
                if state.quit_requested.load(Ordering::Relaxed) {
                    break;
                }

                let raw_badge = state.badge_count.load(Ordering::Relaxed);
                let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
                let visible = state.visible.load(Ordering::Relaxed);
                let dnd = state.dnd.load(Ordering::Relaxed);

                if !registered {
                    // Retry registration (Register is idempotent)
                    registered = combined_tray::register(
                        svc_name, display_name, &icon, wm_class, visible, badge, dnd,
                    ).await.is_ok();
                    if registered {
                        tracing::info!("Successfully registered with combined tray on retry");
                        last_badge = badge;
                        last_visible = visible;
                        last_dnd = dnd;
                    }
                } else if badge != last_badge || visible != last_visible || dnd != last_dnd {
                    last_badge = badge;
                    last_visible = visible;
                    last_dnd = dnd;
                    let _ = combined_tray::update_state(svc_name, visible, badge, dnd).await;
                }
            }
            _ = state.tray_mode_changed.notified() => {
                break;
            }
        }
    }

    // Clean up
    respawn_handle.abort();
    let _ = combined_tray::unregister(svc_name).await;
}

/// Monitor the `chat.loft.Tray` D-Bus name. When it vanishes, re-spawn
/// the combined tray process and re-register.
async fn monitor_combined_tray_restart(
    state: Arc<DaemonState>,
    definition: &'static ServiceDefinition,
) {
    use futures_util::StreamExt;

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Cannot monitor combined tray: {}", e);
            return;
        }
    };

    let rule = "type='signal',sender='org.freedesktop.DBus',\
                interface='org.freedesktop.DBus',\
                member='NameOwnerChanged',\
                arg0='chat.loft.Tray'";
    if let Err(e) = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule,),
        )
        .await
    {
        tracing::warn!("Failed to subscribe to combined tray name changes: {}", e);
        return;
    }

    let mut stream = zbus::MessageStream::from(&conn);
    while let Some(Ok(msg)) = stream.next().await {
        if state.quit_requested.load(Ordering::Relaxed) || !state.combine_tray.load(Ordering::Relaxed) {
            break;
        }
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("NameOwnerChanged") {
            continue;
        }
        if let Ok((name, _old, new_owner)) = msg.body().deserialize::<(String, String, String)>() {
            if name == "chat.loft.Tray" && new_owner.is_empty() {
                // Tray vanished — re-spawn after a brief pause
                tracing::info!("Combined tray vanished, re-spawning");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                if !state.combine_tray.load(Ordering::Relaxed) {
                    break;
                }
                if let Err(e) = combined_tray::spawn_tray_if_needed().await {
                    tracing::error!("Failed to re-spawn combined tray: {}", e);
                    continue;
                }
                let visible = state.visible.load(Ordering::Relaxed);
                let raw_badge = state.badge_count.load(Ordering::Relaxed);
                let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
                let dnd = state.dnd.load(Ordering::Relaxed);
                let _ = combined_tray::register(
                    definition.name,
                    definition.display_name,
                    &definition.tray_icon_name(),
                    definition.chrome_desktop_id,
                    visible,
                    badge,
                    dnd,
                )
                .await;
            }
        }
    }
}

/// Listen for the `CombineTrayChanged` D-Bus signal emitted by the Manager.
/// Updates `DaemonState.combine_tray` and notifies the tray lifecycle to switch.
async fn listen_combine_tray_changed(state: Arc<DaemonState>) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let conn = zbus::Connection::session().await?;

    let rule = "type='signal',\
                interface='chat.loft.Tray',\
                member='CombineTrayChanged',\
                path='/chat/loft/Tray'";
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "AddMatch",
        &(rule,),
    )
    .await?;

    let mut stream = zbus::MessageStream::from(&conn);
    while let Some(Ok(msg)) = stream.next().await {
        if state.quit_requested.load(Ordering::Relaxed) {
            break;
        }
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("CombineTrayChanged") {
            continue;
        }
        if let Ok((enabled,)) = msg.body().deserialize::<(bool,)>() {
            tracing::info!("CombineTrayChanged({}) signal received", enabled);
            state.combine_tray.store(enabled, Ordering::Relaxed);
            state.tray_mode_changed.notify_waiters();
        }
    }

    Ok(())
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
            }

            // Spawn Chrome
            let mut child = self.spawn_chrome().await?;
            let pid = child.id();
            *self.state.chrome_pid.lock().await = pid;
            self.state.visible.store(true, Ordering::Relaxed);
            tracing::info!("Chrome launched (pid: {:?})", pid);

            let start_time = Instant::now();

            // Wait for Chrome to exit. If it doesn't die within 5 seconds
            // of a quit request, send SIGKILL to the process group to ensure
            // all Chrome subprocesses are gone before the daemon exits.
            loop {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    child.wait()
                ).await {
                    Ok(result) => { result?; break; }
                    Err(_) if self.state.quit_requested.load(Ordering::Relaxed) => {
                        tracing::warn!("Chrome didn't exit after SIGTERM, sending SIGKILL");
                        if let Some(pid) = *self.state.chrome_pid.lock().await {
                            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                        }
                        child.wait().await?;
                        break;
                    }
                    Err(_) => continue, // timeout but not quitting — keep waiting
                }
            }
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

        // Ensure Chrome always prompts for download location (in --app= mode
        // there is no download shelf, so silent downloads confuse users).
        set_chrome_download_prompt(&profile);

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
                // Put Chrome in its own process group so kill(-pid, sig)
                // correctly signals Chrome and all its subprocesses.
                libc::setpgid(0, 0);

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

/// Configure Chrome download preferences for --app= mode.
///
/// Sets `download.prompt_for_download: true` (Save As dialog) and
/// `download.show_notifications: false` (suppress Chrome's own
/// download-complete notification) in the profile's Preferences JSON.
fn set_chrome_download_prompt(profile_path: &std::path::Path) {
    let prefs_dir = profile_path.join("Default");
    let prefs_file = prefs_dir.join("Preferences");

    let mut prefs: serde_json::Value = if prefs_file.exists() {
        match std::fs::read_to_string(&prefs_file) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({})),
            Err(_) => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };

    let prefs_obj = prefs.as_object_mut().unwrap();

    let download = prefs_obj
        .entry("download")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = download.as_object_mut() {
        obj.insert("prompt_for_download".to_string(), serde_json::json!(true));
        obj.insert("show_notifications".to_string(), serde_json::json!(false));
    }

    // Suppress the download bubble auto-popup (Chrome's in-window indicator)
    let bubble = prefs_obj
        .entry("download_bubble")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(obj) = bubble.as_object_mut() {
        obj.insert("partial_view_enabled".to_string(), serde_json::json!(false));
    }

    if let Err(e) = std::fs::create_dir_all(&prefs_dir) {
        tracing::warn!("Failed to create Chrome Default dir: {}", e);
        return;
    }
    if let Err(e) = std::fs::write(&prefs_file, serde_json::to_string_pretty(&prefs).unwrap_or_default()) {
        tracing::warn!("Failed to write Chrome Preferences: {}", e);
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

/// Monitor system suspend/resume via logind's `PrepareForSleep` D-Bus signal.
/// When the system resumes, notifies the tray lifecycle to respawn its icon
/// (the SNI watcher often loses track of items across suspend cycles).
async fn monitor_suspend_resume(respawn: std::sync::Arc<tokio::sync::Notify>) {
    use futures_util::StreamExt;

    let conn = match zbus::Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Cannot monitor suspend/resume (no system bus): {}", e);
            return;
        }
    };

    // Subscribe to the PrepareForSleep signal from logind
    let rule = "type='signal',sender='org.freedesktop.login1',\
                interface='org.freedesktop.login1.Manager',\
                member='PrepareForSleep'";
    if let Err(e) = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule,),
        )
        .await
    {
        tracing::warn!("Failed to subscribe to PrepareForSleep: {}", e);
        return;
    }

    tracing::debug!("Listening for suspend/resume events");
    let mut stream = zbus::MessageStream::from(&conn);

    while let Some(Ok(msg)) = stream.next().await {
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("PrepareForSleep") {
            continue;
        }
        if let Ok(body) = msg.body().deserialize::<(bool,)>() {
            if !body.0 {
                tracing::info!("Resumed from suspend, respawning tray icon");
                respawn.notify_one();
            }
        }
    }
}

/// Monitor the `chat.loft.ShellHelper` D-Bus name on the session bus.
/// When the GNOME Shell extension restarts (e.g. after suspend/resume, which
/// locks the screen and cycles disable/enable on all extensions), re-register
/// the panel icon and sync current badge/visible/DND state.
async fn monitor_shell_helper_restart(
    state: Arc<DaemonState>,
    svc_name: String,
    display_name: String,
    icon: String,
    wm_class: String,
) {
    use futures_util::StreamExt;

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Cannot monitor ShellHelper restart (no session bus): {}", e);
            return;
        }
    };

    let rule = "type='signal',sender='org.freedesktop.DBus',\
                interface='org.freedesktop.DBus',\
                member='NameOwnerChanged',\
                arg0='chat.loft.ShellHelper'";
    if let Err(e) = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule,),
        )
        .await
    {
        tracing::warn!("Failed to subscribe to ShellHelper name changes: {}", e);
        return;
    }

    tracing::debug!("Listening for ShellHelper restart events");
    let mut stream = zbus::MessageStream::from(&conn);

    while let Some(Ok(msg)) = stream.next().await {
        if state.quit_requested.load(Ordering::Relaxed) {
            break;
        }
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("NameOwnerChanged") {
            continue;
        }
        // NameOwnerChanged: (name, old_owner, new_owner)
        // We only care about the name appearing (old empty, new non-empty).
        if let Ok((name, old_owner, new_owner)) = msg.body().deserialize::<(String, String, String)>() {
            if name == "chat.loft.ShellHelper" && old_owner.is_empty() && !new_owner.is_empty() {
                tracing::info!("GNOME Shell helper restarted, re-registering panel icon for {}", svc_name);

                // Brief pause so the extension's D-Bus handler is ready
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;

                if let Err(e) = gnome_shell::register_service(&svc_name, &display_name, &icon, &wm_class).await {
                    tracing::warn!("Failed to re-register panel icon after shell restart: {}", e);
                    continue;
                }

                // Sync current state into the freshly created icon
                let raw_badge = state.badge_count.load(Ordering::Relaxed);
                let badge = if state.is_badges_enabled() { raw_badge } else { 0 };
                let visible = state.visible.load(Ordering::Relaxed);
                let dnd = state.dnd.load(Ordering::Relaxed);
                let _ = gnome_shell::update_badge(&svc_name, badge).await;
                let _ = gnome_shell::update_visible(&svc_name, visible).await;
                let _ = gnome_shell::update_dnd(&svc_name, dnd).await;
                tracing::info!("Panel icon re-registered and state synced (badge={}, visible={}, dnd={})", badge, visible, dnd);
            }
        }
    }
}

/// Monitor the `org.kde.StatusNotifierWatcher` bus name on the session bus.
/// When the watcher restarts (name owner changes), respawn the tray icon to
/// prevent the ksni crate's internal auto-re-registration from creating
/// duplicate entries in the watcher.
async fn monitor_watcher_restart(respawn: std::sync::Arc<tokio::sync::Notify>) {
    use futures_util::StreamExt;

    let conn = match zbus::Connection::session().await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("Cannot monitor StatusNotifierWatcher (no session bus): {}", e);
            return;
        }
    };

    let rule = "type='signal',sender='org.freedesktop.DBus',\
                interface='org.freedesktop.DBus',\
                member='NameOwnerChanged',\
                arg0='org.kde.StatusNotifierWatcher'";
    if let Err(e) = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "AddMatch",
            &(rule,),
        )
        .await
    {
        tracing::warn!("Failed to subscribe to StatusNotifierWatcher changes: {}", e);
        return;
    }

    tracing::debug!("Listening for StatusNotifierWatcher name changes");
    let mut stream = zbus::MessageStream::from(&conn);

    while let Some(Ok(msg)) = stream.next().await {
        let member = msg.header().member().map(|m| m.as_str().to_string());
        if member.as_deref() != Some("NameOwnerChanged") {
            continue;
        }
        // NameOwnerChanged args: (name, old_owner, new_owner)
        if let Ok(body) = msg.body().deserialize::<(String, String, String)>() {
            if body.0 == "org.kde.StatusNotifierWatcher" && !body.2.is_empty() {
                tracing::info!("StatusNotifierWatcher restarted, respawning tray icon");
                respawn.notify_one();
            }
        }
    }
}
