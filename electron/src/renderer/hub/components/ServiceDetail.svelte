<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  // NOTE: destructured local is renamed from `state` to `hubState` (the public
  // prop name is still `state`, matching App.svelte's `<ServiceDetail state=...>`).
  // A local binding literally named `state` collides with the `$state` rune below
  // (Svelte reparses `$state` as a store auto-subscription of that binding), which
  // makes `store_get()` throw at mount time since a plain HubState object has no
  // `.subscribe`. See https://svelte.dev/e/store_rune_conflict.
  let { state: hubState, id, onBack }: { state: HubState; id: string; onBack: () => void } = $props();
  const svc = $derived(hubState.services.find((s) => s.id === id)!);

  function set(patch: Parameters<typeof window.loftHub.setServiceSetting>[1]) {
    window.loftHub.setServiceSetting(id, patch);
  }
  let urlDraft = $state('');
  $effect(() => { urlDraft = svc?.customUrl ?? ''; });

  function remove() {
    const del = window.confirm(`Remove ${svc.displayName}?\n\nClick OK to also delete its login data, Cancel to keep it.`);
    // Two-step: confirm removal, then whether to wipe data.
    if (!window.confirm(`Remove ${svc.displayName}?`)) return;
    window.loftHub.removeService(id, del);
    onBack();
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
  <label class="toggle">
    <input type="checkbox" checked={svc.badgesEnabled} onchange={(e) => set({ badgesEnabled: e.currentTarget.checked })} />
    <span>Show unread badge</span>
  </label>
  <label class="toggle">
    <input type="checkbox" checked={svc.dnd} onchange={(e) => set({ dnd: e.currentTarget.checked })} />
    <span>Do Not Disturb</span>
  </label>

  <button class="danger" onclick={remove}>Remove {svc.displayName}…</button>
{/if}

<style>
  h2 { margin: 8px 0 16px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field input { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .toggle { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
  .toggle span { flex: 1; }
  .danger { margin-top: 24px; border: 0; border-radius: 999px; padding: 8px 18px; background: #c01c28; color: #fff; cursor: pointer; }
</style>
