<script lang="ts">
  import { onMount } from 'svelte';
  import { hubState, initStore } from './lib/store';
  import ServiceList from './components/ServiceList.svelte';

  let view = $state<{ page: 'main' } | { page: 'detail'; id: string } | { page: 'settings' } | { page: 'about' }>({ page: 'main' });
  let menuOpen = $state(false);
  onMount(initStore);

  function gear(id: string) { view = { page: 'detail', id }; }
</script>

<header>
  <span class="title">Loft</span>
  <div class="menu">
    <button class="hamburger" onclick={() => (menuOpen = !menuOpen)} aria-label="Menu">≡</button>
    {#if menuOpen}
      <div class="dropdown" role="menu">
        <button onclick={() => { view = { page: 'settings' }; menuOpen = false; }}>Settings</button>
        <button onclick={() => { view = { page: 'about' }; menuOpen = false; }}>About</button>
        <button onclick={() => window.loftHub.quit()}>Quit</button>
      </div>
    {/if}
  </div>
</header>

<main>
  {#if $hubState}
    {#if view.page === 'main'}
      <ServiceList state={$hubState} onGear={gear} />
    {:else}
      <button class="back" onclick={() => (view = { page: 'main' })}>‹ Back</button>
      <!-- detail / settings / about panels land in Task 9 -->
    {/if}
  {/if}
</main>

<style>
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--divider); }
  .title { font-weight: 700; }
  .menu { position: relative; }
  .hamburger { border: 0; background: transparent; font-size: 1.3em; cursor: pointer; }
  .dropdown { position: absolute; right: 0; top: 100%; background: var(--card); border: 1px solid var(--divider); border-radius: 8px; display: flex; flex-direction: column; min-width: 140px; z-index: 10; }
  .dropdown button { border: 0; background: transparent; text-align: left; padding: 8px 12px; cursor: pointer; }
  .dropdown button:hover { background: var(--divider); }
  main { padding: 0 16px 16px; }
  .back { border: 0; background: transparent; cursor: pointer; padding: 12px 0; font: inherit; opacity: 0.7; }
</style>
