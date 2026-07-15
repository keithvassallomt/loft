<script lang="ts">
  import type { HubState, TrayBackend } from '../../../shared/hubTypes';
  let { state }: { state: HubState } = $props();
  const g = $derived(state.globals);
</script>

<h2>Settings</h2>

<label class="field">
  <span>Tray backend <em>(applies on restart)</em></span>
  <select value={g.trayBackend} onchange={(e) => window.loftHub.setGlobal({ trayBackend: e.currentTarget.value as TrayBackend })}>
    <option value="auto">Auto (recommended)</option>
    <option value="gnome-panel">GNOME Panel</option>
    <option value="sni">System Tray (SNI)</option>
  </select>
</label>

<!-- No "Start at login" toggle: autostart is derived from each service's "Open on
     startup". The autostartBlocked warning deliberately lives next to that checkbox
     (ServiceDetail.svelte), not here — this page is two clicks deep behind a menu the
     user has no reason to open, and the toggle it would have been anchored to is gone. -->

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field em { opacity: 0.6; font-style: normal; font-size: 0.85em; }
  .field select { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
</style>
