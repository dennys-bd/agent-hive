import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

// same relative path main.ts uses from dist/src/main.js
const asset = (name: string): string => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));
const ICON = asset('icon.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const IHDR_BIT_DEPTH_OFFSET = 24;
const IHDR_COLOR_TYPE_OFFSET = 25;
const IHDR_INTERLACE_OFFSET = 28;
const COLOR_TYPE_RGBA = 6;
const EXPECTED_BIT_DEPTH = 8;
const INTERLACE_NONE = 0;
const MIN_DOCK_ICON_PX = 512;

// chunk layout: 4-byte length, 4-byte type, <length> data, 4-byte CRC
const CHUNK_LENGTH_SIZE = 4;
const CHUNK_TYPE_SIZE = 4;
const CHUNK_CRC_SIZE = 4;

// scanline layout for 8-bit RGBA: 1 filter-type byte, then 4 bytes (R,G,B,A) per pixel
const SCANLINE_FILTER_TYPE_SIZE = 1;
const ALPHA_BYTE_OFFSET_IN_PIXEL = 3;
const TRANSPARENT_ALPHA = 0;
const OPAQUE_ALPHA = 255;
const BYTES_PER_PIXEL = 4;
const BYTE_MASK = 0xff;
// PNG filter types: 0 none, 1 sub, 2 up, 3 average, 4 paeth
const FILTER_PAETH = 4;

// the menu bar template image (#191): Electron picks @2x from the same folder
const TRAY_ICONS = [
  { file: 'trayTemplate.png', px: 16 },
  { file: 'trayTemplate@2x.png', px: 32 },
] as const;

// the menu bar menu's worker dots (#192): the board's status colors (src/ui/theme.css, dark), kept as drawn: not template images
const DOT_COLORS = {
  working: [0x2e, 0x9e, 0x5b], // #2e9e5b
  waiting: [0xe0, 0xb5, 0x2a], // #e0b52a
  review: [0x3b, 0x82, 0xf6], // #3b82f6
  approval: [0x0e, 0xa5, 0xe9], // #0ea5e9 (#268)
  backoff: [0xf0, 0x8a, 0x3c], // #f08a3c (#805)
} as const;
const DOTS = Object.entries(DOT_COLORS).flatMap(([status, rgb]) => [
  { file: `dot-${status}.png`, px: 16, rgb },
  { file: `dot-${status}@2x.png`, px: 32, rgb },
]);
const COLOR_TOLERANCE = 1; // per channel: the rasterizer's rounding, never a color-space shift

// the menu bar icon with the signal badge (#196): the honeycomb in black (tray-dark, for a light bar) or white (tray-light, for a dark
// bar), the badge in the SignalStrip's colors (src/ui/theme.css, dark); not template images
const INKS = { dark: [0x00, 0x00, 0x00], light: [0xff, 0xff, 0xff] } as const;
const SIGNAL_COLORS = {
  green: [0x2e, 0x9e, 0x5b], // #2e9e5b
  yellow: [0xe0, 0xb5, 0x2a], // #e0b52a
  red: [0xd9, 0x53, 0x4f], // #d9534f
} as const;
const BADGED = Object.entries(INKS).flatMap(([ink, inkRgb]) => Object.entries(SIGNAL_COLORS).flatMap(([signal, rgb]) => [
  { file: `tray-${ink}-${signal}.png`, px: 16, ink: inkRgb, rgb },
  { file: `tray-${ink}-${signal}@2x.png`, px: 32, ink: inkRgb, rgb },
]));
// points of the tray SVGs' viewBox (-264 -264 528 528): inside the filled center cell, the badge's center, and a spot of the gap where a
// wall would be without the mask; at 16 px the gap is under 1.5 px wide, so only @2x has a pixel wholly inside it
const VIEWBOX_MIN = -264;
const VIEWBOX_SIZE = 528;
const INK_POINT = { x: 0, y: 0 };
const BADGE_CENTER = { x: 160, y: 144 };
const GAP_POINT = { x: 90, y: 40 };
const GAP_CHECK_PX = 32;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function collectIdatData(png: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + CHUNK_LENGTH_SIZE, offset + CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE);
    const dataStart = offset + CHUNK_LENGTH_SIZE + CHUNK_TYPE_SIZE;
    if (type === 'IDAT') {
      chunks.push(png.subarray(dataStart, dataStart + length));
    }
    offset = dataStart + length + CHUNK_CRC_SIZE;
  }
  return Buffer.concat(chunks);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const p = left + above - upperLeft;
  const pLeft = Math.abs(p - left);
  const pAbove = Math.abs(p - above);
  const pUpperLeft = Math.abs(p - upperLeft);
  if (pLeft <= pAbove && pLeft <= pUpperLeft) return left;
  return pAbove <= pUpperLeft ? above : upperLeft;
}

// Every pixel of a non-interlaced 8-bit RGBA PNG, row by row, with each scanline's filter undone.
function rgbaPixels(png: Buffer): Rgba[] {
  const width = png.readUInt32BE(IHDR_WIDTH_OFFSET);
  const height = png.readUInt32BE(IHDR_HEIGHT_OFFSET);
  const stride = width * BYTES_PER_PIXEL;
  const raw = inflateSync(collectIdatData(png));
  const pixels: Rgba[] = [];
  let above = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (SCANLINE_FILTER_TYPE_SIZE + stride);
    const filter = raw[start];
    assert.ok(filter <= FILTER_PAETH, `row ${y} has unknown filter type ${filter}`);
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= BYTES_PER_PIXEL ? row[x - BYTES_PER_PIXEL] : 0;
      const upperLeft = x >= BYTES_PER_PIXEL ? above[x - BYTES_PER_PIXEL] : 0;
      const predictors = [0, left, above[x], (left + above[x]) >> 1, paeth(left, above[x], upperLeft)];
      row[x] = (raw[start + SCANLINE_FILTER_TYPE_SIZE + x] + predictors[filter]) & BYTE_MASK;
    }
    for (let x = 0; x < stride; x += BYTES_PER_PIXEL) {
      pixels.push({ r: row[x], g: row[x + 1], b: row[x + 2], a: row[x + ALPHA_BYTE_OFFSET_IN_PIXEL] });
    }
    above = row;
  }
  return pixels;
}

// A PNG under assets/, checked as a px x px, 8-bit, non-interlaced RGBA image; its pixels row by row.
async function rgbaPng(file: string, px: number): Promise<Rgba[]> {
  const png = await readFile(asset(file));
  assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  assert.equal(png.readUInt32BE(IHDR_WIDTH_OFFSET), px);
  assert.equal(png.readUInt32BE(IHDR_HEIGHT_OFFSET), px);
  assert.equal(png[IHDR_BIT_DEPTH_OFFSET], EXPECTED_BIT_DEPTH);
  assert.equal(png[IHDR_COLOR_TYPE_OFFSET], COLOR_TYPE_RGBA);
  assert.equal(png[IHDR_INTERLACE_OFFSET], INTERLACE_NONE);
  const pixels = rgbaPixels(png);
  assert.equal(pixels.length, px * px);
  return pixels;
}

// A pixel of an opaque drawing in `rgb`, within the rasterizer's rounding
function assertOpaque(pixel: Rgba, rgb: readonly number[], what: string): void {
  assert.equal(pixel.a, OPAQUE_ALPHA, `${what} is not opaque: ${JSON.stringify(pixel)}`);
  const [r, g, b] = rgb;
  const off = Math.max(Math.abs(pixel.r - r), Math.abs(pixel.g - g), Math.abs(pixel.b - b));
  assert.ok(off <= COLOR_TOLERANCE, `${what} ${JSON.stringify(pixel)}, expected rgb(${rgb.join(', ')})`);
}

test('assets/icon.png is a square PNG large enough for the Dock', async () => {
  const png = await readFile(ICON);
  assert.deepEqual(png.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
  const width = png.readUInt32BE(IHDR_WIDTH_OFFSET);
  const height = png.readUInt32BE(IHDR_HEIGHT_OFFSET);
  assert.equal(width, height);
  assert.ok(width >= MIN_DOCK_ICON_PX, `icon is ${width}px, expected >= ${MIN_DOCK_ICON_PX}`);
});

test('assets/icon.png has a transparent corner pixel, not opaque white', async () => {
  const png = await readFile(ICON);
  assert.equal(png[IHDR_BIT_DEPTH_OFFSET], EXPECTED_BIT_DEPTH);
  assert.equal(png[IHDR_COLOR_TYPE_OFFSET], COLOR_TYPE_RGBA);
  assert.equal(png[IHDR_INTERLACE_OFFSET], INTERLACE_NONE);

  const raw = inflateSync(collectIdatData(png));
  // first scanline's first pixel is unfiltered regardless of filter type:
  // its left, above and upper-left neighbours are all zero.
  const firstPixelStart = SCANLINE_FILTER_TYPE_SIZE;
  const alpha = raw[firstPixelStart + ALPHA_BYTE_OFFSET_IN_PIXEL];
  assert.equal(alpha, TRANSPARENT_ALPHA, `corner pixel alpha is ${alpha}, expected transparent (0)`);
});

for (const { file, px } of TRAY_ICONS) {
  test(`assets/${file} is a ${px}x${px} RGBA template image: transparent background, black ink only (#191)`, async () => {
    const pixels = await rgbaPng(file, px);
    assert.ok(pixels.some((p) => p.a === TRANSPARENT_ALPHA), 'no transparent pixel: the background must stay empty');
    assert.ok(pixels.some((p) => p.a === OPAQUE_ALPHA), 'no opaque pixel: the filled center hexagon is missing');
    // a template image is read by its alpha only: any drawn pixel (edges included) is pure black
    const tinted = pixels.filter((p) => p.a > TRANSPARENT_ALPHA && (p.r !== 0 || p.g !== 0 || p.b !== 0));
    assert.equal(tinted.length, 0, `${tinted.length} drawn pixels are not black, e.g. ${JSON.stringify(tinted[0])}`);
  });
}

for (const { file, px, rgb } of DOTS) {
  test(`assets/${file} is a ${px}x${px} RGBA dot: transparent corners, its status color at the center (#192)`, async () => {
    const pixels = await rgbaPng(file, px);
    const at = (x: number, y: number): Rgba => pixels[y * px + x];
    const corners = [at(0, 0), at(px - 1, 0), at(0, px - 1), at(px - 1, px - 1)];
    assert.ok(corners.every((p) => p.a === TRANSPARENT_ALPHA), `corners ${JSON.stringify(corners)}: the background must stay empty`);
    const center = at(px / 2, px / 2);
    assert.equal(center.a, OPAQUE_ALPHA, 'the dot is filled');
    const [r, g, b] = rgb;
    const off = Math.max(Math.abs(center.r - r), Math.abs(center.g - g), Math.abs(center.b - b));
    assert.ok(off <= COLOR_TOLERANCE, `center ${JSON.stringify(center)}, expected rgb(${rgb.join(', ')})`);
  });
}

for (const { file, px, ink, rgb } of BADGED) {
  test(`assets/${file} is a ${px}x${px} RGBA menu bar icon: transparent corners, the comb in its ink, the badge's color, a gap between them (#196)`, async () => {
    const pixels = await rgbaPng(file, px);
    const at = (x: number, y: number): Rgba => pixels[y * px + x];
    const toPixel = (unit: number): number => Math.floor(((unit - VIEWBOX_MIN) / VIEWBOX_SIZE) * px);
    const atPoint = ({ x, y }: { x: number; y: number }): Rgba => at(toPixel(x), toPixel(y));
    const corners = [at(0, 0), at(px - 1, 0), at(0, px - 1), at(px - 1, px - 1)];
    assert.ok(corners.every((p) => p.a === TRANSPARENT_ALPHA), `corners ${JSON.stringify(corners)}: the background must stay empty`);
    assertOpaque(atPoint(INK_POINT), ink, 'the honeycomb');
    assertOpaque(atPoint(BADGE_CENTER), rgb, 'the badge');
    if (px === GAP_CHECK_PX) assert.equal(atPoint(GAP_POINT).a, TRANSPARENT_ALPHA, 'the gap: the walls around the badge are cut away');
  });
}
