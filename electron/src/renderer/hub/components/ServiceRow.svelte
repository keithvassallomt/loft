<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc, onGear }: { svc: HubService; onGear: (id: string) => void } = $props();
</script>

<div class="row">
  <img class="icon" src={`loft://icon/${svc.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <div class="meta">
    <span class="name">{svc.displayName}</span>
    <span class="status" class:on={svc.running}>{svc.running ? 'Running' : 'Not running'}</span>
  </div>
  {#if svc.badgesEnabled && svc.badge > 0}<span class="badge">{svc.badge}</span>{/if}
  <button class="primary" onclick={() => window.loftHub.openService(svc.id)}>Open</button>
  <button class="gear" title="Settings" onclick={() => onGear(svc.id)}>⚙</button>
</div>

<style>
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
  .icon { width: 28px; height: 28px; border-radius: 6px; }
  .meta { display: flex; flex-direction: column; flex: 1; min-width: 0; }
  .name { font-weight: 600; }
  .status { font-size: 0.8em; opacity: 0.6; }
  .status.on { color: var(--accent); opacity: 1; }
  .badge { background: var(--accent); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 0.8em; font-weight: 700; }
  button { border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; }
  .primary { background: var(--accent); color: #fff; }
  .gear { background: transparent; font-size: 1.1em; }
</style>
