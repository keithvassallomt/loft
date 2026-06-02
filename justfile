version := `sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml`
arch := `uname -m`
dist_dir := "target/dist"
upstream_repo := "https://github.com/keithvassallomt/loft.git"

# Build release binary and package as RPM, DEB, and AppImage
build:
    cargo build --release
    rm -rf {{ dist_dir }}
    mkdir -p {{ dist_dir }}
    @echo "==> Building RPM..."
    rm -f target/generate-rpm/*.rpm
    cargo generate-rpm
    cp target/generate-rpm/*.rpm {{ dist_dir }}/
    @echo "==> Building DEB..."
    rm -f target/debian/*.deb
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

# Generate FriendlyHub submission files (manifest, metainfo, cargo-sources.json)
update-flatpak-submission output=("$HOME/Downloads/chat.loft.Loft"):
    #!/usr/bin/env bash
    set -euo pipefail
    out="{{ output }}"
    mkdir -p "$out"

    echo "==> Generating cargo-sources.json..."
    flatpak-cargo-generator Cargo.lock -o "$out/cargo-sources.json"

    echo "==> Copying metainfo..."
    cp data/chat.loft.Loft.metainfo.xml "$out/"

    echo "==> Generating submission manifest..."
    # Determine the commit (and tag, if any) to pin.
    # FriendlyHub/Flathub run flatpak-builder-lint, which REJECTS a git source
    # that has a tag but no commit — a bare tag is mutable and not reproducible.
    # So always pin the commit, and include the tag too when HEAD is tagged.
    commit=$(git rev-parse HEAD)
    tag=$(git describe --tags --exact-match 2>/dev/null || echo "")

    if [ -z "$tag" ]; then
        echo "WARNING: HEAD is not on a release tag — pinning to commit $commit only." >&2
        echo "         Tag the release commit before submitting so the listing tracks it." >&2
    fi

    # Start from the project manifest and replace the dir source with a git source.
    src='      - type: git\n        url: {{ upstream_repo }}'
    if [ -n "$tag" ]; then
        src="$src"'\n        tag: '"$tag"
    fi
    src="$src"'\n        commit: '"$commit"
    cp chat.loft.Loft.yml "$out/chat.loft.Loft.yml"
    sed -i '/^      - type: dir$/,/^        path: \.$/c\'"$src" "$out/chat.loft.Loft.yml"

    echo "    Pinned to commit $commit${tag:+ (tag $tag)}"

    echo ""
    echo "Submission files in: $out/"
    ls -1 "$out/"

# Cut a release: bump version, build, tag, push, GitHub release, Flatpak submission files
release new_version:
    #!/usr/bin/env bash
    set -euo pipefail
    ver="{{ new_version }}"
    tag="v$ver"
    slug="keithvassallomt/loft"
    metainfo="data/chat.loft.Loft.metainfo.xml"
    today=$(date +%F)

    # ---- Preflight: nothing is changed if any check fails ----
    if ! [[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "ERROR: version must be X.Y.Z (got '$ver')." >&2; exit 1
    fi
    command -v gh >/dev/null || { echo "ERROR: gh CLI not found." >&2; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "ERROR: gh is not authenticated (run: gh auth login)." >&2; exit 1; }

    branch=$(git rev-parse --abbrev-ref HEAD)
    # Allow a dirty tree only for the files this recipe edits (so an interrupted
    # run can be re-run); abort on any unrelated uncommitted change.
    allowed='^(Cargo\.toml|Cargo\.lock|CHANGELOG\.md|data/chat\.loft\.Loft\.metainfo\.xml)$'
    unrelated=$(git status --porcelain | cut -c4- | grep -Ev "$allowed" || true)
    if [ -n "$unrelated" ]; then
        echo "ERROR: unrelated uncommitted changes — commit or stash first:" >&2
        echo "$unrelated" | sed 's/^/  /' >&2; exit 1
    fi
    if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
        echo "ERROR: tag $tag already exists locally." >&2; exit 1
    fi
    if git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
        echo "ERROR: tag $tag already exists on origin." >&2; exit 1
    fi
    current=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
    echo "==> Releasing $tag (from $current) on branch '$branch'"

    # ---- Phase 1: local prep (reversible — nothing pushed yet) ----
    if [ "$ver" = "$current" ]; then
        echo "==> Cargo.toml already at $ver (resuming a previous run)"
    else
        echo "==> Bumping Cargo.toml to $ver"
        sed -i 's/^version = "'"$current"'"/version = "'"$ver"'"/' Cargo.toml
    fi

    # Release notes are the part only you can write — wait until both files have
    # an entry for this version before continuing.
    while :; do
        missing=""
        grep -q "## \[$ver\]" CHANGELOG.md || missing="$missing CHANGELOG.md"
        grep -q "version=\"$ver\"" "$metainfo" || missing="$missing $metainfo"
        [ -z "$missing" ] && break
        echo
        echo "!! Add a $ver entry to:$missing"
        echo "     CHANGELOG.md -> ## [$ver] - $today"
        echo "     $metainfo -> <release version=\"$ver\" date=\"$today\">"
        read -rp "   Press Enter once added (Ctrl-C to abort)... " _ </dev/tty
    done
    echo "==> Release notes present in CHANGELOG.md and metainfo"

    # Compile (validates the build + refreshes Cargo.lock) and build packages.
    echo "==> Building binary + packages"
    just build
    # Standalone .flatpak bundle (heavy: full release compile in a sandbox).
    # Runs after `just build` so its dist clean doesn't wipe the bundle.
    echo "==> Building Flatpak bundle"
    just build-flatpak

    # ---- Confirmation: last stop before anything leaves your machine ----
    echo
    echo "About to publish $tag:"
    git --no-pager diff --stat
    echo "  - commit on '$branch', tag $tag, push branch + tag to origin"
    echo "  - create GitHub release $tag (notes from CHANGELOG.md, packages from target/dist/)"
    echo "  - generate FriendlyHub submission files"
    echo
    read -rp "Proceed? [y/N] " ans </dev/tty
    case "$ans" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted. Local edits kept (use 'git checkout .' to undo)."; exit 1;; esac

    # ---- Phase 2: publish (point of no return) ----
    echo "==> Committing and tagging"
    git add -A
    # Normally this commit captures the version bump + changelog/metainfo. If
    # that prep was already committed by hand, there's nothing to stage — just
    # tag HEAD instead of failing on an empty commit.
    if git diff --cached --quiet; then
        echo "    Nothing to commit (release prep already committed) — tagging HEAD"
    else
        git commit -m "Release $tag"
    fi
    git tag -a "$tag" -m "$tag"

    echo "==> Generating FriendlyHub submission files (pins $tag)"
    just update-flatpak-submission

    echo "==> Pushing branch + tag"
    git push origin "$branch"
    git push origin "$tag"

    echo "==> Creating GitHub release"
    notes=$(mktemp)
    awk -v v="$ver" '
        $0 ~ "^## \\[" v "\\]" {grab=1; next}
        grab && /^## \[/ {exit}
        grab {print}
    ' CHANGELOG.md > "$notes"
    assets=()
    shopt -s nullglob; for f in {{ dist_dir }}/*; do assets+=("$f"); done; shopt -u nullglob
    if [ ${#assets[@]} -gt 0 ]; then
        gh release create "$tag" --repo "$slug" --title "$tag" --notes-file "$notes" "${assets[@]}" \
            || { echo "WARN: gh release create failed; tag is pushed. Retry: gh release create $tag --notes-file <notes> {{ dist_dir }}/*" >&2; }
    else
        gh release create "$tag" --repo "$slug" --title "$tag" --notes-file "$notes" \
            || echo "WARN: gh release create failed; tag is pushed. Retry manually." >&2
    fi
    rm -f "$notes"

    echo
    echo "================ DONE: $tag ================"
    echo "GitHub release: https://github.com/$slug/releases/tag/$tag"
    echo "Packages:       {{ dist_dir }}/"
    echo "FriendlyHub:    $HOME/Downloads/chat.loft.Loft/  (submit the 3 files there)"

# Package the GNOME Shell extension as a zip for EGO submission
package-gnome-extension output="$HOME/Downloads":
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "{{ output }}"
    zip_path="{{ output }}/loft-shell-helper@loft.chat.zip"
    (cd gnome-shell-extension && zip -r "$zip_path" extension.js metadata.json icons/)
    echo "Extension zip: $zip_path"

    echo "==> Running EGO static analysis (shexli)..."
    venv="target/shexli-venv"
    if [ ! -x "$venv/bin/shexli" ]; then
        python3 -m venv "$venv"
    fi
    "$venv/bin/pip" install -q -U shexli
    "$venv/bin/shexli" "$zip_path"

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
    flatpak install --user flathub org.gnome.Sdk//50 org.gnome.Platform//50 org.freedesktop.Sdk.Extension.rust-stable//25.08

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
    ln -s chat.loft.Loft.metainfo.xml "$appdir/usr/share/metainfo/chat.loft.Loft.appdata.xml"
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
