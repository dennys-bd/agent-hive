import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { callsTo, fakeHive, type FakeHive, LABEL, renderPane } from './diff-harness';

let hive: FakeHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakeHive(); });
afterEach(() => vi.unstubAllGlobals());
const list = (): HTMLElement => screen.getByRole('navigation', { name: 'arquivos do diff' });
const current = (): string => within(list()).getAllByRole('button').find((b) => b.getAttribute('aria-current') === 'true')?.textContent ?? '';

test('] and [ move the open file, V marks it, only while the focus is in the pane and not in a text field (#591)', async () => {
  const user = userEvent.setup();
  renderPane();
  await within(screen.getByRole('region', { name: LABEL })).findByRole('region', { name: 'src/a.ts' });
  await user.click(within(list()).getAllByRole('button')[0]);
  await user.keyboard(']');
  expect(current()).toMatch(/^Mb\.ts/);
  await user.keyboard('[[');
  expect(current()).toMatch(/^Msrc\/a\.ts/);
  await user.keyboard('[[');
  expect(current()).toMatch(/^Aimg\/logo\.png/);
  await user.keyboard('v');
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')[0].body).toMatchObject({ path: 'img/logo.png', reviewed: true });
  await user.click(within(list()).getByRole('textbox', { name: 'filtrar arquivos' }));
  await user.keyboard(']v');
  expect(callsTo(hive, 'POST', '/tasks/I1/review/reviewed')).toHaveLength(1);
});
