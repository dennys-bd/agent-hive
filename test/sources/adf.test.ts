import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToMarkdown, type AdfDoc, type AdfMark, type AdfNode } from '../../src/sources/adf.js';
import { markdownToAdf } from '../../src/sources/adf-parse.js';

const doc = (...content: AdfNode[]): AdfDoc => ({ version: 1, type: 'doc', content });
const text = (value: string, ...marks: AdfMark[]): AdfNode => (marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value });
const p = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const item = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });
const link = (href: string): AdfMark => ({ type: 'link', attrs: { href } });

const roundTrips: Array<[string, AdfDoc, string]> = [
  ['paragraph', doc(p(text('Hello world'))), 'Hello world'],
  ['two paragraphs', doc(p(text('one')), p(text('two'))), 'one\n\ntwo'],
  ['heading', doc({ type: 'heading', attrs: { level: 2 }, content: [text('Scope')] }), '## Scope'],
  ['bullet list', doc({ type: 'bulletList', content: [item(p(text('a'))), item(p(text('b')))] }), '- a\n- b'],
  [
    'ordered list from 3',
    doc({ type: 'orderedList', attrs: { order: 3 }, content: [item(p(text('c'))), item(p(text('d')))] }),
    '3. c\n4. d',
  ],
  [
    'nested list',
    doc({
      type: 'bulletList',
      content: [item(p(text('a')), { type: 'orderedList', attrs: { order: 1 }, content: [item(p(text('a1')))] }), item(p(text('b')))],
    }),
    '- a\n  1. a1\n- b',
  ],
  ['item with two paragraphs', doc({ type: 'bulletList', content: [item(p(text('a')), p(text('more')))] }), '- a\n\n  more'],
  [
    'code block',
    doc({ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;\n\nlet b = `x`;')] }),
    '```ts\nconst a = 1;\n\nlet b = `x`;\n```',
  ],
  ['code block without language', doc({ type: 'codeBlock', content: [text('plain')] }), '```\nplain\n```'],
  ['inline code', doc(p(text('run '), text('pnpm test', { type: 'code' }))), 'run `pnpm test`'],
  ['inline code with a backtick', doc(p(text('a`b', { type: 'code' }))), '``a`b``'],
  ['link', doc(p(text('see '), text('the spec', link('https://example.com/x?y=1')))), 'see [the spec](https://example.com/x?y=1)'],
  ['bold and italic', doc(p(text('b', { type: 'strong' }), text(' and '), text('i', { type: 'em' }))), '**b** and _i_'],
  ['bold italic link', doc(p(text('all', link('https://e.com'), { type: 'strong' }, { type: 'em' }))), '[**_all_**](https://e.com)'],
  ['code link', doc(p(text('fn', link('https://e.com'), { type: 'code' }))), '[`fn`](https://e.com)'],
  ['block quote', doc({ type: 'blockquote', content: [p(text('quoted')), p(text('again'))] }), '> quoted\n>\n> again'],
  ['hard break', doc(p(text('line one'), { type: 'hardBreak' }, text('line two'))), 'line one\\\nline two'],
  [
    'mention',
    doc(p(text('ping '), { type: 'mention', attrs: { id: 'acc-0001', text: '@Ana Lima' } })),
    'ping [@Ana Lima](mention:acc-0001)',
  ],
  ['text that looks like Markdown', doc(p(text('# not *a* [heading] 1. x_y _z_'))), '\\# not \\*a\\* \\[heading\\] 1. x_y \\_z\\_'],
  ['text opening a list', doc(p(text('- not a list')), p(text('2. nor this'))), '\\- not a list\n\n2\\. nor this'],
  ['heading with marks', doc({ type: 'heading', attrs: { level: 1 }, content: [text('Use '), text('adf', { type: 'code' })] }), '# Use `adf`'],
];

for (const [name, adf, markdown] of roundTrips) {
  test(`${name}: ADF to Markdown and back to the same document`, () => {
    assert.equal(adfToMarkdown(adf), markdown);
    assert.deepEqual(markdownToAdf(markdown), adf);
  });
}

test('a mention reads in Markdown as the person name', () => {
  const md = adfToMarkdown(doc(p({ type: 'mention', attrs: { id: 'acc-1', text: '@Ana' } })));
  assert.match(md, /^\[@Ana\]/);
});

test('an unsupported node becomes its text content, block children one per line', () => {
  const cell = (value: string): AdfNode => ({ type: 'tableCell', content: [p(text(value))] });
  const table: AdfNode = {
    type: 'table',
    content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }, { type: 'tableRow', content: [cell('c')] }],
  };
  const panel: AdfNode = { type: 'panel', attrs: { panelType: 'info' }, content: [p(text('heads up'))] };
  assert.equal(adfToMarkdown(doc(table, panel)), 'a\nb\nc\n\nheads up');
});

test('a node with no text becomes its type, never an empty string or an exception', () => {
  const media: AdfNode = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x', type: 'file' } }] };
  assert.equal(adfToMarkdown(doc(media, { type: 'rule' })), '\\[media\\]\n\n\\[rule\\]');
  const inline = p({ type: 'emoji', attrs: { shortName: ':smile:' } }, { type: 'inlineCard', attrs: { url: 'https://e.com' } });
  assert.equal(adfToMarkdown(doc(inline)), ':smile:https://e.com');
  assert.doesNotThrow(() => adfToMarkdown(doc({ type: 'whatever' }, p({ type: 'unknownInline' }))));
});

test('an unsupported mark is dropped and its text kept', () => {
  const marked = doc(p(text('gone', { type: 'strike' }), text(' red', { type: 'textColor', attrs: { color: '#f00' } }, { type: 'strong' })));
  assert.equal(adfToMarkdown(marked), 'gone **red**');
});

test('Markdown outside the subset becomes a code block with its literal source', () => {
  const table = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.deepEqual(markdownToAdf(`${table}\n\n![logo](https://e.com/l.png)\n\n<details>open</details>\n\n---`).content, [
    { type: 'codeBlock', content: [text(table)] },
    { type: 'codeBlock', content: [text('![logo](https://e.com/l.png)')] },
    { type: 'codeBlock', content: [text('<details>open</details>')] },
    { type: 'codeBlock', content: [text('---')] },
  ]);
});

test('empty Markdown is a valid document with one empty paragraph', () => {
  assert.deepEqual(markdownToAdf(''), doc(p()));
});

test('snake_case and a lone asterisk stay text', () => {
  assert.deepEqual(markdownToAdf('a_b_c and 2 * 3'), doc(p(text('a_b_c and 2 * 3'))));
});

test('a soft line break in a paragraph becomes a hard break', () => {
  assert.deepEqual(markdownToAdf('Delivers: x\nTouches: y'), doc(p(text('Delivers: x'), { type: 'hardBreak' }, text('Touches: y'))));
});

/** What each parent may hold in Jira's ADF schema, for the nodes the parser writes. */
const CHILDREN: Record<string, string[]> = {
  doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'blockquote'],
  paragraph: ['text', 'hardBreak', 'mention'],
  heading: ['text', 'hardBreak', 'mention'],
  bulletList: ['listItem'],
  orderedList: ['listItem'],
  listItem: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
  blockquote: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
  codeBlock: ['text'],
};

function assertValid(adf: AdfDoc): void {
  assert.equal(adf.version, 1);
  assert.equal(adf.type, 'doc');
  const walk = (node: AdfNode, parent: string): void => {
    assert.ok(CHILDREN[parent]?.includes(node.type), `${parent} cannot hold ${node.type}`);
    if (node.type === 'text') assert.ok(node.text, 'a text node holds text');
    if (node.type === 'text' && node.marks?.some((mark) => mark.type === 'code')) {
      assert.ok(node.marks.every((mark) => mark.type === 'code' || mark.type === 'link'), 'code sits only beside a link');
    }
    if (node.type === 'listItem') assert.ok(['paragraph', 'codeBlock'].includes(node.content?.[0]?.type ?? ''), 'a list item opens with a paragraph');
    for (const child of node.content ?? []) walk(child, node.type);
  };
  for (const node of adf.content) walk(node, 'doc');
}

test('an issue body the Hive writes converts to a valid ADF document', () => {
  const body = [
    '## Scope',
    '',
    'In: ADF to Markdown for **paragraphs**, `code` and [links](https://github.com/o/r/issues/1). Out: tables.',
    '',
    '## Acceptance criteria',
    '',
    '- each supported node converts back to an equal ADF document',
    '- an unsupported ADF node becomes its text content',
    '  - nested under it',
    '',
    '## Decomposition',
    '',
    'Parent: #612',
    'Touches: src/sources/adf.ts, test/sources/adf.test.ts',
    '',
    '1. first',
    '2. second',
    '',
    '```sh',
    'pnpm test',
    '```',
  ].join('\n');
  const adf = markdownToAdf(body);
  assertValid(adf);
  const types = ['heading', 'paragraph', 'heading', 'bulletList', 'heading', 'paragraph', 'orderedList', 'codeBlock'];
  assert.deepEqual(adf.content.map((node) => node.type), types);
});

test('a comment the Hive writes converts to a valid ADF document', () => {
  const comment = 'Opened #820 for the follow-up.\n\n> blocked by #813\n\nRun `pnpm test` and see https://e.com/run/1.';
  const adf = markdownToAdf(comment);
  assertValid(adf);
  assert.deepEqual(adf.content.map((node) => node.type), ['paragraph', 'blockquote', 'paragraph']);
});

test('a heading or a quote inside a list item or a quote is flattened to what Jira takes', () => {
  for (const md of ['- # h', '- > q', '- a\n\n  > note', '> # h', '> > q']) assertValid(markdownToAdf(md));
  assert.deepEqual(markdownToAdf('> > q'), doc({ type: 'blockquote', content: [p(text('q'))] }));
});

test('two lists of one kind in a row stay two lists', () => {
  const bullets = doc({ type: 'bulletList', content: [item(p(text('a')))] }, { type: 'bulletList', content: [item(p(text('b')))] });
  assert.deepEqual(markdownToAdf(adfToMarkdown(bullets)), bullets);
  const ordered = doc(
    { type: 'orderedList', attrs: { order: 1 }, content: [item(p(text('a')))] },
    { type: 'orderedList', attrs: { order: 5 }, content: [item(p(text('b')))] },
  );
  assert.deepEqual(markdownToAdf(adfToMarkdown(ordered)), ordered);
});

test('paragraph text that would open another block reads back as the same paragraph', () => {
  for (const value of ['<b>bold</b> text', '---', '  # x', '~~~']) {
    const adf = doc(p(text(value.trimStart())));
    assert.deepEqual(markdownToAdf(adfToMarkdown(doc(p(text(value))))), adf, value);
  }
  const broken = doc(p(text('a'), { type: 'hardBreak' }, text('- b')));
  assert.deepEqual(markdownToAdf(adfToMarkdown(doc(p(text('a'), { type: 'hardBreak' }, text(' - b'))))), broken);
});

test('a trailing hard break is dropped instead of leaving a backslash', () => {
  assert.deepEqual(markdownToAdf(adfToMarkdown(doc(p(text('a'), { type: 'hardBreak' })))), doc(p(text('a'))));
});

test('a heading keeps a closing hash and a hard break becomes a space', () => {
  const issue = doc({ type: 'heading', attrs: { level: 2 }, content: [text('Issue #')] });
  assert.deepEqual(markdownToAdf(adfToMarkdown(issue)), issue);
  const broken = doc({ type: 'heading', attrs: { level: 1 }, content: [text('a'), { type: 'hardBreak' }, text('b')] });
  assert.equal(adfToMarkdown(broken), '# a b');
});

test('a bang before a link does not turn the paragraph into an image', () => {
  const adf = doc(p(text('Wow!'), text('docs', link('https://e.com'))));
  assert.deepEqual(markdownToAdf(adfToMarkdown(adf)), adf);
});

test('only web and mail links pass, in both directions', () => {
  assert.equal(adfToMarkdown(doc(p(text('x', link('javascript:alert(1)'))))), 'x');
  assert.deepEqual(markdownToAdf('[x](javascript:alert)'), doc(p(text('x'))));
  assert.deepEqual(markdownToAdf('[m](mailto:a@e.com)'), doc(p(text('m', link('mailto:a@e.com')))));
  assert.equal(adfToMarkdown(doc(p(text('a', link('https://e.com/a b)\n![](x)'))))), '[a](https://e.com/a%20b%29%0A![]%28x%29)');
});

test('a field Jira holds never injects Markdown', () => {
  const mention = doc(p({ type: 'mention', attrs: { id: 'x) ![](https://evil.test/p.png', text: '@a' } }));
  assert.equal(adfToMarkdown(mention), '@a');
  const code = doc({ type: 'codeBlock', attrs: { language: 'js\n```\n![](https://evil.test/p.png)' }, content: [text('x')] });
  assert.equal(adfToMarkdown(code), '```\nx\n```');
  assert.deepEqual(markdownToAdf('[@a](mention:bad!id)'), doc(p(text('@a'))));
});

test('malformed ADF reads as what it can, never throwing', () => {
  const malformed = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: 'x' }, null, { type: 'paragraph', content: [{ type: 'text', text: 5, marks: 'no' }] }] };
  assert.doesNotThrow(() => adfToMarkdown(malformed as unknown as AdfDoc));
});

test('deep nesting stops at the depth limit instead of overflowing the stack', () => {
  assert.doesNotThrow(() => markdownToAdf('>'.repeat(10_000)));
  assert.doesNotThrow(() => markdownToAdf(`${'- '.repeat(10_000)}x`));
  assert.doesNotThrow(() => markdownToAdf(`${'['.repeat(10_000)}x${'](https://e.com)'.repeat(10_000)}`));
  let deep: AdfNode = p(text('core'));
  for (let level = 0; level < 10_000; level += 1) deep = { type: 'blockquote', content: [deep] };
  assert.match(adfToMarkdown(doc(deep)), /core/);
});

test('hostile text converts in linear time', () => {
  const n = 40_000;
  const inputs = ['*a '.repeat(n), '_a '.repeat(n), '**a '.repeat(n), '!['.repeat(n), `# a${' '.repeat(n)}b`, `a${' '.repeat(n)}b\nc`,
    `a${'\\'.repeat(n)}b\nc`, `a|b\n|-${' '.repeat(n)}x`, '['.repeat(n), '``a'.repeat(n), '[a](<'.repeat(n)];
  const started = performance.now();
  for (const input of inputs) markdownToAdf(input);
  adfToMarkdown(doc(p(text(`x${' '.repeat(n)}y`, { type: 'strong' }))));
  // generous: the quadratic paths these inputs once hit took seconds each; a loaded CI machine still finishes well inside it
  assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});

test('inline code opening a line is not read as a fence', () => {
  const adf = doc(p(text('``x', { type: 'code' })), p(text('after')));
  assert.deepEqual(markdownToAdf(adfToMarkdown(adf)), adf);
  const fences = doc(p(text('```js', { type: 'code' }), text(' fences')), p(text('rest')));
  assert.deepEqual(markdownToAdf(adfToMarkdown(fences)), fences);
});

test('image syntax inside inline code stays inline code', () => {
  const adf = doc(p(text('see '), text('![a](b.png)', { type: 'code' })));
  assert.deepEqual(markdownToAdf(adfToMarkdown(adf)), adf);
});

test('a list item never opens with a list', () => {
  for (const md of ['- - a', '1.\n   - x']) assertValid(markdownToAdf(md));
  assert.equal(markdownToAdf('- - a').content[0].content?.[0].content?.[0].type, 'paragraph');
});

test('a block marker line ending in U+2028 parses in linear time', () => {
  const started = performance.now();
  for (const marker of ['#', '-', '1.']) markdownToAdf(`${marker}${' '.repeat(40_000)}\u2028`);
  markdownToAdf(`a\n-${' '.repeat(40_000)}\u2028`);
  assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});

test('an absent document reads as no Markdown', () => {
  assert.equal(adfToMarkdown(null), '');
});

test('a paragraph of many thousand nodes renders in linear time', () => {
  const nodes = Array.from({ length: 80_000 }, (_, index) => (index % 2 === 0 ? text('!') : text('a', link('https://e.com'))));
  const started = performance.now();
  adfToMarkdown(doc(p(...nodes)));
  assert.ok(performance.now() - started < 3000, `took ${Math.round(performance.now() - started)} ms`);
});
