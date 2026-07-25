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
  const isService = (s: ManagerSelection): s is { service: string } =>
    typeof s === 'object' && s !== null;
</script>

{#if $hubState}
  <div class="shell">
    <nav class="side" aria-label="Manager">
      <button class="n" class:on={view === 'add'} aria-current={view === 'add' ? 'page' : undefined}
              onclick={() => (selection = 'add')}>Add a service</button>

      {#if nav.configure.length > 0}
        <p class="sec">Configure</p>
        {#each nav.configure as c (c.id)}
          <button class="n svc" class:on={isService(view) && view.service === c.id}
                  aria-current={isService(view) && view.service === c.id ? 'page' : undefined}
                  onclick={() => (selection = { service: c.id })}>
            <!-- ?e=<epoch> busts Chromium's cache under the stable loft://icon/<id> URL, so a
                 changed icon updates this nav list without a full reload (see the rail). -->
            <img class="ico" src={`loft://icon/${c.id}?e=${$hubState.globals.iconEpoch}`} alt=""
                 onerror={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
            <span>{c.displayName}</span>
          </button>
        {/each}
      {/if}

      <div class="foot">
        <button class="n" class:on={view === 'settings'} aria-current={view === 'settings' ? 'page' : undefined}
                onclick={() => (selection = 'settings')}>Settings</button>
        <button class="n" class:on={view === 'about'} aria-current={view === 'about' ? 'page' : undefined}
                onclick={() => (selection = 'about')}>About</button>
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
  .side .n.svc { display: flex; align-items: center; gap: 8px; }
  /* display:none rather than AvailableTile's visibility:hidden — a tile centres a
     fixed-size icon, but this is a row, so a missing icon should collapse rather than
     leave the label indented. */
  .side .ico { width: 18px; height: 18px; border-radius: 4px; flex: none; }
  .side .sec {
    font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.5; margin: 12px 10px 2px;
  }
  /* A plain div lays its buttons out inline-block, so Settings / About / Quit Loft sat on
     one line. Flex-column stacks them; the border-top separates them from the service list
     above. margin-top:auto keeps the whole group pinned to the bottom of the sidebar. */
  .side .foot {
    margin-top: auto; display: flex; flex-direction: column; gap: 2px;
    border-top: 1px solid var(--divider); padding-top: 8px;
  }
  .pane { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; padding: 18px 22px; }
</style>
