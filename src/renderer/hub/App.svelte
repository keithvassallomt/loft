<script lang="ts">
  import { onMount } from 'svelte';
  import { hubState, initStore } from './lib/store';
  import { managerNav, resolveSelection, type ManagerSelection } from './managerModel';
  import AddServices from './components/AddServices.svelte';
  import ServiceDetail from './components/ServiceDetail.svelte';
  import GlobalSettings from './components/GlobalSettings.svelte';
  import About from './components/About.svelte';

  let selection = $state<ManagerSelection>('add');
  onMount(() => {
    initStore();
    // Right-click a rail icon → "Settings…" asks the manager to open that service.
    window.loftHub.onSelect((id) => { selection = { service: id }; });
  });

  // A service can vanish while its detail is open (removed here or elsewhere); fold an
  // orphaned selection back to Add so the pane never renders a missing service.
  const view = $derived($hubState ? resolveSelection(selection, $hubState) : 'add');
  const nav = $derived($hubState ? managerNav($hubState) : { configure: [] });
  const isService = (s: ManagerSelection): s is { service: string } => typeof s === 'object';
</script>

{#if $hubState}
  <div class="shell">
    <nav class="side" aria-label="Manager">
      <button class="n" class:on={view === 'add'} onclick={() => (selection = 'add')}>Add a service</button>

      {#if nav.configure.length > 0}
        <p class="sec">Configure</p>
        {#each nav.configure as c (c.id)}
          <button class="n" class:on={isService(view) && view.service === c.id}
                  onclick={() => (selection = { service: c.id })}>{c.displayName}</button>
        {/each}
      {/if}

      <div class="foot">
        <button class="n" class:on={view === 'settings'} onclick={() => (selection = 'settings')}>Settings</button>
        <button class="n" class:on={view === 'about'} onclick={() => (selection = 'about')}>About</button>
        <button class="n" onclick={() => window.loftHub.quit()}>Quit Loft</button>
      </div>
    </nav>

    <section class="pane">
      {#if view === 'add'}
        <AddServices state={$hubState} />
      {:else if view === 'settings'}
        <GlobalSettings state={$hubState} />
      {:else if view === 'about'}
        <About version={__LOFT_VERSION__} />
      {:else if isService(view)}
        <ServiceDetail state={$hubState} id={view.service} onDone={() => (selection = 'add')} />
      {/if}
    </section>
  </div>
{/if}

<style>
  .shell { flex: 1 1 auto; display: flex; min-height: 0; }
  .side {
    flex: 0 0 208px; display: flex; flex-direction: column; gap: 2px;
    padding: 12px 10px; border-right: 1px solid var(--divider); overflow-y: auto;
  }
  .side .n {
    text-align: left; border: 0; background: transparent; color: var(--fg);
    font: inherit; padding: 8px 10px; border-radius: 8px; cursor: pointer;
  }
  .side .n:hover { background: var(--card); }
  .side .n.on { background: var(--accent); color: #fff; }
  .side .sec {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.5; margin: 12px 10px 2px;
  }
  .side .foot { margin-top: auto; }
  .pane { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 18px 22px; }
</style>
