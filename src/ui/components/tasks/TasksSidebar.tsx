import { Fragment, type ReactNode, useState } from 'react';
import type { EffectiveLimits, State } from '../../../types.js';
import { FlowRepositories } from '@/components/FlowRepositories';
import { FlowSources, type SourcesNav } from '@/components/FlowSources';
import { SignalToggle } from '@/components/SignalToggle';
import { WorkerCap } from '@/components/WorkerCap';
import { displaySources } from '@/components/tasks/DisplayPopover';
import { TasksEntries } from '@/components/tasks/TasksEntries';
import { ResizeHandle, SectionAdd, TasksSection } from '@/components/tasks/TasksSection';
import type { DisplayControls } from '@/hooks/use-flow-view';
import { centerOfRepo, type TasksNav } from '@/hooks/use-tasks-center';
import { t } from '@/i18n';
import { SECTIONS, type SidebarSection, type TasksSidebarView, lastOpen, readTasksSidebar, withResize, withToggle, writeTasksSidebar } from '@/lib/tasks-sidebar';

export interface TasksSidebarProps {
  state: State; effective?: EffectiveLimits; sources: SourcesNav;
  nav: Pick<TasksNav, 'center' | 'show'>; // decision 11: one selection across the sections, read from the resolved center
  display: DisplayControls; // decision 17: the Dashboard's one owner of flowView's display fields, for mostrar só esta
  onNewFlow?(): void; // #565: Settings landing on a new flow; absent: no +
}

interface SectionContent { title: string; action?: ReactNode; body: ReactNode }

// The four sections' titles, actions and content, in SECTIONS' order (decisions 7, 8, 12, 18)
function sectionsOf({ state, effective, sources, nav, display, onNewFlow }: TasksSidebarProps): Record<SidebarSection, SectionContent> {
  const { center, show } = nav;
  // Decision 16: every other source off, hive included while it is on, by the popover's own list; the center does not change
  const onOnly = (name: string): void => display.set({ sourcesOff: displaySources(sources, []).map((s) => s.name).filter((n) => n !== name) });
  return {
    automation: { title: t('tasks.sidebar.automation'), body: <div className="flex flex-col gap-[18px] py-1"><SignalToggle signal={state.signal} signals={state.signals} effective={effective} /><WorkerCap state={state} effective={effective} /></div> }, // until 2.4 (decision 7)
    tasks: { title: t('tasks.sidebar.tasks'), action: onNewFlow && <SectionAdd label={t('tasks.sidebar.newFlow')} onClick={onNewFlow} />, body: <TasksEntries state={state} center={center} show={show} /> },
    sources: {
      title: t('tasks.sidebar.sources'), action: sources.onAdd && <SectionAdd label={t('flow.sources.add')} onClick={sources.onAdd} />,
      body: <FlowSources nav={sources} tasks={state.tasks} selected={center.kind === 'source' ? center.source : undefined} onPick={(source) => show({ kind: 'source', source })} onList={() => show({ kind: 'tasks', view: 'list' })} onOnly={onOnly} />,
    },
    repos: { title: t('repos.title'), action: <span className="text-muted-foreground">{t('repos.prs')}</span>, body: <FlowRepositories selected={center.kind === 'repo' ? center.repository : undefined} onPick={(repository) => show(centerOfRepo(repository))} /> },
  };
}

// The layout as stored (decision 5): a toggle writes at once; a drag listens on window so it keeps going past the handle, and writes once, on
// mouseup (decision 4). ponytail: a drag cut short by an unmount leaves its two listeners until the next mouseup, which then writes the layout
function useSidebarView(): { view: TasksSidebarView; toggle(section: SidebarSection): void; startDrag(section: SidebarSection, event: Pick<MouseEvent, 'clientY' | 'preventDefault'>): void } {
  const [view, setView] = useState(readTasksSidebar);
  const toggle = (section: SidebarSection): void => {
    const next = withToggle(view, section);
    setView(next);
    writeTasksSidebar(next);
  };
  const startDrag = (section: SidebarSection, event: Pick<MouseEvent, 'clientY' | 'preventDefault'>): void => {
    event.preventDefault(); // no text selection while dragging
    const from = { y: event.clientY, height: view.heights[section] };
    let dragged = view;
    const onMove = (move: MouseEvent): void => {
      dragged = withResize(view, section, from.height + move.clientY - from.y);
      setView(dragged);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      writeTasksSidebar(dragged);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return { view, toggle, startDrag };
}

/** The tasks sidebar (#572, handoff §4): automação, tarefas, sources, repositórios, in that order whatever is closed (decision 3). An open
 * section keeps its height, the last open one takes the rest, so the closed ones after it sit at the foot. A handle follows every open section
 * but the last one. */
export function TasksSidebar(props: TasksSidebarProps) {
  const { view, toggle, startDrag } = useSidebarView();
  const sections = sectionsOf(props);
  const last = lastOpen(view);
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-1.5 pb-2">
      {SECTIONS.map((id) => {
        const { title, action, body } = sections[id];
        const isOpen = !view.closed[id];
        return (
          <Fragment key={id}>
            <TasksSection id={id} title={title} action={action} isOpen={isOpen} height={id === last ? undefined : view.heights[id]} onToggle={() => toggle(id)}>{body}</TasksSection>
            {isOpen && id !== last && <ResizeHandle name={title} onMouseDown={(event) => startDrag(id, event)} />}
          </Fragment>
        );
      })}
    </div>
  );
}
