import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { revealOf, useTreeReveal } from '@/hooks/use-tree-reveal';

// #718: whether the tree reveals the active file, and when. The tree's own effects are FilesPanel.reveal.test.tsx's
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const folderUrl = (path: string): string => `/activities/a-I1/tree/folder?path=${encodeURIComponent(path)}`;
const REPO = { files: ['x.md'], folders: ['agent'], repo: { marks: {}, ignored: [] } }; // a nested repository's read (#1)
const IGNORED = ['dist', 'docs', 'node_modules'];
let answer = (_url: string): Promise<Response> => Promise.resolve(json({ files: [], folders: [] }));
const fetchMock = vi.fn((url: string) => answer(url));
const reveal = vi.fn<(path: string) => void>();
const flush = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
interface Props { activeFile?: string; ignored?: readonly string[] }
const mount = (props: Props) => renderHook(({ activeFile, ignored }: Props) => useTreeReveal('a-I1', activeFile, ignored, false, reveal), { initialProps: props });

beforeEach(() => {
  answer = () => Promise.resolve(json({ files: [], folders: [] }));
  fetchMock.mockClear();
  reveal.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

test('revealOf: an absolute path or a hidden one with ocultos off is none; a path under no ignored folder reveals; under one, the outermost is checked (#718)', () => {
  expect(revealOf('/elsewhere/x.ts', IGNORED, true)).toBe('none');
  expect(revealOf('C:/elsewhere/x.ts', IGNORED, true)).toBe('none');
  expect(revealOf('.github/x.yml', IGNORED, false)).toBe('none');
  expect(revealOf('.github/x.yml', IGNORED, true)).toBe('reveal');
  expect(revealOf('src/a.ts', IGNORED, false)).toBe('reveal');
  expect(revealOf('distx/a.js', IGNORED, false)).toBe('reveal'); // only starts like an ignored folder
  expect(revealOf('node_modules/x/y.js', IGNORED, false)).toEqual({ check: 'node_modules' });
  expect(revealOf('docs/node_modules/x.js', ['docs/node_modules', ...IGNORED], false)).toEqual({ check: 'docs' });
});

test('a path under no ignored folder reveals once the tree has read, once per change: a re-render or a new tree read with the same active file reveals nothing more (#718)', async () => {
  const hook = mount({ activeFile: 'src/a.ts' });
  await flush();
  expect(reveal).not.toHaveBeenCalled(); // no tree read yet: the ignored folders are unknown
  hook.rerender({ activeFile: 'src/a.ts', ignored: IGNORED });
  hook.rerender({ activeFile: 'src/a.ts', ignored: [...IGNORED] }); // the next poll's answer, a new array
  await flush();
  expect(reveal.mock.calls).toEqual([['src/a.ts']]);
  hook.rerender({ activeFile: 'src/b.ts', ignored: IGNORED });
  expect(reveal.mock.calls).toEqual([['src/a.ts'], ['src/b.ts']]);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a path under an ignored folder reads that folder and reveals only when it is a nested repository; a plain ignored folder or a failed read reveals nothing (#718)', async () => {
  answer = (url) => Promise.resolve(
    url === folderUrl('docs') ? json(REPO) : url === folderUrl('node_modules') ? json({ files: [], folders: ['x'] }) : json({ error: 'gone' }, 404),
  );
  const hook = mount({ activeFile: 'docs/agent/x.md', ignored: IGNORED });
  await flush();
  expect(reveal.mock.calls).toEqual([['docs/agent/x.md']]);
  hook.rerender({ activeFile: 'node_modules/x/y.js', ignored: IGNORED });
  await flush();
  hook.rerender({ activeFile: 'dist/a.js', ignored: IGNORED });
  await flush();
  expect(reveal.mock.calls).toEqual([['docs/agent/x.md']]);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([folderUrl('docs'), folderUrl('node_modules'), folderUrl('dist')]);
});

test('a folder read that settles after the active file changed is dropped (#718)', async () => {
  let settle: (res: Response) => void = () => undefined;
  answer = () => new Promise((resolve) => { settle = resolve; });
  const hook = mount({ activeFile: 'docs/x.md', ignored: IGNORED });
  hook.rerender({ activeFile: 'src/a.ts', ignored: IGNORED });
  settle(json(REPO));
  await flush();
  expect(reveal.mock.calls).toEqual([['src/a.ts']]);
});
