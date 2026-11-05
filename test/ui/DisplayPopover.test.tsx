import { type BoundFunctions, type queries, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { SourcesNav } from '@/components/FlowSources';
import { displayProps } from '@/components/tasks/DisplayPopover';
import { useDisplayOptions } from '@/hooks/use-flow-view';
import { setLanguage } from '@/i18n';
import { readFlowView } from '@/lib/flow-view';
import { resetViewState } from '@/lib/view-state';
import type { SourceConfig, Task } from '../../src/types';

const source = (name: string): SourceConfig => ({ name, qualifyId: false, type: 'github', owner: 'acme', number: 6, filter: [], taskProps: { defaults: { workspace: 'hive', auto: true, entry: { flow: 'main' } }, rules: [] }, epics: 'show', epicFollows: 'aheadThenBehind', switchAt: 'fila' });
const NAV: SourcesNav = { sources: [source('roadmap'), source('site')], auth: 'cli' };
const task = (id: string, from?: string): Task => ({ item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '', ...(from === undefined ? {} : { source: from }) }, stage: 'dev', boardColumn: 'Ready', auto: true });
const TASKS = [task('1', 'roadmap'), task('2', 'roadmap'), task('3'), task('4', 'gone')]; // #3 is the Hive's own; gone is no configured source

// A task view as Center wires it (#574): the one display value, the legend and exibir
function Harness({ hasLoops = true }: { hasLoops?: boolean }) {
  const display = useDisplayOptions();
  const { legend, display: popover } = displayProps({ display, sources: NAV, tasks: TASKS, isTree: display.options.tree ?? false, hasLoops });
  return <><p data-testid="legend">{legend}</p>{popover}</>;
}
type Scope = BoundFunctions<typeof queries>;
const legend = (): string | null => screen.getByTestId('legend').textContent;
const open = async (user: ReturnType<typeof userEvent.setup>, button = 'exibir'): Promise<Scope> => {
  await user.click(screen.getByRole('button', { name: button }));
  return within(screen.getByRole('dialog'));
};
const group = (pop: Scope, name: string): HTMLElement => pop.getByRole('radiogroup', { name });
const choice = (pop: Scope, row: string, name: string): HTMLElement => within(group(pop, row)).getByRole('radio', { name });
const names = (pop: Scope, row: string): (string | null)[] => within(group(pop, row)).getAllByRole('radio').map((r) => r.textContent);
beforeEach(() => { setLanguage('pt'); resetViewState(); });
afterEach(() => resetViewState());

test('exibir opens the three sections with the handoff\'s labels, each row showing the hint of its choice (#574)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByRole('button', { name: 'exibir' })).toHaveAttribute('title', 'como mostrar as tarefas');
  const pop = await open(user);
  expect(pop.getByText('sources')).toBeInTheDocument();
  expect(names(pop, 'voltas')).toEqual(['todas', 'só internas', 'nenhuma']);
  expect(names(pop, 'rótulos das voltas')).toEqual(['todos', 'só externas', 'nenhum']);
  expect(names(pop, 'esconder epics')).toEqual(['nenhum', 'intermediários', 'todos']);
  expect(choice(pop, 'voltas', 'todas')).toHaveAttribute('aria-checked', 'true');
  expect(pop.getByRole('switch', { name: '⑂ agrupar a árvore na etapa' })).toHaveAttribute('aria-checked', 'false');
  expect(pop.getByText('internas ligam etapas vizinhas; externas passam por cima de outras etapas.')).toBeInTheDocument();
  expect(pop.getByText('terminou · 3x, falhou · 3x, reprovou · 3x, feedback')).toBeInTheDocument();
  expect(pop.getByText('epics aparecem como cards nas etapas.')).toBeInTheDocument();
  await user.click(choice(pop, 'voltas', 'só internas'));
  expect(pop.getByText('só as voltas entre etapas vizinhas. sem externas e sem feedback.')).toBeInTheDocument();
  await user.click(choice(pop, 'voltas', 'nenhuma'));
  expect(pop.getByText('nenhuma seta: só as etapas.')).toBeInTheDocument();
  await user.click(choice(pop, 'esconder epics', 'intermediários'));
  expect(pop.getByText('fica só o epic raiz. os do meio somem da vista e continuam no fluxo.')).toBeInTheDocument();
  await user.click(choice(pop, 'esconder epics', 'todos'));
  expect(pop.getByText('nenhum epic na vista. continuam no fluxo e as filhas seguem nas etapas.')).toBeInTheDocument();
  expect(readFlowView()).toMatchObject({ loops: 'none', epics: 'all' });
});

test('a row per source, hive first with no second line, counting the view\'s tasks; unchecking writes sourcesOff and the legend follows; todas clears it (#574)', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(legend()).toBe('todas as sources');
  const pop = await open(user);
  const row = (name: string): HTMLElement => pop.getByRole('checkbox', { name }).closest('label')!;
  expect(pop.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['hive', 'roadmap', 'site']);
  expect(row('hive')).toHaveTextContent(/^hive1$/);
  expect(row('roadmap')).toHaveTextContent('roadmapacme · github project2');
  expect(row('site')).toHaveTextContent('siteacme · github project0');
  expect(pop.queryByRole('button', { name: 'todas' })).not.toBeInTheDocument();
  await user.click(pop.getByRole('checkbox', { name: 'site' }));
  expect(readFlowView().sourcesOff).toEqual(['site']);
  expect(legend()).toBe('hive · roadmap');
  expect(row('site')).toHaveTextContent(/0$/); // counted before sourcesOff
  await user.click(pop.getByRole('checkbox', { name: 'hive' }));
  await user.click(pop.getByRole('checkbox', { name: 'roadmap' }));
  expect(legend()).toBe('nenhuma source');
  await user.click(pop.getByRole('button', { name: 'todas' }));
  expect(readFlowView().sourcesOff).toEqual([]);
  expect(legend()).toBe('todas as sources');
  expect(pop.getAllByRole<HTMLInputElement>('checkbox').every((c) => c.checked)).toBe(true);
});

test('a name in sourcesOff that matches no source is ignored by the legend and kept in the store (#574)', async () => {
  resetViewState({ flowView: { sourcesOff: ['gone'] } });
  const user = userEvent.setup();
  render(<Harness />);
  expect(legend()).toBe('todas as sources');
  const pop = await open(user);
  expect(pop.queryByRole('button', { name: 'todas' })).not.toBeInTheDocument();
  await user.click(pop.getByRole('checkbox', { name: 'site' }));
  expect(readFlowView().sourcesOff).toEqual(['gone', 'site']);
  expect(legend()).toBe('hive · roadmap');
});

test('rótulos das voltas is dimmed and still clickable while voltas is nenhuma; without hasLoops both rows are absent (#574)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Harness />);
  let pop = await open(user);
  const labels = (): HTMLElement => group(pop, 'rótulos das voltas').parentElement!;
  expect(labels()).not.toHaveClass('opacity-50');
  await user.click(choice(pop, 'voltas', 'nenhuma'));
  expect(labels()).toHaveClass('opacity-50');
  await user.click(choice(pop, 'rótulos das voltas', 'só externas'));
  expect(readFlowView().labels).toBe('outer');
  unmount();
  render(<Harness hasLoops={false} />);
  pop = await open(user);
  expect(pop.queryByRole('radiogroup', { name: 'voltas' })).not.toBeInTheDocument();
  expect(pop.queryByRole('radiogroup', { name: 'rótulos das voltas' })).not.toBeInTheDocument();
  expect(group(pop, 'esconder epics')).toBeInTheDocument();
});

test('every choice survives a re-read of the view state, the reload case (#574)', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<Harness />);
  let pop = await open(user);
  await user.click(choice(pop, 'voltas', 'só internas'));
  await user.click(choice(pop, 'rótulos das voltas', 'nenhum'));
  await user.click(choice(pop, 'esconder epics', 'todos'));
  await user.click(pop.getByRole('switch', { name: '⑂ agrupar a árvore na etapa' }));
  await user.click(pop.getByRole('checkbox', { name: 'roadmap' }));
  unmount();
  render(<Harness />);
  expect(legend()).toBe('hive · site');
  pop = await open(user);
  expect(choice(pop, 'voltas', 'só internas')).toHaveAttribute('aria-checked', 'true');
  expect(choice(pop, 'rótulos das voltas', 'nenhum')).toHaveAttribute('aria-checked', 'true');
  expect(choice(pop, 'esconder epics', 'todos')).toHaveAttribute('aria-checked', 'true');
  expect(pop.getByRole('switch', { name: '⑂ agrupar a árvore na etapa' })).toHaveAttribute('aria-checked', 'true');
  expect(pop.getByRole('checkbox', { name: 'roadmap' })).not.toBeChecked();
});

test('in English: display, loops, loop labels, hide epics, the switch and the legend (#574)', async () => {
  setLanguage('en');
  const user = userEvent.setup();
  render(<Harness />);
  expect(legend()).toBe('all sources');
  const pop = await open(user, 'display');
  expect(names(pop, 'loops')).toEqual(['all', 'inner only', 'none']);
  expect(names(pop, 'loop labels')).toEqual(['all', 'outer only', 'none']);
  expect(names(pop, 'hide epics')).toEqual(['none', 'middle', 'all']);
  expect(pop.getByRole('switch', { name: '⑂ group the tree in the stage' })).toBeInTheDocument();
  await user.click(pop.getByRole('checkbox', { name: 'hive' }));
  await user.click(pop.getByRole('checkbox', { name: 'roadmap' }));
  await user.click(pop.getByRole('checkbox', { name: 'site' }));
  expect(legend()).toBe('no source');
  expect(pop.getByRole('button', { name: 'all' })).toBeInTheDocument();
});
