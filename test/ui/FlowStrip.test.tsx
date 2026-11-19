import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { STRIP_WIDTH } from '@/components/FlowChart';
import { FlowStrip, type StripSegment } from '@/components/FlowStrip';
import type { Dragging } from '@/components/task-drag';
import { setLanguage } from '@/i18n';
import type { Stage, State } from '../../src/types';
import { APPROVAL_MINUTES_DEFAULT, SIGNALS_DEFAULTS, RATE_LIMIT_WAIT_DEFAULT, DELETE_ACTIVITY_DEFAULTS, SHUTDOWN_IDLE_DEFAULT } from '../../src/types';
import { withPointedWork } from '../fixtures/work';
import { flowed } from '../fixtures/main-flow.js';

// A strip of two empty stages (#914): its segments, their ⋯ and their drop
const STAGES: Stage[] = [{ name: 'repro', from: {} }, { name: 'fix', from: {} }];
const STATE: State = withPointedWork({
  signal: 'green', signals: SIGNALS_DEFAULTS, maxConcurrent: 1, workers: [], terminals: [], ...flowed(STAGES, []), tasks: [], sourceOrder: [], localCount: 0, benchmark: { experiments: [] }, semaphores: {}, activities: [], activityRecords: [], usage: [], budget: {}, usageRules: [], disabledRules: [],
  workspaces: ['hive'], sourceWorkspaces: {}, workspaceColors: {}, commands: {}, syncs: {}, deleteActivity: DELETE_ACTIVITY_DEFAULTS, shutdownIdleMinutes: SHUTDOWN_IDLE_DEFAULT, approvalMinutes: APPROVAL_MINUTES_DEFAULT, rateLimitWaitMinutes: RATE_LIMIT_WAIT_DEFAULT,
});
const listed = vi.fn();
const segmentOf = (stage: Stage): StripSegment => ({ stage, order: [], count: 0, rules: [], onFilter: () => {}, onClearFilter: () => {}, onList: () => listed(stage.name) });
function Strip({ dragging, maxHeight = 240 }: { dragging?: Dragging; maxHeight?: number }) {
  const drag = useRef<Dragging | undefined>(dragging);
  return <FlowStrip segments={STAGES.map(segmentOf)} state={STATE} drag={drag} maxHeight={maxHeight} />;
}
const segment = (name: string): HTMLElement => screen.getByRole('group', { name: `${name}, vazia, recolhida` });
// jsdom has no DragEvent: a plain event carrying what the handlers read, as Flow.test.tsx does
const drag = (type: string, el: Element) =>
  fireEvent(el, Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: { getData: () => 'I9' }, relatedTarget: null }));
const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
beforeEach(() => { setLanguage('pt'); listed.mockClear(); fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

test('a strip is STRIP_WIDTH wide and STRIP_HEIGHT tall under maxHeight; each segment reads its count, its name written down and its ⋯, with its tooltip, split by a dashed border (#914)', () => {
  const { container, unmount } = render(<Strip />);
  const strip = container.querySelector<HTMLElement>('[data-strip]')!;
  expect([strip.style.width, strip.style.height]).toEqual([`${STRIP_WIDTH}px`, '240px']);
  expect([...strip.querySelectorAll('[data-segment]')].map((s) => s.getAttribute('data-segment'))).toEqual(['repro', 'fix']);
  for (const name of ['repro', 'fix']) {
    expect(within(segment(name)).getByText('0')).toHaveClass('tabular-nums');
    expect(within(segment(name)).getByText(name)).toHaveClass('truncate', '[writing-mode:vertical-rl]');
    expect(within(segment(name)).getByRole('button', { name: 'ações da etapa' })).toBeInTheDocument();
    expect(segment(name)).toHaveAttribute('title', `${name} · vazia · abre quando uma tarefa entrar`);
    expect(segment(name)).toHaveClass('text-muted-foreground');
  }
  expect([segment('repro'), segment('fix')].map((s) => s.classList.contains('border-dashed'))).toEqual([false, true]);
  unmount();
  const tall = render(<Strip maxHeight={800} />);
  expect(tall.container.querySelector<HTMLElement>('[data-strip]')!.style.height).toBe('300px');
});

test('a segment\'s ⋯ is the stage menu, with lista › first, which opens that stage\'s list panel (#914)', async () => {
  const user = userEvent.setup();
  render(<Strip />);
  await user.click(within(segment('fix')).getByRole('button', { name: 'ações da etapa' }));
  const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
  expect(items[0]).toBe('lista ›');
  expect(items).toContain('Filtrar…');
  await user.click(screen.getByRole('menuitem', { name: 'lista ›' }));
  expect(listed).toHaveBeenCalledWith('fix');
});

test('a card that may change stage, dragged over a segment, marks that segment alone with mover para <stage>; leaving clears it (#914)', () => {
  render(<Strip dragging={{ id: 'I9', stage: 'dev', movable: true }} />);
  drag('dragover', segment('fix'));
  expect(segment('fix')).toHaveAttribute('data-drop', 'over');
  expect(segment('repro')).not.toHaveAttribute('data-drop');
  expect(within(segment('fix')).getByText('mover para fix')).toBeInTheDocument();
  drag('dragleave', segment('fix'));
  expect(segment('fix')).not.toHaveAttribute('data-drop');
  expect(screen.queryByText('mover para fix')).not.toBeInTheDocument();
});

test('a card canMoveToStage refuses marks no segment (#366, #914)', () => {
  render(<Strip dragging={{ id: 'I9', stage: 'dev', movable: false }} />);
  drag('dragover', segment('fix'));
  expect(segment('fix')).not.toHaveAttribute('data-drop');
});

test('a drop on a segment moves the task to the end of that segment\'s stage and clears the mark (#366, #914)', () => {
  render(<Strip dragging={{ id: 'I9', stage: 'dev', movable: true }} />);
  drag('dragover', segment('repro'));
  drag('drop', segment('repro'));
  expect(fetchMock).toHaveBeenLastCalledWith('/tasks/I9/move-to', expect.objectContaining({ method: 'POST', body: JSON.stringify({ stage: 'repro', drop: {} }) }));
  expect(segment('repro')).not.toHaveAttribute('data-drop');
});
