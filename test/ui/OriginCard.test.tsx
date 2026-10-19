import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OriginCard } from '@/components/plugins/OriginCard';
import { setLanguage } from '@/i18n';
import { resetMonacoFakes } from './monaco-fake';
import { BASED_ON, BUILD_TEXT, CATALOGUE, readOf, SECOND_ORIGIN, SPEC_TEXT, stubItems } from './plugins-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test("hovering based on opens the 340px card: the name, the item's description, then repository, version, license and link; leaving closes it (#320, decisions 15–17)", async () => {
  const user = userEvent.setup();
  render(<OriginCard basedOn={BASED_ON} description="builds the plan" />);
  const link = screen.getByRole('link', { name: 'baseada em superpowers:executing-plans ↗' });
  expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual([BASED_ON.url, '_blank']);
  await user.hover(link);
  const card = await screen.findByRole('dialog');
  expect(card).toHaveClass('w-[340px]');
  expect(within(card).getByRole('link', { name: 'abrir no github ↗' })).toHaveAttribute('href', BASED_ON.url);
  expect(card).toHaveTextContent(/^baseada emabrir no github ↗superpowers:executing-plansbuilds the plan/);
  expect(within(card).getAllByRole('term').map((term) => [term.textContent, term.nextElementSibling?.textContent])).toEqual([
    ['repositório', 'obra/superpowers'], ['versão', 'v4.3.0'], ['licença', 'MIT'], ['vínculo', 'só crédito · a hive não acompanha mudanças'],
  ]);
  await user.unhover(link);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

test('focus opens the card too; a url that is not http(s) is no link, in the head or the card (#320, decision 15)', async () => {
  const user = userEvent.setup();
  render(<OriginCard basedOn={{ ...BASED_ON, url: 'ftp://example.com/superpowers' }} description="" />);
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  await user.tab();
  const card = await screen.findByRole('dialog');
  expect(within(card).queryByRole('link')).not.toBeInTheDocument();
});

test('the head shows based on after the meta only for an item that has it (#320, decision 15)', async () => {
  stubItems({ catalogue: CATALOGUE, reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT }), 'hive:new-spec@': readOf('hive:new-spec', null, { 'SKILL.md': SPEC_TEXT }) } });
  render(<PluginsWindow />);
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-build/ }));
  const head = screen.getByTestId('head');
  expect(await within(head).findByRole('link', { name: 'baseada em superpowers:executing-plans ↗' })).toBeInTheDocument();
  expect(head).toHaveTextContent('skills · baseada em superpowers:executing-plans ↗');
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: /^new-spec/ }));
  await waitFor(() => expect(within(head).getByText('new-spec')).toBeInTheDocument());
  expect(within(head).queryByRole('link')).not.toBeInTheDocument();
});

test('a click on based on asks before opening an untrusted host, as a terminal link does, and opens nothing by itself (#320, decision 15)', async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  vi.stubGlobal('open', open);
  render(<OriginCard basedOn={BASED_ON} description="" />);
  await user.click(screen.getByRole('link', { name: 'baseada em superpowers:executing-plans ↗' }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent(BASED_ON.url);
  expect(open).not.toHaveBeenCalled();
});

test('two origins give two based on links after the meta, joined by ·, each opening its own card (#338, decision 11)', async () => {
  const user = userEvent.setup();
  const catalogue = CATALOGUE.map((item) => (item.id === 'hive:new-build' ? { ...item, basedOn: [BASED_ON, SECOND_ORIGIN] } : item));
  stubItems({ catalogue, reads: { 'hive:new-build@mine': readOf('hive:new-build', 'mine', { 'SKILL.md.liquid': BUILD_TEXT }) } });
  render(<PluginsWindow />);
  fireEvent.click(await within(await screen.findByRole('region', { name: 'skills' })).findByRole('button', { name: /^new-build/ }));
  const head = screen.getByTestId('head');
  const second = await within(head).findByRole('link', { name: 'baseada em ecc:planner ↗' });
  expect(within(head).getByRole('link', { name: 'baseada em superpowers:executing-plans ↗' })).toBeInTheDocument();
  expect(head).toHaveTextContent('skills · baseada em superpowers:executing-plans ↗ · baseada em ecc:planner ↗');
  await user.hover(second);
  const card = await screen.findByRole('dialog');
  expect(within(card).getAllByRole('term').map((term) => term.nextElementSibling?.textContent).slice(0, 3)).toEqual(['affaan-m/ECC', 'v2.2.1', 'MIT']);
});
