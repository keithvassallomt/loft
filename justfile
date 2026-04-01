version := `sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml`
arch := `uname -m`
dist_dir := "target/dist"
upstream_repo := "https://github.com/keithvassallomt/loft.git"

# Build release binary and package as RPM, DEB, and AppImage
build:
    cargo build --release
    mkdir -p {{ dist_dir }}
    @echo "==> Building RPM..."
    cargo generate-rpm
    cp target/generate-rpm/*.rpm {{ dist_dir }}/
    @echo "==> Building DEB..."
    cargo deb --no-build
    cp target/debian/*.deb {{ dist_dir }}/
    @echo "==> Building AppImage..."
    @just _appimage
    @echo ""
    @echo "Packages in {{ dist_dir }}:"
    @ls -1 {{ dist_dir }}/

# Build a local .flatpak bundle for testing
build-flatpak output=dist_dir:
    @echo "==> Generating cargo-sources.json..."
    flatpak-cargo-generator Cargo.lock -o cargo-sources.json
    @echo "==> Building Flatpak..."
    flatpak-builder --force-clean --repo=flatpak-repo flatpak-build chat.loft.Loft.yml
    mkdir -p {{ output }}
    flatpak build-bundle flatpak-repo {{ output }}/Loft-{{ version }}.flatpak chat.loft.Loft
    rm -rf flatpak-build flatpak-repo cargo-sources.json
    @echo ""
    @echo "Bundle: {{ output }}/Loft-{{ version }}.flatpak"

# Generate Flathub submission files (manifest, metainfo, cargo-sources.json)
update-flatpak-submission output=("$HOME/Downloads/chat.loft.Loft"):
    #!/usr/bin/env bash
    set -euo pipefail
    out="{{ output }}"
    mkdir -p "$out"

    echo "==> Generating cargo-sources.json..."
    flatpak-cargo-generator Cargo.lock -o "$out/cargo-sources.json"

    echo "==> Copying metainfo..."
    cp data/chat.loft.Loft.metainfo.xml "$out/"

    echo "==> Generating Flathub manifest..."
    # Determine the current commit for pinning
    commit=$(git rev-parse HEAD)
    tag=$(git describe --tags --exact-match 2>/dev/null || echo "")

    cat > "$out/chat.loft.Loft.yml" << MANIFEST
    app-id: chat.loft.Loft
    runtime: org.gnome.Platform
    runtime-version: '49'
    sdk: org.gnome.Sdk
    sdk-extensions:
      - org.freedesktop.Sdk.Extension.rust-stable
    command: loft

    finish-args:
      - --share=ipc
      - --socket=fallback-x11
      - --socket=wayland
      - --device=dri
      - --share=network
      - --socket=pulseaudio
      - --talk-name=org.kde.StatusNotifierWatcher
      - --talk-name=org.freedesktop.Notifications
      - --own-name=chat.loft.*
      - --talk-name=org.freedesktop.Flatpak
      - --filesystem=home

    build-options:
      append-path: /usr/lib/sdk/rust-stable/bin
      env:
        CARGO_HOME: /run/build/loft/cargo
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: sparse

    modules:
      - name: loft
        buildsystem: simple
        build-commands:
          - cargo --offline fetch --manifest-path Cargo.toml --verbose
          - cargo --offline build --release --verbose
          - install -Dm755 target/release/loft /app/bin/loft
          - install -Dm644 data/chat.loft.Loft.desktop /app/share/applications/chat.loft.Loft.desktop
          - install -Dm644 data/chat.loft.Loft.metainfo.xml /app/share/metainfo/chat.loft.Loft.metainfo.xml
          - install -Dm644 assets/icons/loft.svg /app/share/icons/hicolor/scalable/apps/chat.loft.Loft.svg
        sources:
          - type: git
            url: {{ upstream_repo }}
            $(if [ -n "$tag" ]; then echo "tag: $tag"; else echo "commit: $commit"; fi)
          - cargo-sources.json
    MANIFEST

    # Remove leading whitespace from heredoc
    sed -i 's/^    //' "$out/chat.loft.Loft.yml"

    echo ""
    echo "Submission files in: $out/"
    ls -1 "$out/"

# Install build tools (cargo-generate-rpm, cargo-deb, appimagetool)
setup:
    cargo install cargo-generate-rpm cargo-deb
    @echo "==> Downloading appimagetool..."
    @mkdir -p ~/.local/bin
    curl -fSL -o ~/.local/bin/appimagetool \
        https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-{{ arch }}.AppImage
    chmod +x ~/.local/bin/appimagetool
    @echo "Done. Make sure ~/.local/bin is on your PATH."

# Install Flatpak SDK (needed for build-flatpak)
setup-flatpak:
    flatpak install --user flathub org.gnome.Sdk//49 org.gnome.Platform//49 org.freedesktop.Sdk.Extension.rust-stable//25.08

# Internal: build AppImage from the release binary
_appimage:
    #!/usr/bin/env bash
    set -euo pipefail
    appdir=$(mktemp -d)
    trap "rm -rf $appdir" EXIT

    mkdir -p "$appdir/usr/bin"
    mkdir -p "$appdir/usr/share/applications"
    mkdir -p "$appdir/usr/share/icons/hicolor/scalable/apps"
    mkdir -p "$appdir/usr/share/metainfo"

    cp target/release/loft "$appdir/usr/bin/"
    cp data/chat.loft.Loft.desktop "$appdir/usr/share/applications/"
    cp data/chat.loft.Loft.desktop "$appdir/"
    cp data/chat.loft.Loft.metainfo.xml "$appdir/usr/share/metainfo/"
    cp assets/icons/loft.svg "$appdir/usr/share/icons/hicolor/scalable/apps/chat.loft.Loft.svg"
    cp assets/icons/loft.svg "$appdir/chat.loft.Loft.svg"

    cat > "$appdir/AppRun" << 'APPRUN'
    #!/bin/bash
    HERE=$(dirname "$(readlink -f "$0")")
    exec "$HERE/usr/bin/loft" "$@"
    APPRUN
    chmod +x "$appdir/AppRun"
    # Remove leading whitespace from heredoc
    sed -i 's/^    //' "$appdir/AppRun"

    ARCH={{ arch }} appimagetool "$appdir" {{ dist_dir }}/Loft-{{ version }}-{{ arch }}.AppImage
