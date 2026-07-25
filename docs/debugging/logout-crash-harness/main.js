const { app } = require('electron');
const MODE = process.env.HARNESS_MODE || 'none';
const log = (m) => { process.stdout.write(`[harness ${Date.now()}] ${m}\n`); };

if (MODE === 'fastexit') {
  let done = false;
  const h = () => { if (done) return; done = true; log('handler ran -> app.exit(0)'); app.exit(0); };
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, h);
}

if (MODE === 'sigdfl') {
  // Restore the KERNEL default disposition for SIGTERM, overriding whatever handler
  // Chromium installed. Node installs its own handler when a listener is added and
  // resets to SIG_DFL when the last one is removed — so add-then-remove should leave
  // the process dying instantly on SIGTERM, with no userspace code running at all.
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const noop = () => {};
    process.on(s, noop);
    process.removeListener(s, noop);
  }
  log('restored SIG_DFL for SIGTERM/SIGINT/SIGHUP');
}

app.whenReady().then(() => {
  if (MODE !== 'nodbus') {
    require('electron').powerMonitor.getSystemIdleState(60);
    void require('electron').nativeTheme.shouldUseDarkColors;
  }
  log(`ready pid=${process.pid} mode=${MODE}`);
});
