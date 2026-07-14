<script lang="ts">
  let { version }: { version: string } = $props();
</script>

<section class="about">
  <img class="logo" src="loft://icon/loft" alt="" />
  <h2>Loft</h2>
  <p class="ver">Version {version}</p>
  <p>Desktop integration for messaging apps on Linux.</p>
  <p><a href="https://github.com/keithvassallomt/loft" target="_blank" rel="noreferrer">github.com/keithvassallomt/loft</a></p>
  <p class="lic">GPL-3.0-or-later</p>
</section>

<style>
  .about { text-align: center; padding: 24px 0; }
  .logo { width: 72px; height: 72px; }
  .ver { opacity: 0.7; }
  .lic { opacity: 0.5; font-size: 0.85em; }
</style>
