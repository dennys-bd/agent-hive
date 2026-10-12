import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METER_HEIGHT, METER_WIDTH, meterBitmap, usageItems, usageLine, windowName } from '../src/tray-usage.js';
import type { RateLimits } from '../src/types.js';
import { setLanguage } from '../src/ui/i18n.js';
import { clock, type MeterBand } from '../src/ui/lib/usage.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const AT = '2026-09-24T11:52:00.000Z';
const READING: RateLimits = {
  at: AT,
  windows: {
    five_hour: { usedPercent: 81.6, resetsAt: '2026-09-24T14:40:00.000Z' }, // 2h40m after NOW, yellow
    seven_day: { usedPercent: 95.2, resetsAt: '2026-09-28T15:00:00.000Z' }, // 4d3h after NOW, red
  },
};

// The bitmap as main.ts hands it to createFromBitmap: B, G, R, A per pixel, premultiplied by alpha
const BYTES_PER_PIXEL = 4;
const OPAQUE = 255;
const TRACK_ALPHA = 89; // 35% of 255
const COLOR_TOLERANCE = 1;
const BANDS: Record<MeterBand, readonly number[]> = { neutral: [0x8e, 0x8e, 0x93], yellow: [0xe0, 0xb5, 0x2a], red: [0xd9, 0x53, 0x4f] };

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}
const pixels = (bitmap: Buffer): Pixel[] => Array.from({ length: bitmap.length / BYTES_PER_PIXEL }, (_, n) => {
  const i = n * BYTES_PER_PIXEL;
  return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2], a: bitmap[i + 3] };
});
const pixelAt = (bitmap: Buffer, width: number, x: number, y: number): Pixel => pixels(bitmap)[y * width + x];
// an opaque pixel in `rgb`, within rounding
const isColor = (p: Pixel, [r, g, b]: readonly number[]): boolean =>
  p.a === OPAQUE && Math.max(Math.abs(p.r - r), Math.abs(p.g - g), Math.abs(p.b - b)) <= COLOR_TOLERANCE;

test('windowName: the board\'s windowLabel with its first letter upper-cased: Session, Week, Week <model>, the key with spaces for any other (#197, #242)', () => {
  assert.equal(windowName('five_hour'), 'Session');
  assert.equal(windowName('seven_day'), 'Week');
  assert.equal(windowName('seven_day_opus'), 'Week opus');
  assert.equal(windowName('thirty_day'), '30 days');
  assert.equal(windowName('some_new_window'), 'Some new window', 'a menu line starts upper-case');
});

test('usageLine: the label, the rounded percent and the time until the reset (#197)', () => {
  assert.equal(usageLine('five_hour', READING.windows.five_hour, NOW), 'Session 82% · resets in 2h40m');
  assert.equal(usageLine('seven_day_opus', { usedPercent: 12.4, resetsAt: '2026-09-28T15:00:00.000Z' }, NOW), 'Week opus 12% · resets in 4d3h');
  assert.equal(usageLine('seven_day', { usedPercent: 100, resetsAt: '2026-09-24T11:00:00.000Z' }, NOW), 'Week 100% · resets in 0m', 'a reset already past');
});

test('meterBitmap: 22x8 pixels at 1x and 44x16 at 2x; transparent corners around a rounded track 4 points high that spans the width (#197)', () => {
  for (const scale of [1, 2] as const) {
    const width = METER_WIDTH * scale;
    const height = METER_HEIGHT * scale;
    const bitmap = meterBitmap(100, 'red', scale);
    assert.equal(bitmap.length, width * height * BYTES_PER_PIXEL);
    const at = (x: number, y: number): Pixel => pixelAt(bitmap, width, x, y);
    const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)];
    assert.ok(corners.every((p) => p.a === 0), `corners ${JSON.stringify(corners)}: the background stays empty`);
    const mid = height / 2;
    assert.ok(at(0, mid).a > 0 && at(width - 1, mid).a > 0, 'the track reaches both ends');
    assert.equal(at(0, mid - 2 * scale).a, 0, 'the track\'s corner is rounded off');
    const column = Array.from({ length: height }, (_, y) => at(width / 2, y));
    assert.equal(column.filter((p) => p.a > 0).length, 4 * scale, 'the track is 4 points high');
  }
});

test('meterBitmap: the band color fills from the left over the percent, the rest is the grey track at 35% alpha (#197)', () => {
  for (const scale of [1, 2] as const) {
    const width = METER_WIDTH * scale;
    const mid = (METER_HEIGHT * scale) / 2;
    const drawn = (bitmap: Buffer): Pixel[] => pixels(bitmap).filter((p) => p.a > 0);
    const empty = drawn(meterBitmap(0, 'red', scale));
    assert.ok(empty.length > 0 && empty.every((p) => p.a === TRACK_ALPHA), '0%: the track only, no pixel in the band color');
    assert.deepEqual(pixelAt(meterBitmap(0, 'red', scale), width, width / 2, mid), { r: 50, g: 50, b: 51, a: TRACK_ALPHA }, '#8e8e93 premultiplied by 89');
    assert.ok(drawn(meterBitmap(100, 'red', scale)).every((p) => isColor(p, BANDS.red)), '100%: every track pixel in the band color');
    const half = meterBitmap(50, 'red', scale);
    const row = Array.from({ length: width }, (_, x) => pixelAt(half, width, x, mid));
    const fillEnd = row.findIndex((p) => p.a !== OPAQUE);
    assert.ok(Math.abs(fillEnd - width / 2) <= 1, `50%: the fill stops at column ${fillEnd} of ${width}`);
    assert.ok(row.slice(fillEnd).every((p) => p.a === TRACK_ALPHA), 'past the fill, the track');
  }
  assert.deepEqual(meterBitmap(150, 'red', 1), meterBitmap(100, 'red', 1), 'over 100% is full');
  assert.deepEqual(meterBitmap(-5, 'red', 1), meterBitmap(0, 'red', 1), 'under 0% is empty');
});

test('meterBitmap: the fill is the band\'s color, neutral grey, yellow or red as the header draws them (#197)', () => {
  for (const band of ['neutral', 'yellow', 'red'] as const) {
    const p = pixelAt(meterBitmap(100, band, 1), METER_WIDTH, METER_WIDTH / 2, METER_HEIGHT / 2);
    assert.ok(isColor(p, BANDS[band]), `${band}: ${JSON.stringify(p)}`);
  }
});

test('usageItems: nothing before a reading, or with a reading that has no windows (#197)', () => {
  const noIcon = (): undefined => assert.fail('no line, no icon');
  assert.deepEqual(usageItems(undefined, NOW, 'en-US', noIcon, () => {}), []);
  assert.deepEqual(usageItems({ claude: { at: AT, windows: {} } }, NOW, 'en-US', noIcon, () => {}), []);
  const broken = { at: AT, windows: { five_hour: null } } as unknown as RateLimits; // a malformed frame: the menu still opens
  assert.deepEqual(usageItems({ claude: broken }, NOW, 'en-US', noIcon, () => {}), []);
});

test('usageItems: a line per window in the reading\'s order, the bar from the rounded percent and its band, the reading time on hover, a click that opens the board, then a separator (#197)', () => {
  const icons: [number, MeterBand][] = [];
  let opened = 0;
  const items = usageItems({ claude: READING }, NOW, 'en-US', (percent, band) => void icons.push([percent, band]), () => {
    opened += 1;
  });
  const toolTip = `Read at ${clock(AT, 'en-US')}`;
  assert.match(toolTip, /^Read at \d{2}:\d{2}/, 'the local time of the reading');
  assert.deepEqual(items.map(({ click: _click, ...item }) => item), [
    { label: 'Claude · Session 82% · resets in 2h40m', icon: undefined, toolTip },
    { label: 'Claude · Week 95% · resets in 4d3h', icon: undefined, toolTip },
    { type: 'separator' },
  ]);
  assert.deepEqual(icons, [[82, 'yellow'], [95, 'red']]);
  (items[1].click as () => void)();
  assert.equal(opened, 1);
});

test('usageItems in pt: the board\'s window names and texts, the name upper-cased first and the text after `·` lower-case, the reading time in the locale given (#242)', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('pt');
  assert.equal(usageLine('five_hour', READING.windows.five_hour, NOW), 'Sessão 82% · reseta em 2h40m');
  assert.equal(usageLine('seven_day_opus', { usedPercent: 12.4, resetsAt: '2026-09-28T15:00:00.000Z' }, NOW), 'Semana opus 12% · reseta em 4d3h');
  const [line] = usageItems({ claude: READING }, NOW, 'pt-BR', () => undefined, () => {});
  assert.equal(line.toolTip, `Lido às ${clock(AT, 'pt-BR')}`);
});

test('usageItems lists Claude\'s lines, then Codex\'s, each prefixed by its label and read at its own time; one separator after all (#929)', () => {
  const codex: RateLimits = { at: '2026-09-24T11:00:00.000Z', windows: { thirty_day: { usedPercent: 40, resetsAt: '2026-10-04T12:00:00.000Z' } } };
  const items = usageItems({ codex, claude: READING }, NOW, 'en-US', () => undefined, () => {});
  assert.deepEqual(items.map((item) => item.label ?? item.type), ['Claude · Session 82% · resets in 2h40m', 'Claude · Week 95% · resets in 4d3h', 'Codex · 30 days 40% · resets in 10d', 'separator']);
  assert.equal(items[2].toolTip, `Read at ${clock(codex.at, 'en-US')}`);
});
