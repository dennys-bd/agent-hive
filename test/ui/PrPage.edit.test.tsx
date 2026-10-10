import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { AT, fakePrHive, type FakePrHive, prCalls, prData, renderPage, ROUTE } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());
const reads = (): number => hive.calls.filter((c) => c.method === 'GET' && c.url === ROUTE).length;

test('the title and the description edit in place, each sent with the updatedAt the page read; the page reads the PR again (#758)', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  expect(screen.getByRole('region', { name: 'descrição' })).toHaveTextContent('bia');
  const [title, description] = screen.getAllByRole('button', { name: 'editar' });
  await user.click(title);
  const field = screen.getByRole('textbox', { name: 'título' });
  await user.clear(field);
  await user.type(field, 'Better title');
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', ROUTE)[0]?.body).toEqual({ title: 'Better title', updatedAt: AT }));
  await waitFor(() => expect(reads()).toBe(2));
  await user.click(description);
  const box = screen.getByRole('textbox', { name: 'descrição' });
  await user.clear(box);
  await user.type(box, 'Better body');
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', ROUTE)[1]?.body).toEqual({ body: 'Better body', updatedAt: AT }));
});

test('a 409 says the PR changed, reads it again and keeps the draft in the field (#758)', async () => {
  const user = userEvent.setup();
  hive.answers[`POST ${ROUTE}`] = { status: 409, body: { error: 'the PR changed on GitHub since the page read it' } };
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  await user.click(screen.getAllByRole('button', { name: 'editar' })[0]);
  await user.type(screen.getByRole('textbox', { name: 'título' }), ' again');
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  expect(await screen.findByText('o PR mudou no GitHub; recarregado, seu texto foi mantido')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'título' })).toHaveValue('The PR again');
  await waitFor(() => expect(reads()).toBe(2));
});

test('a refresh with a newer updatedAt while a draft is open does not re-arm the save: it goes with the updatedAt the edit started on, so GitHub can 409 (#758)', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  await user.click(screen.getAllByRole('button', { name: 'editar' })[0]);
  await user.type(screen.getByRole('textbox', { name: 'título' }), ' again');
  hive.pr = prData({ updatedAt: '2026-10-01T10:00:00.000Z', title: 'Remote title' });
  await user.type(screen.getByRole('textbox', { name: 'comentar no PR…' }), 'thanks');
  await user.click(screen.getByRole('button', { name: /^comentar/ }));
  await waitFor(() => expect(reads()).toBe(2));
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', ROUTE)[0]?.body).toEqual({ title: 'The PR again', updatedAt: AT }));
});

test('after a 409 the reloaded updatedAt is the one the next save sends (#758)', async () => {
  const user = userEvent.setup();
  const NEWER = '2026-10-01T10:00:00.000Z';
  hive.answers[`POST ${ROUTE}`] = { status: 409, body: { error: 'changed' } };
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  await user.click(screen.getAllByRole('button', { name: 'editar' })[0]);
  await user.type(screen.getByRole('textbox', { name: 'título' }), ' again');
  hive.pr = prData({ updatedAt: NEWER });
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await screen.findByText('o PR mudou no GitHub; recarregado, seu texto foi mantido');
  await waitFor(() => expect(reads()).toBe(2));
  delete hive.answers[`POST ${ROUTE}`];
  await user.click(screen.getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', ROUTE)[1]?.body).toEqual({ title: 'The PR again', updatedAt: NEWER }));
});

test('a merged PR, or one GitHub says the login cannot update, shows no edit (#758)', async () => {
  hive.pr = prData({ state: 'merged' });
  const { unmount } = renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  expect(screen.queryByRole('button', { name: 'editar' })).toBeNull();
  unmount();
  hive.pr = prData({ canEdit: false });
  renderPage();
  await screen.findByRole('heading', { name: 'The PR' });
  expect(screen.queryByRole('button', { name: 'editar' })).toBeNull();
});
