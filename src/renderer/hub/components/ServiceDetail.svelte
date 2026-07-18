<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import Modal from './Modal.svelte';
  // NOTE: destructured local is renamed from `state` to `hubState` (the public
  // prop name is still `state`, matching App.svelte's `<ServiceDetail state=...>`).
  // A local binding literally named `state` collides with the `$state` rune below
  // (Svelte reparses `$state` as a store auto-subscription of that binding), which
  // makes `store_get()` throw at mount time since a plain HubState object has no
  // `.subscribe`. See https://svelte.dev/e/store_rune_conflict.
  let { state: hubState, id, onDone }: { state: HubState; id: string; onDone: () => void } = $props();
  const svc = $derived(hubState.services.find((s) => s.id === id)!);

  function set(patch: Parameters<typeof window.loftHub.setServiceSetting>[1]) {
    window.loftHub.setServiceSetting(id, patch);
  }
  let urlDraft = $state('');
  $effect(() => { urlDraft = svc?.customUrl ?? ''; });

  let showRemove = $state(false);
  let deleteData = $state(false);

  function confirmRemove() {
    showRemove = false;
    window.loftHub.removeService(id, deleteData);
    onDone();
  }
</script>

{#if svc}
  <h2>{svc.displayName}</h2>

  {#if svc.selfHosted}
    <label class="field">
      <span>Server URL</span>
      <input bind:value={urlDraft} placeholder="cloud.example.com" onchange={() => set({ customUrl: urlDraft.trim() })} />
    </label>
  {/if}

  <label class="toggle">
    <input type="checkbox" checked={svc.openOnStartup} onchange={(e) => set({ openOnStartup: e.currentTarget.checked })} />
    <span>Open on startup</span>
  </label>
  <!-- Right here, not on the Settings page: the whole point of this feature is that
       ticking the box above never again claims something that isn't happening. Gated on
       this service's own flag so it only appears to someone it actually affects. -->
  {#if svc.openOnStartup && hubState.globals.autostartBlocked}
    <!-- "Run in Background" is the real control: GNOME's Apps panel has no autostart
         row (cc-applications-panel only exposes the portal's `background` permission),
         and the Background portal bundles the autostart grant into it. -->
    <p class="warn">
      Loft isn't allowed to start at login, so this won't take effect.
      Turn on “Run in Background” in Settings → Apps → Loft.
    </p>
  {/if}
  <label class="toggle">
    <input type="checkbox" checked={svc.badgesEnabled} onchange={(e) => set({ badgesEnabled: e.currentTarget.checked })} />
    <span>Show unread badge</span>
  </label>
  <label class="toggle">
    <input type="checkbox" checked={svc.dnd} onchange={(e) => set({ dnd: e.currentTarget.checked })} />
    <span>Do Not Disturb</span>
  </label>
  <label class="toggle">
    <input type="checkbox" checked={svc.launcher} onchange={(e) => set({ launcher: e.currentTarget.checked })} />
    <span>Create a desktop launcher</span>
  </label>

  <div class="trouble">
    <h3>Troubleshooting</h3>
    <button onclick={() => window.loftHub.recoverService(id, { clearCaches: true })}>Clear cache &amp; reload</button>
    <p class="hint">Keeps you signed in. Fixes {svc.displayName} if it’s stuck on a blank screen.</p>
  </div>

  <button class="danger" onclick={() => { deleteData = false; showRemove = true; }}>Remove {svc.displayName}…</button>

  {#if showRemove}
    <Modal title={`Remove ${svc.displayName}?`} confirmLabel="Remove" destructive onConfirm={confirmRemove} onCancel={() => (showRemove = false)}>
      <p class="remove-msg">This removes {svc.displayName} from your desktop.</p>
      <label class="checkbox"><input type="checkbox" bind:checked={deleteData} /> Also delete login data</label>
    </Modal>
  {/if}
{/if}

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field input { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .toggle { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
  .toggle span { flex: 1; }
  .warn { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5a50a; background: #e5a50a1a; font-size: 0.9em; }
  .danger { margin-top: 24px; border: 0; border-radius: 999px; padding: 8px 18px; background: #c01c28; color: #fff; cursor: pointer; }
  .remove-msg { margin: 0 0 12px; }
  .checkbox { display: flex; align-items: center; gap: 8px; }
  .trouble { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--divider); }
  .trouble h3 { font-size: 13px; margin-bottom: 8px; }
  .trouble button { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 999px; padding: 8px 18px; cursor: pointer; }
  .hint { color: var(--muted, #777); font-size: 12px; margin-top: 8px; }
</style>
