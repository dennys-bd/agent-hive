import { expect, test } from 'vitest';
import { bufferPath, renameTabs, storableLayouts } from '@/lib/center-files';
import { type CenterLayout, type CenterTabRef, groupsOf, initialLayout, openRef, readCenterLayouts, refKey, writeCenterLayouts } from '@/lib/center-layout';
import { resetViewState, writeView } from '@/lib/view-state';

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

test('a design tab follows a rename of its file or its folder, as the other file tabs do, and holds no buffer (#109)', () => {
  const layout = layoutOf({ kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'design', path: 'design/Landing.hv.html' }, { kind: 'design', path: 'other/A.hv.html' }] });
  expect(renameTabs(layout, 'design', 'mockups').root).toEqual({
    kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'design', path: 'mockups/Landing.hv.html' }, { kind: 'design', path: 'other/A.hv.html' }],
  });
  expect(bufferPath({ kind: 'design', path: 'design/Landing.hv.html' })).toBeUndefined();
});

const keysOf = (layout: CenterLayout): string[][] => groupsOf(layout.root).map((group) => group.tabs.map(refKey));

test('a diagram tab is keyed diagram:<path> beside its editor tab, opens once and round-trips; a stored one with a .. path drops its layout (#956)', () => {
  resetViewState({});
  const diagram: CenterTabRef = { kind: 'diagram', path: 'docs/arch.drawio' };
  const opened = openRef(openRef(initialLayout({ kind: 'file', path: 'docs/arch.drawio' }), diagram), diagram);
  expect(keysOf(opened)).toEqual([['file:docs/arch.drawio', 'diagram:docs/arch.drawio']]);
  writeCenterLayouts({ I1: opened });
  expect(readCenterLayouts()).toEqual({ I1: opened });
  writeView('centerLayouts', { I1: initialLayout({ kind: 'diagram', path: '../x.drawio' }) });
  expect(readCenterLayouts()).toEqual({});
});

test('a diagram tab follows a rename of its folder and holds no buffer (#956)', () => {
  const layout = layoutOf({ kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'diagram', path: 'docs/arch.drawio' }] });
  expect(renameTabs(layout, 'docs', 'design').root).toEqual({ kind: 'group', id: 'g1', active: 0, tabs: [{ kind: 'diagram', path: 'design/arch.drawio' }] });
  expect(bufferPath({ kind: 'diagram', path: 'docs/arch.drawio' })).toBeUndefined();
});
