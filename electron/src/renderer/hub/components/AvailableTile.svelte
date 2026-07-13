<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  import Modal from './Modal.svelte';
  let { svc }: { svc: HubService } = $props();

  let showUrlModal = $state(false);
  let urlDraft = $state('');

  function add() {
    if (svc.selfHosted) { urlDraft = ''; showUrlModal = true; }
    else window.loftHub.addService(svc.id);
  }
  function confirmAdd() {
    showUrlModal = false;
    window.loftHub.addService(svc.id, urlDraft.trim() || undefined);
  }
</script>

<div class="tile">
  <img class="icon" src={`loft://icon/${svc.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <span class="name">{svc.displayName}</span>
  <button class="pill" onclick={add}>Add</button>
</div>

{#if showUrlModal}
  <Modal
    title={`Add ${svc.displayName}`}
    confirmLabel="Add"
    confirmDisabled={urlDraft.trim() === ''}
    onConfirm={confirmAdd}
    onCancel={() => (showUrlModal = false)}
  >
    <label class="field">
      <span>Server URL</span>
      <input bind:value={urlDraft} placeholder="cloud.example.com" />
    </label>
  </Modal>
{/if}

<style>
  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--card); border-radius: 12px; }
  .icon { width: 44px; height: 44px; border-radius: 10px; }
  .name { font-weight: 600; }
  .pill { border: 0; border-radius: 999px; padding: 5px 16px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field input { padding: 8px; border-radius: 8px; border: 1px solid var(--divider); background: var(--bg); color: var(--fg); }
</style>
