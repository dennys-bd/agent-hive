import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { CATALOGUE, OWN, OWN_TEXT, readOf, stubItems, versionOf } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';
import { open, rowsOf, selector } from './version-menu-fixtures';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

// Its own file: Radix's menus open once per file under jsdom (see Flow.contextmenu.test.tsx). In English, so the entry's copy is pinned in both languages
beforeEach(() => {
  setLanguage('en');
  resetMonacoFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLanguage('pt');
});

test("a user-created item's version that a workspace still runs offers its delete disabled, with what to do first; its rows read created by you (#983)", async () => {
  const user = userEvent.setup();
  const two = { ...OWN, versions: [versionOf('mine', { from: null, workspaces: ['agent-hive'] }), versionOf('tdd', { from: null })] };
  stubItems({ catalogue: [...CATALOGUE, two], reads: { 'hive:release-check@mine': readOf('hive:release-check', 'mine', { 'SKILL.md': OWN_TEXT }) } });
  render(<PluginsWindow />);
  await open('release-check');
  await user.click(selector('mine'));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'delete mine…' })).toHaveAttribute('aria-disabled', 'true');
  expect(menu).toHaveTextContent("move mine's workspaces to another version before deleting it.");
  expect(rowsOf(menu).map((row) => row.textContent?.includes('created by you'))).toEqual([true, true]);
  expect(menu.lastElementChild).toHaveTextContent('each workspace uses one version. editing here changes only the open version.');
});
