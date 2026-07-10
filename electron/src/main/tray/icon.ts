import { join } from 'node:path';
import type { IconPixmap } from './sniItem';

/** Which overlay the tray icon should carry. */
export type OverlayKind = 'none' | 'unread' | 'dnd';

/** Canvas size for the composited tray pixmap (matches tray.rs overlay geometry). */
const SIZE = 48;

/**
 * Pick the overlay for the current aggregate state. DND takes visual precedence
 * over unread (match `tray.rs`: dash when DND, else red dot when unread). Pure.
 */
export function overlayFor(totalUnread: number, anyDnd: boolean): OverlayKind {
  if (anyDnd) return 'dnd';
  if (totalUnread > 0) return 'unread';
  return 'none';
}

/**
 * Load the base Loft icon and composite the unread/DND overlay bottom-right,
 * returning an ARGB32 (network byte order) pixmap for the SNI `IconPixmap`.
 * Ports `generate_red_dot_overlay` / `generate_dnd_dash_overlay` /
 * `composite_overlay` from `src/combined_tray/tray.rs`.
 *
 * `electron` is required lazily so the pure `overlayFor` stays importable under
 * vitest (which cannot resolve the `electron` module).
 */
export function compositeTrayIcon(kind: OverlayKind): { width: number; height: number; argb: Buffer } {
  const argb = loadBaseArgb(SIZE);
  if (kind === 'unread') compositeOverlay(argb, generateRedDotOverlay());
  else if (kind === 'dnd') compositeOverlay(argb, generateDndDashOverlay());
  return { width: SIZE, height: SIZE, argb };
}

/** Convenience: the pixmap frame shape the SNI object expects. */
export function trayPixmap(kind: OverlayKind): IconPixmap[] {
  const { width, height, argb } = compositeTrayIcon(kind);
  return [[width, height, argb]];
}

/** Absolute path to the shipped base icon (copied to dist/assets at build). */
function baseIconPath(): string {
  return join(__dirname, '..', '..', 'assets', 'loft.png');
}

/** Load the base PNG, resize to SIZE×SIZE, and return straight-alpha ARGB32 bytes. */
function loadBaseArgb(size: number): Buffer {
  const { nativeImage } = require('electron') as typeof import('electron');
  const argb = Buffer.alloc(size * size * 4);
  const img = nativeImage.createFromPath(baseIconPath());
  if (img.isEmpty()) return argb; // transparent base; overlay still renders
  const resized = img.resize({ width: size, height: size });
  const bgra = resized.toBitmap(); // Electron returns B,G,R,A per pixel
  if (bgra.length < size * size * 4) return argb;
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    argb[o] = bgra[o + 3]; // A
    argb[o + 1] = bgra[o + 2]; // R
    argb[o + 2] = bgra[o + 1]; // G
    argb[o + 3] = bgra[o]; // B
  }
  return argb;
}

/** Alpha-blend `overlay` onto `base` in place. Both ARGB32, SIZE×SIZE. Port of `composite_overlay`. */
function compositeOverlay(base: Buffer, overlay: Buffer): void {
  for (let i = 0; i < SIZE * SIZE; i++) {
    const o = i * 4;
    const oa = overlay[o] / 255;
    if (oa === 0) continue;
    const ba = base[o] / 255;
    const outA = oa + ba * (1 - oa);
    if (outA > 0) {
      for (let c = 1; c < 4; c++) {
        base[o + c] = Math.floor((overlay[o + c] * oa + base[o + c] * ba * (1 - oa)) / outA);
      }
    }
    base[o] = Math.floor(outA * 255);
  }
}

/** Red unread dot, bottom-right. Premultiplied ARGB32. Port of `generate_red_dot_overlay`. */
function generateRedDotOverlay(): Buffer {
  const DOT_RADIUS = 7;
  const DOT_CX = SIZE - DOT_RADIUS - 2;
  const DOT_CY = SIZE - DOT_RADIUS - 2;
  const R = 0xe0;
  const G = 0x1b;
  const B = 0x24;

  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x + 0.5 - DOT_CX;
      const dy = y + 0.5 - DOT_CY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha: number;
      if (dist <= DOT_RADIUS - 0.5) alpha = 1;
      else if (dist <= DOT_RADIUS + 0.5) alpha = DOT_RADIUS + 0.5 - dist;
      else continue;
      const idx = (y * SIZE + x) * 4;
      data[idx] = Math.floor(alpha * 255);
      data[idx + 1] = Math.floor(alpha * R);
      data[idx + 2] = Math.floor(alpha * G);
      data[idx + 3] = Math.floor(alpha * B);
    }
  }
  return data;
}

/** Grey DND dash (rounded pill), bottom-right. Premultiplied ARGB32. Port of `generate_dnd_dash_overlay`. */
function generateDndDashOverlay(): Buffer {
  const DASH_W = 13;
  const DASH_H = 4;
  const DASH_X = SIZE - DASH_W - 2;
  const DASH_Y = SIZE - DASH_H - 4;
  const R = 0x88;
  const G = 0x88;
  const B = 0x88;

  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      const cornerR = DASH_H / 2;
      const cx = Math.min(Math.max(fx, DASH_X + cornerR), DASH_X + DASH_W - cornerR);
      const cy = DASH_Y + cornerR;
      const dx = fx - cx;
      const dy = fy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha: number;
      if (dist <= cornerR - 0.5) alpha = 1;
      else if (dist <= cornerR + 0.5) alpha = cornerR + 0.5 - dist;
      else continue;
      const idx = (y * SIZE + x) * 4;
      data[idx] = Math.floor(alpha * 255);
      data[idx + 1] = Math.floor(alpha * R);
      data[idx + 2] = Math.floor(alpha * G);
      data[idx + 3] = Math.floor(alpha * B);
    }
  }
  return data;
}
