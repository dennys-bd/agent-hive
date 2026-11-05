import { render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { beforeEach, expect, test } from 'vitest';
import { Flow } from '@/components/Flow';
import { FlowListPanel } from '@/components/FlowListPanel';
import type { Dragging } from '@/components/task-drag';
import { setLanguage } from '@/i18n';
import type { OutOfListing, Stage, State, Task } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork, type WithWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';
import { firstFlow } from './flow-of.js';

// The out-of-listing hint (#576 decision 8): ◌ and the reason with its tooltip, and the dashed border, on the flowchart's card and in the list panel.
const STAGE: Stage = { name: 'dev', from: { board: ['Ready'] }, prompt: '/hive-build {url}' };
const task = (id: string, outOfListing?: OutOfListing): WithWork => ({
  item: { itemId: `I${id}`, id, title: `Task ${id}`, body: '', url: '' }, stage: 'dev', boardColumn: 'Ready', auto: true, ...(outOfListing === undefined ? {} : { outOfListing }),
});
const state = (tasks: WithWork[]): State => withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed([STAGE], []), tasks, sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const ALL = state([task('1', 'filter'), task('2', 'project'), task('3', 'listing'), task('4')]);
const card = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-task-id="I${id}"]`)!;
const HINTS: Array<[string, string, string]> = [
  ['1', '◌ fora do filtro', 'não passa mais no filtro da source · segue sincronizando pelo item'],
  ['2', '◌ fora do Project', 'o item saiu do Project · segue sincronizando pelo issue'],
  ['3', '◌ fora da listagem', 'a última leitura não trouxe este item · segue sincronizando pelo item'],
];
function Panel({ state: s }: { state: State }) {
  const drag = useRef<Dragging | undefined>(undefined);
  return <FlowListPanel stage={STAGE} state={s} tasks={s.tasks as Task[]} order={s.tasks} drag={drag} onClose={() => undefined} />;
}
beforeEach(() => setLanguage('pt'));

test('on the flowchart, each reason shows its ◌ line in 12px muted with its tooltip and a dashed border; a task in the listing has neither (#576)', () => {
  render(<Flow state={ALL} flow={firstFlow(ALL)} />);
  for (const [id, text, tip] of HINTS) {
    const line = within(card(id)).getByText(text);
    expect(line).toHaveAttribute('title', tip);
    expect(line).toHaveClass('text-muted-foreground', 'text-xs');
    expect(card(id)).toHaveClass('border-dashed');
  }
  expect(card('4')).not.toHaveClass('border-dashed');
  expect(within(card('4')).queryByText(/^◌/)).not.toBeInTheDocument();
});

test('the stage\'s list panel shows the same hint: it renders the same card (#576)', () => {
  render(<Panel state={ALL} />);
  const panel = screen.getByRole('region', { name: 'dev' });
  for (const [id, text] of HINTS) expect(within(card(id)).getByText(text)).toBeInTheDocument();
  expect(within(panel).getAllByText(/^◌ /)).toHaveLength(3);
});

test('in English: out of the filter, out of the Project, out of the listing (#576)', () => {
  setLanguage('en');
  render(<Flow state={ALL} flow={firstFlow(ALL)} />);
  expect(['1', '2', '3'].map((id) => within(card(id)).getByText(/^◌ /).textContent)).toEqual(['◌ out of the filter', '◌ out of the Project', '◌ out of the listing']);
});
