import { expect, test } from 'vitest';
import { ALERT_KINDS, type MdNode, remarkAlerts } from '@/lib/remark-alerts';

const text = (value: string): MdNode => ({ type: 'text', value });
const paragraph = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children });
const quote = (...children: MdNode[]): MdNode => ({ type: 'blockquote', children });
const root = (...children: MdNode[]): MdNode => ({ type: 'root', children });
const alert = (kind: string, ...children: MdNode[]): MdNode => ({ type: 'blockquote', children, data: { hName: 'aside', hProperties: { dataAlert: kind } } });
const run = (tree: MdNode): MdNode => remarkAlerts()(tree);

test('each of the five markers turns its blockquote into an aside carrying its kind, the marker and its line break gone (#697)', () => {
  for (const kind of ALERT_KINDS) {
    expect(run(root(quote(paragraph(text(`[!${kind.toUpperCase()}]\nbody`)))))).toEqual(root(alert(kind, paragraph(text('body')))));
  }
});

test('a lower-case marker counts; a marker alone in its paragraph leaves the next blocks; a quote nested in a list turns too (#697)', () => {
  expect(run(root(quote(paragraph(text('[!tip]')), paragraph(text('more')))))).toEqual(root(alert('tip', paragraph(text('more')))));
  const nested = run(root({ type: 'list', children: [{ type: 'listItem', children: [quote(paragraph(text('[!NOTE]\nx')))] }] }));
  expect(nested.children?.[0].children?.[0].children?.[0]).toEqual(alert('note', paragraph(text('x'))));
});

test('a blockquote with no marker, or with one past its first line, is left as it was, and the input is never touched (#697)', () => {
  const plain = root(quote(paragraph(text('just a quote'))), quote(paragraph(text('first\n[!NOTE] later'))));
  const before = JSON.stringify(plain);
  expect(run(plain)).toEqual(plain);
  expect(JSON.stringify(plain)).toBe(before);
});
