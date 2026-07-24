<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import Modal from './Modal.svelte';
  import IconPicker from './IconPicker.svelte';
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

  let nameDraft = $state('');
  let nameError = $state('');
  $effect(() => { nameDraft = svc?.displayName ?? ''; });

  async function commitName() {
    nameError = '';
    if (nameDraft.trim() === svc.displayName) return;
    const res = await window.loftHub.renameService(id, nameDraft);
    // On rejection the field KEEPS what the user typed and says why — silently
    // reverting it reads as the app eating the keystrokes.
    if (!res.ok) nameError = res.error ?? 'Could not rename.';
  }

  // Cache-busting for the <h2> preview below: its src is keyed on svc.icon so a swatch
  // change re-fetches, but a custom icon keeps `icon === 'custom'` across re-picks of a
  // different file — this counter (mirrors IconPicker's own `rev`) covers that case too.
  let iconRev = $state(0);

  let showRemove = $state(false);
  let deleteData = $state(false);

  function confirmRemove() {
    showRemove = false;
    window.loftHub.removeService(id, deleteData);
    onDone();
  }
</script>

{#if svc}
  <h2>
    <img class="ico" src={`loft://icon/${id}?c=${svc.icon}-${iconRev}`} alt=""
         onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
    {svc.displayName}
  </h2>

  <label class="field">
    <span>Name</span>
    <input bind:value={nameDraft} onchange={commitName} />
    {#if nameError}<small class="err">{nameError}</small>{/if}
  </label>

  <IconPicker {svc} onChanged={() => iconRev++} />

  {#if svc.selfHosted}
    <label class="field">
      <span>Server URL{svc.serverRequired ? '' : ' (optional)'}</span>
      <input bind:value={urlDraft} placeholder="cloud.example.com" onchange={() => set({ customUrl: urlDraft.trim() })} />
      {#if !svc.serverRequired}
        <small class="hint">Leave blank to use {svc.defaultUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</small>
      {/if}
    </label>
  {/if}

  <fieldset class="autoopen">
    <legend>Auto Open</legend>
    {#each [
      { v: 'disabled', label: 'Disabled', hint: 'Never opens on its own.' },
      { v: 'login', label: 'On login', hint: 'Runs in the background from login — Loft starts automatically.' },
      { v: 'launch', label: 'On launching Loft', hint: 'Loads only when you open Loft, not at login.' },
    ] as o (o.v)}
      <label class="radio">
        <input type="radio" name={`autoopen-${id}`} value={o.v}
          checked={svc.autoOpen === o.v}
          onchange={() => set({ autoOpen: o.v as 'disabled' | 'login' | 'launch' })} />
        <span><strong>{o.label}</strong><em>{o.hint}</em></span>
      </label>
    {/each}
  </fieldset>
  <!-- Right here, not on the Settings page: the whole point of this feature is that
       choosing "On login" never claims something that isn't happening. Gated on this
       service's own mode so it only appears to someone it actually affects. -->
  {#if svc.autoOpen === 'login' && hubState.globals.autostartBlocked}
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
  h2 { margin: 8px 0 16px; display: flex; align-items: center; gap: 10px; }
  h2 .ico { width: 28px; height: 28px; border-radius: 6px; }
  .field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
  .field input { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
  .toggle { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
  .toggle span { flex: 1; }
  .autoopen { border: 1px solid var(--divider); border-radius: 8px; padding: 4px 12px 8px; margin: 12px 0; }
  .autoopen legend { padding: 0 6px; font-size: 0.85em; opacity: 0.7; }
  .radio { display: flex; align-items: flex-start; gap: 10px; padding: 6px 0; }
  .radio input { margin-top: 3px; }
  .radio span { display: flex; flex-direction: column; gap: 1px; }
  .radio em { opacity: 0.6; font-style: normal; font-size: 0.85em; }
  .warn { margin: 0 0 12px; padding: 10px 12px; border-radius: 8px; border: 1px solid #e5a50a; background: #e5a50a1a; font-size: 0.9em; }
  .danger { margin-top: 24px; border: 0; border-radius: 999px; padding: 8px 18px; background: #c01c28; color: #fff; cursor: pointer; }
  .remove-msg { margin: 0 0 12px; }
  .checkbox { display: flex; align-items: center; gap: 8px; }
  .trouble { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--divider); }
  .trouble h3 { font-size: 13px; margin-bottom: 8px; }
  .trouble button { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 999px; padding: 8px 18px; cursor: pointer; }
  .hint { color: var(--muted, #777); font-size: 12px; margin-top: 8px; }
  .err { color: #c01c28; font-size: 12px; }
</style>
