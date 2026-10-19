import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import type { CatalogueItem } from '../../src/types';
import { FakeEditor } from './monaco-fake';
import { BUILD_TEXT, CATALOGUE, type ItemsServer, readOf, SPEC_TEXT, versionOf } from './plugins-fixtures';

// The version menu of handoff 11j (#320): mine on agent-hive, tdd-first on hive-site, the hive's original last
export const today = (hours: number, minutes: number): string => new Date(new Date().setHours(hours, minutes, 0, 0)).toISOString();
export const MINE = versionOf('mine', { workspaces: ['agent-hive'], hiveVersion: '0.15', editedAt: today(14, 31) });
export const TDD = versionOf('tdd-first', { from: 'mine', workspaces: ['hive-site'], editedAt: today(9, 0) });
export const withBuild = (versions = [MINE, TDD]): CatalogueItem[] => CATALOGUE.map((i) => (i.id === 'hive:new-build' ? { ...i, versions } : i));
export const READS = {
  'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT }),
  'hive:new-build@tdd-first': readOf('hive:new-build', 'tdd-first', { 'SKILL.md.liquid': '---\nname: new-build\n---\ntdd-first text\n' }),
  'hive:new-build@': readOf('hive:new-build', null, { 'SKILL.md': '---\nname: new-build\n---\nThe original.\n' }),
  'hive:new-spec@': readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT }),
};
export const serverOf = (extra: Partial<ItemsServer> = {}): ItemsServer => ({ catalogue: withBuild(), reads: READS, ...extra });
export const head = (): HTMLElement => screen.getByTestId('head');
export const view = (): FakeEditor => FakeEditor.all.at(-1)!;
export const selector = (name: string): HTMLElement => within(head()).getByRole('button', { name });
export const fileTab = (name: string): HTMLElement => screen.getByRole('tab', { name });
export const sidebarItem = (name: string): HTMLElement => within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: new RegExp(`^${name}`) });
export const rowsOf = (menu: HTMLElement): HTMLElement[] => within(menu).getAllByRole('menuitemcheckbox');
export async function open(name: string): Promise<void> {
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(view().hiddenAreas.length).toBeGreaterThan(0));
}
// A version switch rebuilds the model, whose key carries the version: the editor that opened after `before`
export async function nextEditor(before: number): Promise<FakeEditor> {
  await waitFor(() => expect(FakeEditor.all.length).toBeGreaterThan(before));
  return FakeEditor.all.at(-1)!;
}
