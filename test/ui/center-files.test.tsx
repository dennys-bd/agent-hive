import { expect, test } from 'vitest';
import { bufferPath, renameTabs, storableLayouts } from '@/lib/center-files';
import type { CenterLayout } from '@/lib/center-layout';

const layoutOf = (root: CenterLayout['root']): CenterLayout => ({ root, focused: 'g1' });

test('renameTabs moves the file, preview and changes tabs on the path or under a renamed folder; runs and other files stay (#818)', () => {
  const layout = layoutOf({ kind: 'group', id: 'g1', active: 1, tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'src/a.ts' }, { kind: 'preview', path: 'src/docs/x.md' }, { kind: 'changes', path: 'src/a.ts' }, { kind: 'file', path: 'srcs/b.ts' }] });
  expect(renameTabs(layout, 'src', 'lib').root).toEqual({
    kind: 'group', id: 'g1', active: 1,
    tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'file', path: 'lib/a.ts' }, { kind: 'preview', path: 'lib/docs/x.md' }, { kind: 'changes', path: 'lib/a.ts' }, { kind: 'file', path: 'srcs/b.ts' }],
  });
});

test('an untitled tab is never stored: storableLayouts drops it, and a layout left with no tab goes (#818)', () => {
  const both = layoutOf({ kind: 'group', id: 'g1', active: 1, tabs: [{ kind: 'run', ptyId: 'W1' }, { kind: 'untitled', n: 1 }] });
  const alone = layoutOf({ kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'untitled', n: 2 }] });
  expect(storableLayouts({ I1: both, I2: alone })).toEqual({ I1: layoutOf({ kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'run', ptyId: 'W1' }] }) });
  expect([bufferPath({ kind: 'file', path: 'a.ts' }), bufferPath({ kind: 'changes', path: 'a.ts' }), bufferPath({ kind: 'preview', path: 'a.md' })]).toEqual(['a.ts', 'a.ts', undefined]);
  expect(bufferPath({ kind: 'untitled', n: 3 })).toMatch(/untitled-3$/);
});
