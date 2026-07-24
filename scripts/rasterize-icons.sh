#!/usr/bin/env bash
# Rasterise the icon variants to the PNGs the runtime actually needs.
#
# .desktop Icon=, the SNI tray pixmap and org.freedesktop.Notifications all want a real
# PNG on disk, and Electron's nativeImage cannot load SVG — so this runs at build time
# and its output is committed. Contributors only need ImageMagick when they CHANGE an
# icon, never to build Loft.
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/assets/icons/variants"
command -v magick >/dev/null || { echo "magick (ImageMagick) not found" >&2; exit 1; }

for svg in "$dir"/*.svg; do
  png="${svg%.svg}.png"
  # -density before the input: ImageMagick rasterises the SVG at that DPI and only then
  # resizes, so edges stay clean instead of being upscaled from the default 96dpi.
  # -depth 8 to match the bundled brand PNGs — a third the size of the 16-bit default,
  # visually identical for these flat icons.
  magick -background none -density 384 "$svg" -resize 512x512 -depth 8 "$png"
  echo "  $(basename "$png")"
done
echo "Rasterised $(ls -1 "$dir"/*.png | wc -l) icon variants"
