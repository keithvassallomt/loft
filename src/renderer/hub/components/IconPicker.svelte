<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc }: { svc: HubService } = $props();

  let error = $state('');

  // Cache-busting: the deployed PNG changes under a stable loft://icon/<id> URL, so
  // without a changing query the swatch and the rail both keep the old bytes.
  let rev = $state(0);

  async function choose(choice: string) {
    error = '';
    const res = await window.loftHub.setServiceIcon(svc.id, choice);
    if (!res.ok) error = res.error ?? 'Could not change the icon.';
    else rev++;
  }

  const label = (c: string) => c.charAt(0).toUpperCase() + c.slice(1);
</script>

<div class="field">
  <span>Icon</span>
  <div class="row">
    <button class="sw" class:on={svc.icon === 'brand'} title="Default"
            onclick={() => choose('brand')} aria-label="Default icon">
      <img src={`loft://icon/${svc.kind}`} alt="" />
    </button>
    {#each svc.variants as colour (colour)}
      <button class="sw" class:on={svc.icon === colour} title={label(colour)}
              onclick={() => choose(colour)} aria-label={`${label(colour)} icon`}>
        <img src={`loft://icon/${svc.kind}?v=${colour}`} alt="" />
      </button>
    {/each}
    <button class="file" onclick={() => choose('custom')}>Choose a file…</button>
  </div>
  {#if svc.icon === 'custom'}
    <div class="row">
      <span class="sw on"><img src={`loft://icon/${svc.id}?r=${rev}`} alt="" /></span>
      <small class="hint">Using your own image.</small>
    </div>
  {/if}
  {#if error}<small class="err">{error}</small>{/if}
</div>

<style>
  .field { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sw {
    width: 40px; height: 40px; padding: 3px; border-radius: 10px; cursor: pointer;
    border: 2px solid transparent; background: var(--card); display: grid; place-items: center;
  }
  .sw.on { border-color: var(--accent); }
  .sw img { width: 100%; height: 100%; object-fit: contain; }
  .file { border: 1px solid var(--divider); background: var(--card); color: var(--fg); border-radius: 999px; padding: 8px 16px; cursor: pointer; font: inherit; }
  .hint { color: var(--muted, #777); font-size: 12px; }
  .err { color: #c01c28; font-size: 12px; }
</style>
