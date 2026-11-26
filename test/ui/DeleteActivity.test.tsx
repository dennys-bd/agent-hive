import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DeleteActivity, type Refusal } from '@/components/DeleteActivity';
import { setLanguage } from '@/i18n';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const DELETE_URL = '/activities/a-I1/delete';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => reply({ removed: true }));
beforeEach(() => { setLanguage('en'); vi.stubGlobal('fetch', fetchMock); fetchMock.mockClear(); vi.mocked(toast.error).mockClear(); });
afterEach(() => vi.unstubAllGlobals());

// The first confirm opened by its caller, as the ⋯ menu does; its button posts without force
function Harness() {
  const [isOpen, setIsOpen] = useState(true);
  return <DeleteActivity url={DELETE_URL} message="delete this activity?" available confirm={{ open: isOpen, onOpenChange: setIsOpen }} />;
}
const confirmDelete = (user: ReturnType<typeof userEvent.setup>) => user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'delete activity' }));

const REASONS: [Refusal, string][] = [
  [{ reason: 'dirty', path: '/repo/.hive/worktrees/hive-1-task', files: ' M src/a.ts\n?? notes.md' }, '/repo/.hive/worktrees/hive-1-task has changes that are not committed: M src/a.ts ?? notes.md'],
  [{ reason: 'unmerged', branch: 'hive/1-task', target: 'HEAD' }, 'the branch hive/1-task is not merged into HEAD'],
  [{ reason: 'unexpected' }, 'Unexpected error'],
];
const NO_ACCOUNT: Refusal = { reason: 'unmerged', branch: 'hive/1-task', target: 'HEAD', noAccount: ['gitlab.com', 'git.example.com'] };

test('an unmerged refusal with hosts it had no account for adds one line per host, in both languages (#1053)', async () => {
  const user = userEvent.setup();
  for (const [language, text] of [
    ['en', 'the branch hive/1-task is not merged into HEAD connect a GitLab account for gitlab.com in Settings to read its PR connect a GitLab account for git.example.com in Settings to read its PR'],
    ['pt', 'o branch hive/1-task não está mergeado em HEAD conecte uma conta do GitLab para gitlab.com na configuração para ler o PR dele conecte uma conta do GitLab para git.example.com na configuração para ler o PR dele'],
  ] as const) {
    setLanguage(language);
    fetchMock.mockImplementationOnce(async () => reply({ removed: false, refused: NO_ACCOUNT }));
    const { unmount } = render(<Harness />);
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: language === 'en' ? 'delete activity' : 'excluir atividade' }));
    expect(await screen.findByRole('alertdialog', { name: language === 'en' ? 'Force the removal' : 'Forçar remoção' })).toHaveTextContent(text);
    unmount();
  }
});

test('each refusal reason opens the force popup with its own copy, then the force warning (#660)', async () => {
  const user = userEvent.setup();
  for (const [refused, text] of REASONS) {
    fetchMock.mockImplementationOnce(async () => reply({ removed: false, refused }));
    const { unmount } = render(<Harness />);
    await confirmDelete(user);
    const popup = await screen.findByRole('alertdialog', { name: 'Force the removal' });
    expect(popup).toHaveTextContent(text);
    expect(popup).toHaveTextContent('lost for good');
    unmount();
  }
});

test('a failed post toasts Unexpected error, never the server\'s words, and opens no popup (#660)', async () => {
  const user = userEvent.setup();
  fetchMock.mockImplementationOnce(async () => reply({ error: 'fatal: cannot remove a locked working tree' }, 500));
  render(<Harness />);
  await confirmDelete(user);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Unexpected error'));
  expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining('fatal'));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
