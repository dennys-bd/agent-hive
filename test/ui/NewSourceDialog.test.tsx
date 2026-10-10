import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewSourceDialog } from '@/components/settings/NewSourceDialog';
import { setLanguage, t } from '@/i18n';

beforeEach(() => setLanguage('pt'));
afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const PROJECTS = [{ number: 7, title: 'agent-hive', url: '' }, { number: 8, title: 'site', url: '' }];

function stubFetch(handler = async (_url: string) => jsonResponse(PROJECTS)): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const dialog = () => screen.getByRole('dialog', { name: t('newSource.title') });
const pick = async (user: ReturnType<typeof userEvent.setup>, option: string): Promise<void> => {
  await user.click(screen.getByLabelText(t('settings.project')));
  await user.click(await screen.findByRole('option', { name: option }));
};

test('the fields and the description (#514)', () => {
  stubFetch();
  render(<NewSourceDialog open auth="cli" workspaces={['hive', 'site']} takenNames={[]} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

  expect(within(dialog()).getByText(t('newSource.description'))).toBeInTheDocument();
  const radios = screen.getAllByRole('radio');
  expect(radios).toHaveLength(1);
  expect(radios[0]).toHaveAccessibleName('GitHub Project');
  expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByLabelText(t('settings.owner'))).toHaveValue('@me');
  expect(screen.getByLabelText(t('settings.project'))).toHaveTextContent(t('settings.projectPlaceholder'));
  expect(screen.getByText(t('newSource.nameHint'))).toBeInTheDocument();
  expect(screen.getByText(t('newSource.workspaceHint'))).toBeInTheDocument();
  expect(screen.getByLabelText(t('newSource.workspace'))).toHaveTextContent('hive');
});

test('carregar lists the owner\'s projects, the pick prefills the name until it is typed (#514)', async () => {
  const user = userEvent.setup();
  const fetchMock = stubFetch();
  render(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={[]} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: t('settings.load') }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/settings/projects?owner=%40me&auth=cli'));

  await pick(user, '#7 agent-hive');
  expect(screen.getByLabelText(t('newSource.name'))).toHaveValue('agent-hive');

  await user.clear(screen.getByLabelText(t('newSource.name')));
  await user.type(screen.getByLabelText(t('newSource.name')), 'typed');
  await pick(user, '#8 site');
  expect(screen.getByLabelText(t('newSource.name'))).toHaveValue('typed');
});

test('adicionar source validates and hands over the row (#514)', async () => {
  const user = userEvent.setup();
  stubFetch();
  const onAdd = vi.fn();
  const { rerender } = render(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={[]} onOpenChange={vi.fn()} onAdd={onAdd} />);

  await user.click(screen.getByRole('button', { name: t('newSource.add') }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('settings.error.project'));
  expect(onAdd).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: t('settings.load') }));
  await pick(user, '#7 agent-hive');
  rerender(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={['agent-hive']} onOpenChange={vi.fn()} onAdd={onAdd} />);
  await user.click(screen.getByRole('button', { name: t('newSource.add') }));
  expect(await screen.findByRole('alert')).toHaveTextContent(t('settings.error.sourceDuplicate', { name: 'agent-hive' }));
  expect(onAdd).not.toHaveBeenCalled();

  rerender(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={[]} onOpenChange={vi.fn()} onAdd={onAdd} />);
  await user.clear(screen.getByLabelText(t('newSource.name')));
  await user.type(screen.getByLabelText(t('newSource.name')), 'hive2');
  await user.click(screen.getByRole('button', { name: t('newSource.add') }));

  expect(onAdd).toHaveBeenCalledWith({
    source: expect.objectContaining({ type: 'github', owner: '@me', number: '7', name: 'hive2', taskProps: { defaults: { workspace: 'hive', auto: true }, rules: [] } }),
    projects: PROJECTS,
  });
});

test('a failing carregar shows the server\'s message, and the dialog stays open (#514)', async () => {
  const user = userEvent.setup();
  stubFetch(async () => jsonResponse({ error: 'no token' }, 500));
  render(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={[]} onOpenChange={vi.fn()} onAdd={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: t('settings.load') }));

  expect(await screen.findByRole('alert')).toHaveTextContent('no token');
  expect(dialog()).toBeInTheDocument();
});

test('nova source: its copy, the fields fill their width and the description matches the field hints (#528)', () => {
  stubFetch();
  render(<NewSourceDialog open auth="cli" workspaces={['hive', 'site']} takenNames={[]} onOpenChange={vi.fn()} onAdd={vi.fn()} />);
  expect(screen.getByRole('dialog', { name: 'nova source' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'adicionar source' })).toBeInTheDocument();
  expect(screen.getByText(t('newSource.description'))).toHaveTextContent('de onde vêm as tarefas. filtros, workspace dinâmico e etapas ficam para depois, em configuração › fluxo.');
  expect(screen.getByText(t('newSource.description'))).toHaveClass('text-xs');
  for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveClass('flex-1');
  expect(screen.getByLabelText(t('settings.project'))).toHaveClass('w-full');
  expect(screen.getByLabelText(t('newSource.workspace'))).toHaveClass('w-full');
});

test('a source named hive shows the name error: the flow sidebar\'s row for the Hive\'s own tasks owns that name (#665)', async () => {
  const user = userEvent.setup();
  stubFetch();
  const onAdd = vi.fn();
  render(<NewSourceDialog open auth="cli" workspaces={['hive']} takenNames={[]} onOpenChange={vi.fn()} onAdd={onAdd} />);

  await user.click(screen.getByRole('button', { name: t('settings.load') }));
  await pick(user, '#7 agent-hive');
  await user.clear(screen.getByLabelText(t('newSource.name')));
  await user.type(screen.getByLabelText(t('newSource.name')), 'hive');
  await user.click(screen.getByRole('button', { name: t('newSource.add') }));

  expect(await screen.findByRole('alert')).toHaveTextContent(t('newSource.error.name'));
  expect(onAdd).not.toHaveBeenCalled();
});
