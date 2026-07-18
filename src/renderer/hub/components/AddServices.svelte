<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import AvailableTile from './AvailableTile.svelte';
  let { state }: { state: HubState } = $props();
  const available = $derived(state.services.filter((s) => !s.installed));
</script>

<h2>Add a service</h2>
{#if available.length > 0}
  <p class="lead">Pick a messaging service to add to Loft.</p>
  <div class="grid">
    {#each available as svc (svc.id)}<AvailableTile {svc} />{/each}
  </div>
{:else}
  <section class="empty">
    <img class="logo" src="loft://icon/loft" alt="" />
    <p>You've added every service Loft supports.</p>
  </section>
{/if}

<style>
  h2 { margin: 8px 0 6px; }
  .lead { margin: 0 0 16px; opacity: 0.7; }
  /* auto-fill so the gallery fills the wide pane instead of a lonely 2-up column. */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px; }
  .empty { text-align: center; padding: 40px 0; opacity: 0.7; }
  .empty .logo { width: 64px; height: 64px; margin-bottom: 12px; }
</style>
