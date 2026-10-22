import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { ANCHOR, AT, fakePrHive, type FakePrHive, HEAD, prCalls, prChanges, prData, renderPage, ROUTE, thread } from './pr-harness';

let hive: FakePrHive;
beforeEach(() => { setLanguage('pt'); localStorage.clear(); hive = fakePrHive(); });
afterEach(() => vi.unstubAllGlobals());
const section = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'src/a.ts' });
const reads = (): number => hive.calls.filter((c) => c.method === 'GET' && c.url === ROUTE).length;

// The page with its files tab shown (#758)
async function showFiles(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  renderPage();
  await user.click(await screen.findByRole('tab', { name: /^arquivos/ }));
  return user;
}

test('files draws the PR\'s files and conversations, a GitHub author by login and the viewer as você (#592, #758)', async () => {
  hive.changes = prChanges({ threads: [thread({ comments: [{ id: 'C1', author: 'bia', at: AT, text: 'why?' }, { id: 'C2', author: 'ana', at: AT, text: 'because' }] })] });
  await showFiles();
  const conversation = await within(await section()).findByRole('group', { name: 'conversa' });
  expect(within(conversation).getByText('bia')).toHaveClass('font-medium');
  expect(within(conversation).getByText('você')).toBeInTheDocument();
  expect(screen.getByRole('toolbar', { name: 'arquivos' })).toHaveTextContent('1 arquivo · +1 −1');
});

test('a merged PR\'s files are read only: its conversations show, with no +, no reply, no resolver and no footer (#592, #758)', async () => {
  hive.pr = prData({ state: 'merged' });
  await showFiles();
  const s = await section();
  await within(s).findByRole('group', { name: 'conversa' });
  expect(within(s).queryAllByRole('button', { name: /^comentar/ })).toEqual([]);
  expect(within(s).queryByRole('textbox', { name: 'responder' })).toBeNull();
  expect(within(s).queryByRole('button', { name: 'resolver' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'revisão do PR' })).toBeNull();
});

test('an outdated conversation sits at the top of its file; one whose file left the diff sits in fora do diff at the top (#592, #758)', async () => {
  hive.changes = prChanges({ threads: [thread({ outdated: true }), thread({ id: 'T2', anchor: { path: 'gone.ts', side: 'new', start: 1, end: 1 } })] });
  await showFiles();
  const outdated = await within(await section()).findByRole('group', { name: 'conversa' });
  expect(outdated).toHaveTextContent('desatualizado');
  expect(outdated.closest('tr')).toBeNull();
  const gone = screen.getByRole('region', { name: 'fora do diff' });
  expect(gone).toHaveTextContent('gone.ts');
  expect(within(gone).getByRole('group', { name: 'conversa' })).toBeInTheDocument();
});

test('a comment sent now posts its lines with the head the page showed and reads the PR again; adicionar à revisão posts a draft (#592, #758)', async () => {
  hive.changes = prChanges({ threads: [] });
  const user = await showFiles();
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const box = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(box).getByRole('textbox', { name: 'comentário' }), 'why?');
  await user.click(within(box).getByRole('button', { name: 'enviar' }));
  await waitFor(() => expect(prCalls(hive, 'POST', `${ROUTE}/comment`)[0]?.body).toEqual({ head: HEAD, anchor: ANCHOR, text: 'why?' }));
  await waitFor(() => expect(reads()).toBe(2));
  await user.click(within(await section()).getByRole('button', { name: 'comentar linha 2' }));
  const again = screen.getByRole('group', { name: 'linha 2' });
  await user.type(within(again).getByRole('textbox', { name: 'comentário' }), 'later');
  await user.click(within(again).getByRole('button', { name: 'adicionar à revisão' }));
  expect(prCalls(hive, 'POST', `${ROUTE}/drafts`)[0].body).toEqual({ anchor: ANCHOR, text: 'later' });
});
