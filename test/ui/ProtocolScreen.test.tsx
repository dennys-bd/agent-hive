import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { setVariableValue } from '../../src/template-edit';
import { resetMonacoFakes } from './monaco-fake';
import { json } from './plugins-fixtures';
import { PROTOCOL_READ, passageOf, stubProtocol, withPassages } from './protocol-fixtures';
import { PluginsWindow } from './skill-editor-harness';

vi.mock('@/lib/monaco', async () => (await import('./monaco-fake')).monacoModule);

type User = ReturnType<typeof userEvent.setup>;
const INSERT = '+ inserir trecho aqui';
const BODY = 'texto do trecho';
const SITE_ONLY = '{% if workspace == "hive-site" %}\nOnly for the site.\n{% endif %}\n';

async function openProtocol(user: User): Promise<HTMLElement> {
  await user.click(within(screen.getByRole('navigation', { name: 'Plugins' })).getByRole('button', { name: 'protocolo' }));
  return screen.findByRole('region', { name: 'protocolo' });
}

beforeEach(() => {
  setLanguage('pt');
  resetMonacoFakes();
});
afterEach(() => vi.unstubAllGlobals());

test('the head, then the blocks in order, each locked, with + inserir trecho aqui after each and none before intro; a block turned off is at .45, struck through, with its tool (#337)', async () => {
  const user = userEvent.setup();
  stubProtocol({ read: () => ({ ...PROTOCOL_READ, blocks: PROTOCOL_READ.blocks.map((b) => (b.id === 'remember' ? { ...b, off: true } : b)) }) });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  expect(screen.getByTestId('head')).toHaveTextContent('protocoloinjetado em toda sessão · trechos da hive travados · os seus entre eles');
  const blocks = await within(centre).findAllByRole('article');
  expect(blocks.map((b) => b.getAttribute('aria-label'))).toEqual(['intro', 'done', 'result', 'ask', 'stop', 'remember', 'why', 'undo']);
  expect(centre.firstElementChild).toBe(blocks[0]);
  expect(blocks[0].nextElementSibling).toHaveTextContent(INSERT);
  expect(within(centre).getAllByRole('button', { name: INSERT })).toHaveLength(8);
  expect(within(blocks[0]).getByText('da hive · atualiza sozinho')).toBeInTheDocument();
  const remember = blocks[5];
  expect(remember).toHaveClass('opacity-45');
  expect(within(remember).getByText(PROTOCOL_READ.blocks[5].stage)).toHaveClass('line-through');
  expect(within(remember).getByText('da hive · fora do protocolo')).toBeInTheDocument();
  expect(within(remember).getByText('hive_remember desligada em mcp')).toBeInTheDocument();
  expect(blocks[4]).not.toHaveClass('opacity-45');
});

test('+ inserir trecho aqui after ask opens a draft there; typing and salvar POSTs the header and the body, and the saved passage shows after ask (#337)', async () => {
  const user = userEvent.setup();
  let read = PROTOCOL_READ;
  const { calls } = stubProtocol({
    read: () => read,
    write: () => {
      read = withPassages(passageOf('p1', 'ask', 'Check the docs.'));
      return json({ id: 'p1' }, 201);
    },
  });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  await within(centre).findAllByRole('article');
  await user.click(within(centre).getAllByRole('button', { name: INSERT })[3]); // the fourth block is ask
  const draft = within(centre).getByRole('article', { name: 'novo trecho' });
  expect(draft.previousElementSibling).toHaveAttribute('aria-label', 'ask');
  expect(within(draft).getByRole('button', { name: 'salvar' })).toBeDisabled();
  await user.type(within(draft).getByRole('textbox', { name: BODY }), 'Check the docs.');
  await user.click(within(draft).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'POST', path: '/api/protocol/passages', body: { text: '---\nafter: ask\n---\nCheck the docs.' } }]));
  const saved = await within(centre).findByRole('article', { name: 'p1' });
  expect(saved.previousElementSibling).toHaveAttribute('aria-label', 'ask');
  expect(within(centre).queryByRole('article', { name: 'novo trecho' })).not.toBeInTheDocument();
});

test('cancelar drops a new draft and sends nothing (#337)', async () => {
  const user = userEvent.setup();
  const { calls } = stubProtocol();
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  await within(centre).findAllByRole('article');
  await user.click(within(centre).getAllByRole('button', { name: INSERT })[0]);
  await user.click(within(within(centre).getByRole('article', { name: 'novo trecho' })).getByRole('button', { name: 'cancelar' }));
  expect(within(centre).queryByRole('article', { name: 'novo trecho' })).not.toBeInTheDocument();
  expect(calls).toEqual([]);
});

test('a saved passage: salvar is off until its text changes, and ⌘S PUTs the whole text with the header unchanged (#337)', async () => {
  const user = userEvent.setup();
  const { calls } = stubProtocol({ read: () => withPassages(passageOf('p1', 'ask', 'Check the docs.')), write: () => json({ id: 'p1' }) });
  render(<PluginsWindow />);
  const card = await within(await openProtocol(user)).findByRole('article', { name: 'p1' });
  expect(within(card).getByRole('button', { name: 'salvar' })).toBeDisabled();
  const body = within(card).getByRole('textbox', { name: BODY });
  expect(body).toHaveValue('Check the docs.');
  await user.type(body, ' Twice.');
  expect(within(card).getByRole('button', { name: 'salvar' })).toBeEnabled();
  await user.keyboard('{Meta>}s{/Meta}');
  await waitFor(() => expect(calls).toEqual([{ method: 'PUT', path: '/api/protocol/passages/p1', body: { text: '---\nafter: ask\n---\nCheck the docs. Twice.' } }]));
});

test("a refused save shows the route's errors under the text, a body line counted from the body, a header error with no line (#337)", async () => {
  const user = userEvent.setup();
  stubProtocol({ write: () => json({ errors: [{ line: 4, message: 'tag "if" not closed' }, { line: 2, message: 'after must be one of: intro' }] }, 400) });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  await within(centre).findAllByRole('article');
  await user.click(within(centre).getAllByRole('button', { name: INSERT })[0]);
  const draft = within(centre).getByRole('article', { name: 'novo trecho' });
  await user.type(within(draft).getByRole('textbox', { name: BODY }), 'x');
  await user.click(within(draft).getByRole('button', { name: 'salvar' }));
  expect(await within(draft).findByText('linha 1 tag "if" not closed')).toHaveClass('text-destructive');
  expect(within(draft).getByText('after must be one of: intro')).toHaveClass('text-destructive');
});

test('apagar asks first, then DELETEs the passage (#337)', async () => {
  const user = userEvent.setup();
  const { calls } = stubProtocol({ read: () => withPassages(passageOf('p1', 'ask', 'mine')), write: () => new Response(null, { status: 204 }) });
  render(<PluginsWindow />);
  const card = await within(await openProtocol(user)).findByRole('article', { name: 'p1' });
  await user.click(within(card).getByRole('button', { name: 'apagar' }));
  expect(calls).toEqual([]);
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'apagar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'DELETE', path: '/api/protocol/passages/p1' }]));
});

test('a passage inside an if on hive-site shows só em hive-site; a plain one shows no condition (#337)', async () => {
  const user = userEvent.setup();
  stubProtocol({ read: () => withPassages(passageOf('p1', 'ask', SITE_ONLY), passageOf('p2', 'done', 'plain')) });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  expect(within(await within(centre).findByRole('article', { name: 'p1' })).getByText('só em hive-site')).toBeInTheDocument();
  expect(within(within(centre).getByRole('article', { name: 'p2' })).queryByText(/^(só em|em nenhum)/)).not.toBeInTheDocument();
});

test('an orphan shows after the last block with its yellow line; a passage that fails in one workspace says it is left out there (#337)', async () => {
  const user = userEvent.setup();
  const message = 'variable "team" is required and has no value for workspace "hive-site"';
  stubProtocol({
    read: () => withPassages(
      passageOf('p1', 'gone', 'old', { orphan: true }),
      passageOf('p2', 'ask', 'Ask the team.', { errors: { 'hive-site': [{ line: 4, message, variable: 'team' }] } }),
    ),
  });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  const orphan = await within(centre).findByRole('article', { name: 'p1' });
  expect(within(centre).getAllByRole('article').at(-1)).toBe(orphan);
  expect(within(orphan).getByText('o bloco dele foi removido por uma atualização da Hive')).toHaveClass('text-waiting');
  const failing = within(centre).getByRole('article', { name: 'p2' });
  expect(within(failing).getByText(`fora de hive-site: linha 1 ${message}`)).toHaveClass('text-destructive');
});

test('a failed read of the protocol replaces the list with its message (#337)', async () => {
  const user = userEvent.setup();
  stubProtocol({ read: () => json({ error: 'boom' }, 500) });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  expect(await within(centre).findByRole('alert')).toHaveTextContent('não foi possível ler o protocolo');
  expect(within(centre).queryAllByRole('article')).toEqual([]);
});

test('ver como a workspace shows its stage text read-only with no cards and the passages left out there; a 404 from the render goes back to the template (#337)', async () => {
  const user = userEvent.setup();
  let isGone = false;
  stubProtocol({
    read: () => withPassages(passageOf('p1', 'ask', 'mine', { errors: { 'hive-site': [{ line: 4, message: 'boom' }] } })),
    render: (workspace: string) => (isGone ? json({ error: 'unknown workspace' }, 404) : json({ stage: `stage of ${workspace}\nmine\n`, session: '' })),
  });
  render(<PluginsWindow />);
  const centre = await openProtocol(user);
  await within(centre).findByRole('article', { name: 'p1' });
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'hive-site' }));
  expect(await within(centre).findByLabelText('protocolo de hive-site')).toHaveTextContent('stage of hive-site mine');
  expect(within(centre).queryAllByRole('article')).toEqual([]);
  expect(within(centre).getByText('p1 fora: boom')).toHaveClass('text-destructive');
  isGone = true;
  await user.click(screen.getByRole('combobox', { name: 'ver como' }));
  await user.click(await screen.findByRole('option', { name: 'agent-hive' }));
  expect(await within(centre).findByRole('article', { name: 'p1' })).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'ver como' })).toHaveTextContent('template');
});

test("the right pane lists the selected passage's variables; a value set there changes the draft, not the server, until salvar (#337)", async () => {
  const user = userEvent.setup();
  const text = '---\nafter: ask\nvariables:\n  docsRepo: { default: null }\n---\nSee {{ docsRepo }}.\n';
  const { calls } = stubProtocol({ read: () => withPassages({ ...passageOf('p1', 'ask', ''), text }), write: () => json({ id: 'p1' }) });
  render(<PluginsWindow />);
  const card = await within(await openProtocol(user)).findByRole('article', { name: 'p1' });
  const aside = screen.getByRole('complementary');
  expect(within(aside).getByText('mostra o texto que a sessão recebe neste workspace')).toBeInTheDocument();
  expect(within(aside).getByText('selecione um trecho para ver as variáveis dele')).toBeInTheDocument();
  await user.click(within(card).getByRole('textbox', { name: BODY }));
  await user.click(within(within(aside).getByRole('listitem', { name: 'docsRepo' })).getByLabelText('docsRepo · hive-site'));
  await user.type(within(aside).getByRole('textbox', { name: 'docsRepo · hive-site' }), 'site-docs{Enter}');
  await waitFor(() => expect(within(aside).getByLabelText('docsRepo · hive-site')).toHaveTextContent('site-docs'));
  expect(calls).toEqual([]);
  expect(within(card).getByRole('textbox', { name: BODY })).toHaveValue('See {{ docsRepo }}.\n');
  const written = setVariableValue(text, 'docsRepo', 'hive-site', 'site-docs');
  if (!written.ok) throw new Error(written.error.message);
  await user.click(within(card).getByRole('button', { name: 'salvar' }));
  await waitFor(() => expect(calls).toEqual([{ method: 'PUT', path: '/api/protocol/passages/p1', body: { text: written.text } }]));
});
