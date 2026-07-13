<script lang="ts">
  import type { HubService } from '../../../shared/hubTypes';
  let { svc }: { svc: HubService } = $props();

  function add() {
    if (svc.selfHosted) {
      const url = window.prompt(`Server URL for ${svc.displayName}`, '');
      if (url === null) return;
      window.loftHub.addService(svc.id, url.trim() || undefined);
    } else {
      window.loftHub.addService(svc.id);
    }
  }
</script>

<div class="tile">
  <img class="icon" src={`loft://icon/${svc.id}`} alt="" onerror={(e) => ((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')} />
  <span class="name">{svc.displayName}</span>
  <button class="pill" onclick={add}>Add</button>
</div>

<style>
  .tile { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; background: var(--card); border-radius: 12px; }
  .icon { width: 44px; height: 44px; border-radius: 10px; }
  .name { font-weight: 600; }
  .pill { border: 0; border-radius: 999px; padding: 5px 16px; background: var(--accent); color: #fff; cursor: pointer; font: inherit; }
</style>
