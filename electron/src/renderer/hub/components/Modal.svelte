<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    title,
    confirmLabel = 'OK',
    destructive = false,
    confirmDisabled = false,
    onConfirm,
    onCancel,
    children,
  }: {
    title: string;
    confirmLabel?: string;
    destructive?: boolean;
    confirmDisabled?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    children: Snippet;
  } = $props();

  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
</script>

<svelte:window onkeydown={onKey} />
<div class="backdrop" onclick={onCancel} role="presentation">
  <div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
    <h2>{title}</h2>
    <div class="body">{@render children()}</div>
    <div class="actions">
      <button class="cancel" onclick={onCancel}>Cancel</button>
      <button class="confirm" class:destructive disabled={confirmDisabled} onclick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--bg); color: var(--fg); border: 1px solid var(--divider); border-radius: 12px; padding: 20px; min-width: 320px; max-width: 90vw; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
  h2 { margin: 0 0 12px; font-size: 1.1em; }
  .body { margin-bottom: 20px; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  button { border: 0; border-radius: 8px; padding: 7px 16px; cursor: pointer; font: inherit; }
  button:disabled { opacity: 0.5; cursor: default; }
  .cancel { background: var(--card); color: var(--fg); }
  .confirm { background: var(--accent); color: #fff; }
  .confirm.destructive { background: #c01c28; }
</style>
