import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assemble, OUTPUT_MAX, PART_BYTES_MAX, PART_REASONS, SLOTS_MAX, type PartReason, partNotice, type ReadPart, readPartFrom } from '../src/design-parts.js';
import { tempDir } from './temp-dir.js';

// An in-memory design folder: a path it does not hold is not found, and every path asked for is recorded
function memory(files: Record<string, string>): { read: ReadPart; reads: string[] } {
  const held = new Map(Object.entries(files));
  const reads: string[] = [];
  const read: ReadPart = async (path) => {
    reads.push(path);
    const text = held.get(path);
    return text === undefined ? { refused: PART_REASONS.missing } : { text };
  };
  return { read, reads };
}

// A notice at a part's top level carries that part's mark, as any of its top-level elements
const marked = (notice: string, file: string): string => notice.replace('<div', `<div data-hv-source="${file}"`);

test('an include is replaced by its part, each top-level element marked with its path from the folder, a nested part with its own; any case, either quote, self-closing (#421)', async () => {
  const { read } = memory({
    'parts/shell.html': '<div class="shell"><hv-include src="header.html"></hv-include><hv-include src="sidebar.html"/></div>\n<footer>f</footer>',
    'parts/header.html': '<header>Hive</header>',
    'parts/sidebar.html': '<nav class="sidebar"><a>Issues</a></nav>',
  });
  const { html, parts } = await assemble('issue.hv.html', '<body><HV-INCLUDE SRC=\'parts/shell.html\'></HV-INCLUDE></body>', read);
  assert.equal(html, [
    '<body><div data-hv-source="parts/shell.html" class="shell"><header data-hv-source="parts/header.html">Hive</header>',
    '<nav data-hv-source="parts/sidebar.html" class="sidebar"><a>Issues</a></nav></div>\n<footer data-hv-source="parts/shell.html">f</footer></body>',
  ].join(''));
  assert.deepEqual(parts, ['parts/header.html', 'parts/shell.html', 'parts/sidebar.html']);
});

test('includes nest four levels deep from the screen; a fifth gets the depth notice in place (#421)', async () => {
  const files = {
    'p1.html': '<i>1</i><hv-include src="p2.html"></hv-include>', 'p2.html': '<i>2</i><hv-include src="p3.html"></hv-include>',
    'p3.html': '<i>3</i><hv-include src="p4.html"></hv-include>', 'p4.html': '<i>4</i>',
  };
  const levels = '<i data-hv-source="p1.html">1</i><i data-hv-source="p2.html">2</i><i data-hv-source="p3.html">3</i><i data-hv-source="p4.html">4</i>';
  const four = await assemble('s.hv.html', '<hv-include src="p1.html"></hv-include>', memory(files).read);
  assert.equal(four.html, levels);
  const deeper = { ...files, 'p4.html': '<i>4</i><hv-include src="p5.html"></hv-include>', 'p5.html': '<i>5</i>' };
  const five = await assemble('s.hv.html', '<hv-include src="p1.html"></hv-include>', memory(deeper).read);
  assert.equal(five.html, `${levels}${marked(partNotice(PART_REASONS.depth, 'p5.html'), 'p4.html')}`);
});

test('a cycle stops at the include that closes it, with its notice; both parts are listed (#421)', async () => {
  const { read } = memory({ 'a.html': '<p>a</p><hv-include src="b.html"></hv-include>', 'b.html': '<p>b</p><hv-include src="a.html"></hv-include>' });
  const { html, parts } = await assemble('s.hv.html', '<hv-include src="a.html"></hv-include>', read);
  assert.equal(html, `<p data-hv-source="a.html">a</p><p data-hv-source="b.html">b</p>${marked(partNotice(PART_REASONS.cycle, 'a.html'), 'b.html')}`);
  assert.deepEqual(parts, ['a.html', 'b.html']);
});

test('a missing part renders as its notice and the rest of the screen still renders; it is listed, so the pane reloads once it appears (#421)', async () => {
  const { html, parts } = await assemble('s.hv.html', '<p>before</p><hv-include src="parts/nope.html"></hv-include><p>after</p>', memory({}).read);
  assert.equal(html, `<p>before</p>${partNotice(PART_REASONS.missing, 'parts/nope.html')}<p>after</p>`);
  assert.deepEqual(parts, ['parts/nope.html']);
});

test('a path that is not relative, has a .. or a dot segment, names a screen or a file that is not .html, or no src at all gets its notice and nothing is read (#421)', async () => {
  const { read, reads } = memory({ 'x.html': '<p>x</p>' });
  const cases: [string, PartReason][] = [
    ['/x.html', PART_REASONS.notRelative], ['https://x.test/x.html', PART_REASONS.notRelative], ['parts\\x.html', PART_REASONS.notRelative],
    ['../x.html', PART_REASONS.parent], ['parts/../x.html', PART_REASONS.parent], ['.hidden/x.html', PART_REASONS.dot], ['parts/.x.html', PART_REASONS.dot],
    ['other.hv.html', PART_REASONS.screen], ['style.css', PART_REASONS.notHtml],
  ];
  const text = [...cases.map(([src]) => `<hv-include src="${src}"></hv-include>`), '<hv-include></hv-include>'].join('\n');
  const { html, parts } = await assemble('s.hv.html', text, read);
  assert.equal(html, [...cases.map(([src, reason]) => partNotice(reason, src)), partNotice(PART_REASONS.noSrc, '')].join('\n'));
  assert.deepEqual([reads, parts], [[], []]);
});

test('readPartFrom reads a regular file of the folder and refuses a symbolic link, even to a file inside, a link on the way, a folder and a missing file (#421)', async (t) => {
  const root = await realpath(await tempDir(t, 'parts-'));
  const folder = join(root, 'design');
  await mkdir(join(folder, 'parts'), { recursive: true });
  await writeFile(join(folder, 'parts', 'nav.html'), '<nav>n</nav>');
  await writeFile(join(root, 'secret.html'), '<p>outside</p>');
  await symlink(join(root, 'secret.html'), join(folder, 'parts', 'out.html'));
  await symlink(join(folder, 'parts', 'nav.html'), join(folder, 'parts', 'alias.html'));
  await symlink(join(folder, 'parts'), join(folder, 'linked'));
  const read = readPartFrom(folder);
  assert.deepEqual(await read('parts/nav.html'), { text: '<nav>n</nav>' });
  for (const path of ['parts/out.html', 'parts/alias.html', 'linked/nav.html']) assert.deepEqual(await read(path), { refused: PART_REASONS.symlink }, path);
  assert.deepEqual([await read('parts/none.html'), await read('parts')], [{ refused: PART_REASONS.missing }, { refused: PART_REASONS.missing }]);
  const { html } = await assemble('s.hv.html', '<hv-include src="parts/out.html"></hv-include>', read);
  assert.equal(html, partNotice(PART_REASONS.symlink, 'parts/out.html'));
});

test('slots: a fill replaces its slot, marked with the filling file, or its holder marked when it is text alone; an unfilled slot keeps its default; an unknown fill and anything else inside the include are ignored (#421)', async () => {
  const { read } = memory({
    'parts/detail.html': '<aside class="detail">\n  <h2><hv-slot name="title">Title</hv-slot></h2>\n  <hv-slot name="body"></hv-slot>\n  <small><hv-slot name="foot">Default foot</hv-slot></small>\n</aside>',
  });
  const screen = [
    '<hv-include src="parts/detail.html">', '  <template data-hv-slot="title">Fix login</template>', '  <template data-hv-slot="body"><p>Body</p></template>',
    '  <template data-hv-slot="nope"><b>x</b></template>', '  <p>ignored</p>', '</hv-include>',
  ].join('\n');
  const { html } = await assemble('issue.hv.html', screen, read);
  assert.equal(html, [
    '<aside data-hv-source="parts/detail.html" class="detail">', '  <h2 data-hv-fill="title">Fix login</h2>', '  <p data-hv-source="issue.hv.html">Body</p>',
    '  <small>Default foot</small>', '</aside>',
  ].join('\n'));
  assert.doesNotMatch(html, /hv-slot/);
});

test('a fill may include a part, resolved from the filling file, and a part may pass its own slot down into an include\'s fill; each element keeps its nearest origin (#421)', async () => {
  const { read } = memory({
    'parts/card.html': '<div class="card"><hv-slot name="body"></hv-slot></div>',
    'parts/panel.html': '<section><hv-include src="card.html"><template data-hv-slot="body"><hv-slot name="content">none</hv-slot></template></hv-include></section>',
    'parts/badge.html': '<span class="badge">3</span>',
  });
  const screen = '<hv-include src="parts/panel.html"><template data-hv-slot="content"><hv-include src="parts/badge.html"></hv-include></template></hv-include>';
  const { html, parts } = await assemble('issue.hv.html', screen, read);
  assert.equal(html, '<section data-hv-source="parts/panel.html"><div data-hv-source="parts/card.html" class="card"><span data-hv-source="parts/badge.html" class="badge">3</span></div></section>');
  assert.deepEqual(parts, ['parts/badge.html', 'parts/card.html', 'parts/panel.html']);
});

test('an hv-tweaks block in a part is dropped with its notice; the screen keeps its own (#421)', async () => {
  const { read } = memory({ 'parts/nav.html': '<script type="application/json" id="hv-tweaks">{"x":{"type":"boolean","default":true}}</script><nav>n</nav>' });
  const block = '<script type="application/json" id="hv-tweaks">{}</script>';
  const { html } = await assemble('s.hv.html', `<head>${block}</head><body><hv-include src="parts/nav.html"></hv-include></body>`, read);
  assert.equal(html, `<head>${block}</head><body>${marked(partNotice(PART_REASONS.tweaks, 'parts/nav.html'), 'parts/nav.html')}<nav data-hv-source="parts/nav.html">n</nav></body>`);
});

test('a marker inside a script, a style or a comment is left alone and nothing is read; a screen with no include comes back unchanged (#421)', async () => {
  const text = '<script>const x = \'<hv-include src="a.html"></hv-include>\';</script><style>/* <hv-include src="a.html"> */</style><!-- <hv-include src="a.html"></hv-include> --><p>ok</p>';
  const { read, reads } = memory({ 'a.html': '<b>a</b>' });
  assert.deepEqual(await assemble('s.hv.html', text, read), { html: text, parts: [] });
  assert.deepEqual(reads, []);
});

test('a wide fan-out reads each part once and expands at most 256 includes; the rest get the notice, so the work stays bounded (#421)', async () => {
  const fan = (target: string): string => Array.from({ length: 20 }, () => `<hv-include src="${target}"></hv-include>`).join('');
  const { read, reads } = memory({ 'a.html': fan('b.html'), 'b.html': fan('c.html'), 'c.html': fan('d.html'), 'd.html': '<i>d</i>' });
  const { html } = await assemble('s.hv.html', fan('a.html'), read);
  assert.equal(reads.length, new Set(reads).size);
  assert.equal(html.split(PART_REASONS.tooMany).length - 1 > 0, true);
  assert.equal(html.split('<i data-hv-source="d.html">d</i>').length - 1 <= 256, true);
});

test('a part over the size cap gets the too-large notice (#421)', async (t) => {
  const folder = await realpath(await tempDir(t, 'parts-'));
  await writeFile(join(folder, 'big.html'), `<p>${'x'.repeat(PART_BYTES_MAX)}</p>`);
  const { html } = await assemble('s.hv.html', '<hv-include src="big.html"></hv-include>', readPartFrom(folder));
  assert.equal(html, partNotice(PART_REASONS.tooLarge, 'big.html'));
});

test('a slot already marked with data-hv-fill on its holder is not marked twice (#421)', async () => {
  const { read } = memory({ 'p.html': '<h2 data-hv-fill="mine"><hv-slot name="t">T</hv-slot></h2>' });
  const { html } = await assemble('s.hv.html', '<hv-include src="p.html"><template data-hv-slot="t">Hi</template></hv-include>', read);
  assert.equal(html, '<h2 data-hv-source="p.html" data-hv-fill="mine">Hi</h2>');
});

test('slots past SLOTS_MAX in a file become a notice and are not filled (#421)', async () => {
  const slots = Array.from({ length: SLOTS_MAX + 5 }, () => '<hv-slot name="a"></hv-slot>').join('');
  const { read } = memory({ 'p.html': `<div>${slots}</div>` });
  const { html } = await assemble('s.hv.html', '<hv-include src="p.html"><template data-hv-slot="a">FILL</template></hv-include>', read);
  assert.equal(html.split('FILL').length - 1, SLOTS_MAX);
  assert.equal(html.split(PART_REASONS.tooManySlots).length - 1, 5);
  assert.doesNotMatch(html, /hv-slot/);
});

test('slot fills multiplied across levels stop at OUTPUT_MAX before the huge string is built (#421)', async () => {
  const fill = 'x'.repeat(200 * 1024);
  const slots = Array.from({ length: SLOTS_MAX }, () => '<hv-slot name="a"></hv-slot>').join('');
  const { read } = memory({
    'l1.html': `<div>${slots}</div>`,
    'l2.html': `<div><hv-include src="l1.html"><template data-hv-slot="a"><hv-slot name="a"></hv-slot></template></hv-include></div>`,
  });
  const screen = `<hv-include src="l2.html"><template data-hv-slot="a">${fill}</template></hv-include>`;
  const { html } = await assemble('s.hv.html', screen, read);
  assert.equal(html.length < OUTPUT_MAX * 1.5, true);
  assert.equal(html.includes(PART_REASONS.tooLarge), true);
});

test('many parts together past OUTPUT_MAX get the too-large notice (#421)', async () => {
  const part = `<p>${'y'.repeat(PART_BYTES_MAX / 2)}</p>`;
  const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}.html`, part]));
  const { read } = memory(files);
  const screen = Object.keys(files).map((f) => `<hv-include src="${f}"></hv-include>`).join('');
  const { html } = await assemble('s.hv.html', screen, read);
  assert.equal(html.length < OUTPUT_MAX * 1.5, true);
  assert.equal(html.includes(PART_REASONS.tooLarge), true);
});

test('a file of thousands of unclosed hv-slot markers is scanned in linear time (#421)', async () => {
  const { read } = memory({ 'p.html': '<hv-slot name="a">'.repeat(40000) });
  const started = Date.now();
  await assemble('s.hv.html', '<hv-include src="p.html"></hv-include>', read);
  assert.equal(Date.now() - started < 2000, true);
});

test('readPartFrom does not hang on a FIFO named .html and refuses it (#421)', async (t) => {
  const folder = await realpath(await tempDir(t, 'parts-'));
  await promisify(execFile)('mkfifo', [join(folder, 'x.html')]);
  assert.deepEqual(await readPartFrom(folder)('x.html'), { refused: PART_REASONS.missing });
});
