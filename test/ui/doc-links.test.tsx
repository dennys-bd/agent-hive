import { expect, test } from 'vitest';
import { docLink, isExternalHref, isMarkdownPath } from '@/lib/doc-links';

test('a markdown file is .md or .markdown in any case; .mdx and anything else is not (#697)', () => {
  expect(['a.md', 'docs/Plan.MD', 'x.markdown'].map(isMarkdownPath)).toEqual([true, true, true]);
  expect(['page.mdx', 'a.ts', 'md', 'README'].map(isMarkdownPath)).toEqual([false, false, false, false]);
});

test('http(s) and mailto open outside; nothing else does (#697)', () => {
  expect(['https://x.dev', 'HTTP://x.dev', 'mailto:a@b.c'].map(isExternalHref)).toEqual([true, true, true]);
  expect(['#top', 'a.md', 'xmpp:a@b', '//x.dev'].map(isExternalHref)).toEqual([false, false, false, false]);
});

test('a link resolves against the previewed file\'s folder: an anchor stays in the document, a file joins the folder, its query dropped and its anchor kept; another scheme leads nowhere (#697)', () => {
  const from = 'docs/plans/p.md';
  expect(docLink('#task-3-the-preview', from)).toEqual({ kind: 'anchor', id: 'task-3-the-preview' });
  expect(docLink('../specs/s.md#closed-decisions', from)).toEqual({ kind: 'file', path: 'docs/plans/../specs/s.md', isMarkdown: true, anchor: 'closed-decisions' });
  expect(docLink('../../src/a.ts?plain=1', from)).toEqual({ kind: 'file', path: 'docs/plans/../../src/a.ts', isMarkdown: false });
  expect(docLink('notes%20one.md', '/docs-repo/p.md')).toEqual({ kind: 'file', path: '/docs-repo/notes one.md', isMarkdown: true });
  expect(docLink('s.md', 'p.md')).toEqual({ kind: 'file', path: 's.md', isMarkdown: true });
  expect(docLink('?x=1#top', from)).toEqual({ kind: 'anchor', id: 'top' });
  for (const href of ['#', '', 'xmpp:a@b', '//x.dev/a.md']) expect(docLink(href, from)).toEqual({ kind: 'none' });
});

test('the query and the hash are split off before decoding, so an encoded ? or # in a file name stays in it (#697)', () => {
  expect(docLink('a%3Fb.md?raw=1#top', 'p.md')).toEqual({ kind: 'file', path: 'a?b.md', isMarkdown: true, anchor: 'top' });
  expect(docLink('a%23b.md', 'p.md')).toEqual({ kind: 'file', path: 'a#b.md', isMarkdown: true });
});
