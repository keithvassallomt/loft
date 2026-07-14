<script lang="ts">
  import type { HubState } from '../../../shared/hubTypes';
  import ServiceRow from './ServiceRow.svelte';
  import AvailableTile from './AvailableTile.svelte';
  let { state, onGear }: { state: HubState; onGear: (id: string) => void } = $props();

  const installed = $derived(state.services.filter((s) => s.installed));
  const available = $derived(state.services.filter((s) => !s.installed));
</script>

{#if installed.length === 0}
  <section class="welcome">
    <img class="logo" src="loft://icon/loft" alt="" />
    <h2>Welcome to Loft</h2>
    <p>Add a messaging service below to get started.</p>
  </section>
{:else}
  <section>
    <h3>Installed</h3>
    <div class="list">
      {#each installed as svc (svc.id)}<ServiceRow {svc} {onGear} />{/each}
    </div>
  </section>
{/if}

{#if available.length > 0}
  <section>
    <h3>Available</h3>
    <div class="grid">
      {#each available as svc (svc.id)}<AvailableTile {svc} />{/each}
    </div>
  </section>
{/if}

<style>
  section { margin: 18px 0; }
  h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 0 0 8px; }
  .list { background: var(--card); border-radius: 12px; overflow: hidden; }
  .list > :global(.row + .row) { border-top: 1px solid var(--divider); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .welcome { text-align: center; padding: 32px 0; }
  .logo { width: 64px; height: 64px; }
</style>
