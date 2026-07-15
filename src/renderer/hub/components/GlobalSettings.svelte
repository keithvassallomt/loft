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

{#if g.autostartBlocked}
  <p class="warn">
    Loft was denied permission to start at login, so services set to open on startup won't open.
    Allow it in Settings → Apps → Loft.
  </p>
{/if}

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field em { opacity: 0.6; font-style: normal; font-size: 0.85em; }
  .field select { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .warn { margin: 12px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5a50a; background: #e5a50a1a; font-size: 0.9em; }
</style>
