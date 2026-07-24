<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import AvailableTile from './AvailableTile.svelte';
  let { state }: { state: HubState } = $props();
  const fresh = $derived(state.kinds.filter((k) => k.instanceCount === 0));
  const more = $derived(state.kinds.filter((k) => k.instanceCount > 0));
</script>

<h2>Add a service</h2>
{#if fresh.length > 0}
  <p class="lead">Pick a messaging service to add to Loft.</p>
  <div class="grid">
    {#each fresh as kind (kind.id)}<AvailableTile {kind} />{/each}
  </div>
{:else}
  <section class="empty">
    <img class="logo" src="loft://icon/loft" alt="" />
    <p>You've added every service Loft supports.</p>
  </section>
{/if}

{#if more.length > 0}
  <hr />
  <h2>Add another</h2>
  <!-- Named for what it is FOR: a second account of a service you already use, each with
       its own login, name and icon. -->
  <p class="lead">Add a second account for a service you already use.</p>
  <div class="grid">
    {#each more as kind (kind.id)}<AvailableTile {kind} />{/each}
  </div>
{/if}

<style>
  h2 { margin: 8px 0 6px; }
  .lead { margin: 0 0 16px; opacity: 0.7; }
  hr { border: 0; border-top: 1px solid var(--divider); margin: 28px 0 20px; }
  /* auto-fill so the gallery fills the wide pane instead of a lonely 2-up column. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .empty { text-align: center; padding: 40px 0; opacity: 0.7; }
  .empty .logo { width: 64px; height: 64px; margin-bottom: 12px; }
</style>
