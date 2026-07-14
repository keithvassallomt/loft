#!/bin/sh
# Launch the packaged Electron app under zypak.
#
# Chromium's sandbox needs a helper (zypak) inside the Flatpak sandbox because
# the usual SUID/userns sandbox paths aren't available. The Electron base app
# (org.electronjs.Electron2.BaseApp) ships zypak-wrapper on PATH; it sets up the
# seccomp/namespace shims and then execs the real Electron binary.
#
# /app/main is the app root (contains package.json whose "main" points at
# dist/main/index.js). The Electron binary lives in the copied node_modules.
#
# Electron's main (browser) process must NOT inherit ELECTRON_RUN_AS_NODE: with
# it set, `require('electron')` returns the binary path string instead of the
# API object, so app/BrowserWindow/... are undefined and startup crashes. The
# variable can leak in from the host (flatpak forwards much of the environment)
# or a parent shell. zypak re-sets it itself for the sandbox-helper children it
# spawns, so clearing it here only affects the browser process (this mirrors the
# app's own `env -u ELECTRON_RUN_AS_NODE electron .` dev scripts).
unset ELECTRON_RUN_AS_NODE

exec zypak-wrapper /app/main/node_modules/electron/dist/electron /app/main "$@"
