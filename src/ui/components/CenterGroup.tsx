import { XIcon } from 'lucide-react';
import { type CSSProperties, type MouseEvent, useState, useSyncExternalStore } from 'react';
import type { CenterDrag, Landing } from '@/components/center-drag';
import { type ConsoleSelection, ConsolePanel } from '@/components/ConsolePanel';
import { type CloseTabSettings, type ConfirmLoss, forgetRun, noticeInput, noticeOn, showCloseTabNotice, sleepsOnClose, sleepTerminal, stopRun } from '@/components/close-tab-notice';
import { CopyToSub } from '@/components/CopySession';
import { CONTEXT_KIT } from '@/components/menu-kit';
import type { LiveRun } from '../../task-runs';
import { taskLabel } from '../../tasks';
import { DesignPane } from '@/components/DesignPane';
import { EditorPane } from '@/components/EditorPane';
import { UntitledPane } from '@/components/UntitledPane';
import { PreviewPane } from '@/components/PreviewPane';
import { ChangesButton } from '@/components/ChangesButton';
import { ChangesPane } from '@/components/ChangesPane';
import { DIFF_SCOPE_KEY, DiffView } from '@/components/DiffView';
import { NewRunButton } from '@/components/NewRunButton';
import { type PaneContext, PaneHeader } from '@/components/PaneHeader';
import { showSleepNotice, sleepInput } from '@/components/sleep-notice';
import { SplitMenu, type SplitOpen } from '@/components/SplitMenu';
import { TerminalSplit } from '@/components/TerminalSplit';
import { diffTab, type OpenRun, tabLabel } from '@/components/terminal-tabs';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { CenterOps } from '@/hooks/use-center-layouts';
import { useConsoleChannelsContext } from '@/hooks/use-console';
import { useFileTone } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { type Activity, activityKey, runStatus, sleepingOf } from '@/lib/activities';
import type { CopySource } from '@/lib/copy-targets';
import { type CenterTabRef, type ConsoleRef, consoleRef, type Edge, refKey, runsOf, type TabGroup } from '@/lib/center-layout';
import { bufferPath } from '@/lib/center-files';
import * as models from '@/lib/editor-models';
import * as fileBase from '@/lib/file-base';
import { STATUS_DOT } from '@/lib/status';

export interface CenterGroupProps {
  group: TabGroup; activity: Activity; groups: TabGroup[]; focused: string; ops: CenterOps; drag: CenterDrag; fileLinks: boolean;
  fontFamily: string; pane: PaneContext; onSplit: SplitOpen; onExit(ptyId: string): void; onWake(ptyId: string): void;
  onClose(item: CenterTabRef): void; // a tab's close, through the unsaved-edits confirm (#717)
}

const baseName = (path: string): string => path.split('/').at(-1) ?? path;
// What an activity's panes read before their own name (#251): its task's label, or its workspace for a local activity (#590)
const activityTitle = (activity: Activity): string => (activity.kind === 'task' ? taskLabel(activity.task) : activity.workspace);

/** A tab's text in its strip (#457, #458): a run's own label (#489: what runs in it, never its kind); a diff's scope; a file's name
 * (#717); Preview and its name (#697); Alterações and its name (#668); console. */
export function refText(item: CenterTabRef, activity: Activity): string {
  if (item.kind === 'diff') return t(DIFF_SCOPE_KEY[item.scope], { n: item.checkpoint ?? '' });
  if (item.kind === 'untitled') return t('editor.untitled', { n: item.n }); // #818
  if (item.kind === 'file' || item.kind === 'design') return baseName(item.path); // #109: a design's tab reads its file's name
  if (item.kind === 'preview') return `${t('preview.title')} ${baseName(item.path)}`;
  if (item.kind === 'changes') return `${t('changes.title')} ${baseName(item.path)}`;
  if (item.kind === 'console') return t('console.title');
  const run = activity.runs.find((r) => r.ptyId === item.ptyId) ?? sleepingOf(activity, item.ptyId)?.run; // a sleeping run keeps its name (#672)
  return run?.label ?? '';
}

// A tab's dot (redesign 04, #536): its run's worker status, the session's; a terminal reports none (#192), and the console is no session. A
// diff's tab has no dot at all (#591)
function dotOf(item: CenterTabRef, activity: Activity): string {
  const status = item.kind === 'run' ? runStatus(activity, item.ptyId) : undefined;
  return STATUS_DOT[status ?? 'empty'];
}

// A file tab's dot (#717): while its buffer holds unsaved edits, in foreground: a state of the tab, never a status colour
function DirtyDot({ activityId, path }: { activityId: string; path: string }) {
  const isDirty = useSyncExternalStore(models.subscribe, () => models.isDirty(activityId, path));
  return isDirty ? <span aria-hidden="true" data-dirty="" className="size-1.5 shrink-0 rounded-full bg-foreground" /> : null;
}

// A tab's dot: a run's or the console's status dot, a file's unsaved edits (#717), none for a diff or a PR
function TabDot({ item, activity }: { item: CenterTabRef; activity: Activity }) {
  const buffer = bufferPath(item);
  if (buffer !== undefined) return <DirtyDot activityId={activity.activity.id} path={buffer} />; // one buffer, two tabs (#668); an untitled one's own (#818)
  if (item.kind !== 'run' && item.kind !== 'console') return null;
  return <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dotOf(item, activity)}`} />;
}

// The drop line in a strip, tab-drag's own (#440) turned on its side: 2px of bg-primary left of the tab the dragged one lands before, or
// after the last tab for the end
const LINE_BEFORE = "before:absolute before:inset-y-0 before:-left-0.5 before:hidden before:w-0.5 before:content-[''] before:bg-primary data-[drop=before]:before:block";
const LINE_END = "after:hidden after:w-0.5 after:self-stretch after:content-[''] after:bg-primary data-[drop=end]:after:block";
// A tab (redesign 04): padded, a border on its right; the shown one on task with a 2px foreground line at its foot
const TAB = 'relative flex items-center gap-1.5 border-r px-3 text-xs';
const SHOWN_TAB = 'bg-card text-foreground shadow-[inset_0_-2px_0_var(--foreground)]';
const MIDDLE_BUTTON = 1; // MouseEvent.button of the wheel button
const RUN_INSET = 'pl-2.5 py-2'; // with PtyTab's own p-1, the handoff's 14px left of the xterm; none on the right, where its own scrollbar decides how close it comes
// The shaded part of a group's body where a drop lands: the half on an edge, the whole body for its middle
const SHADE: Record<Edge | 'middle', CSSProperties> = {
  left: { left: 0, top: 0, bottom: 0, width: '50%' }, right: { right: 0, top: 0, bottom: 0, width: '50%' },
  top: { left: 0, right: 0, top: 0, height: '50%' }, bottom: { left: 0, right: 0, bottom: 0, height: '50%' }, middle: { inset: 0 },
};

function shadeOf(landing: Landing | undefined, group: string): Edge | 'middle' | undefined {
  if (landing === undefined || landing.group !== group || landing.kind === 'strip') return undefined;
  return landing.kind === 'edge' ? landing.edge : 'middle';
}

// A session put to sleep with no tab left (#672): a close under sleep, or the keep notice's dormir. Its transcript goes at once, since no
// tab will show it, and the sleep notice says where it sleeps, under sleepNotice
function sleepUntabbed(run: LiveRun, activity: Activity, settings: CloseTabSettings, openRun?: OpenRun): void {
  const input = sleepInput(activity, [run], 'manual', openRun); // read while the run is live: its session is still known
  void stopRun(run.ptyId).then((isAsleep) => {
    if (!isAsleep) return;
    forgetRun(run.ptyId);
    showSleepNotice(input, settings);
  });
}

// A terminal's close (#696): closeTerminalTab decides, a task's and a local one's alike. sleep: after the agent confirm, with no notice (its
// line says it sleeps); keep: it runs on behind the closed tab, the keep notice under closeTerminalTabNotice, whose dormir asks the same
function closeTerminalRun(run: LiveRun, activity: Activity, settings: CloseTabSettings, confirmLoss: ConfirmLoss, openRun?: OpenRun): void {
  const sleep = (): void => sleepTerminal(run.ptyId, confirmLoss);
  if (sleepsOnClose(run, settings)) sleep();
  else if (noticeOn(run, settings)) showCloseTabNotice(noticeInput(run, activity, settings, sleep, openRun));
}

// A run's close (#452): a terminal follows its own setting (#696). An agent's run sleeps when its kind's select says so, with the sleep notice
// (#672); else its kind's switch shows the keep notice (#614). A sleeping agent's transcript goes with its tab (#672); a sleeping terminal's
// ring stays for its next tab (#696)
function closeRun(ptyId: string, activity: Activity, settings: CloseTabSettings, confirmLoss: ConfirmLoss, openRun?: OpenRun): void {
  const run = activity.runs.find((r) => r.ptyId === ptyId);
  if (run === undefined) { // a run already gone has nothing
    if (sleepingOf(activity, ptyId)?.sessionId !== undefined) forgetRun(ptyId);
    return;
  }
  if (run.kind === 'terminal') {
    closeTerminalRun(run, activity, settings, confirmLoss, openRun);
    return;
  }
  if (sleepsOnClose(run, settings)) {
    sleepUntabbed(run, activity, settings, openRun);
    return;
  }
  if (noticeOn(run, settings)) showCloseTabNotice(noticeInput(run, activity, settings, () => sleepUntabbed(run, activity, settings, openRun), openRun));
}

/** A tab's close (#452, #612): its X, a middle-click, or ⌘W on a tab that is not split. Every run it holds follows the close rule, each pane
 * of a split tab included (#641); a diff, a PR or the console holds none. A file's buffer and its base go with the last tab that shows them,
 * its editor or its changes tab (#717, #668): isShared says the other one is still open. */
export function closeTab(item: CenterTabRef, activity: Activity, ops: CenterOps, settings: CloseTabSettings, confirmLoss: ConfirmLoss, openRun?: OpenRun, isShared = false): void {
  ops.close(refKey(item));
  const buffer = bufferPath(item);
  if (buffer !== undefined && !isShared) {
    models.close(activity.activity.id, buffer);
    fileBase.close(activity.activity.id, buffer);
  }
  for (const ptyId of runsOf(item)) closeRun(ptyId, activity, settings, confirmLoss, openRun);
}

/** ⌘W on a split tab (#641), iTerm's: its focused pane closes, its run by the rule a tab's close follows; the last pane is a tab again. */
export function closePaneOf(ptyId: string, activity: Activity, ops: CenterOps, settings: CloseTabSettings, confirmLoss: ConfirmLoss, openRun?: OpenRun): void {
  ops.closePane(ptyId);
  closeRun(ptyId, activity, settings, confirmLoss, openRun);
}

// What copiar para… copies from an agent's tab (#587): a task's run, or the local session a local activity's run continues (#590)
function copySourceOf(activity: Activity, ptyId: string): CopySource | undefined {
  if (activity.kind === 'task') return { taskId: activity.task.item.itemId, ptyId };
  const kept = activity.kept.find((k) => k.run?.ptyId === ptyId);
  return kept && { activityId: activity.activity.id, sessionId: kept.session.id }; // the local record (#629)
}

interface CenterTabProps { item: CenterTabRef; index: number; group: TabGroup; groups: TabGroup[]; activity: Activity; ops: CenterOps; drag: CenterDrag; onClose(item: CenterTabRef): void; onWake(ptyId: string): void }

// One tab (#458): its dot and text show it, its X or a middle-click closes it (#612), and it drags (center-drag.ts). Right-click: split
// right or down (disabled alone in its group: nothing is left to split from), one move per other group (named by the tab it shows), and Fechar.
function CenterTab({ item, index, group, groups, activity, ops, drag, onClose, onWake }: CenterTabProps) {
  const key = refKey(item);
  const text = refText(item, activity);
  const tone = useFileTone(activity.activity.id, item.kind === 'file' ? item.path : undefined); // #780: a file's diagnostics; infos never colour it
  const isShown = index === group.active;
  const isAlone = group.tabs.length === 1;
  const isAsleep = item.kind === 'run' && item.panes === undefined && sleepingOf(activity, item.ptyId) !== undefined; // its label's click continues it (#672)
  const land = (landing: Landing): void => ops.land(key, landing);
  const close = (): void => onClose(item); // the center asks first over unsaved edits (#717)
  // A middle-click closes as the X does (#612). The mousedown's default would start autoscroll, or on Linux paste the primary selection
  // into the focused terminal; the drag ignores anything but the primary button
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button === MIDDLE_BUTTON) event.preventDefault();
  };
  const onAuxClick = (event: MouseEvent): void => {
    if (event.button === MIDDLE_BUTTON) close();
  };
  const run = item.kind === 'run' ? activity.runs.find((r) => r.ptyId === item.ptyId) : undefined; // an agent's tab offers copiar para… (#587); a terminal's does not
  const source = run !== undefined && run.kind !== 'terminal' ? copySourceOf(activity, run.ptyId) : undefined;
  const drop = drag.landing?.kind === 'strip' && drag.landing.group === group.id && drag.landing.target === key ? 'before' : undefined;
  return (
    <div data-tab-key={key} data-drop={drop} className={`${TAB} ${isShown ? SHOWN_TAB : 'text-muted-foreground'} ${LINE_BEFORE} ${drag.dragged === key ? 'opacity-50' : ''}`}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button" role="tab" aria-selected={isShown} title={'path' in item ? item.path : undefined} className="flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={() => { ops.select(group.id, index); if (isAsleep) onWake(key); }} onMouseDown={onMouseDown} onAuxClick={onAuxClick} {...drag.handlers(key, group.id)}
          >
            <TabDot item={item} activity={activity} />
            <span className={tone}>{text}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem disabled={isAlone} onSelect={() => land({ kind: 'edge', group: group.id, edge: 'right' })}>{t('center.splitRight')}</ContextMenuItem>
          <ContextMenuItem disabled={isAlone} onSelect={() => land({ kind: 'edge', group: group.id, edge: 'bottom' })}>{t('center.splitDown')}</ContextMenuItem>
          {groups.filter((other) => other.id !== group.id).map((other) => (
            <ContextMenuItem key={other.id} onSelect={() => land({ kind: 'middle', group: other.id })}>
              {`${t('center.moveTo')} · ${refText(other.tabs[other.active], activity)}`}
            </ContextMenuItem>
          ))}
          {source && <CopyToSub source={source} kit={CONTEXT_KIT} separated />}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={close}>{t('center.close')}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <Button type="button" size="icon-xs" variant="ghost" className="size-4" aria-label={`${t('center.close')} ${text}`} onClick={close}><XIcon /></Button>
    </div>
  );
}

interface TabBodyProps { item: CenterTabRef; activity: Activity; active: boolean; fileLinks: boolean; fontFamily: string; ops: CenterOps; onExit(ptyId: string): void; onWake(ptyId: string): void }

// The console as a grid tab (redesign 05): the drawer's console without its abrir como aba and esc; hidden, not unmounted, behind another tab.
// Its channel is its own (#755), in its tab ref and saved with the layout: a pick retargets the ref, the drawer's selection is never touched;
// the run it picks stays local. A locked tab (a commands stage's) shows its one channel with no select
function ConsoleTab({ item, active, fontFamily, ops }: { item: ConsoleRef; active: boolean; fontFamily: string; ops: CenterOps }) {
  const channels = useConsoleChannelsContext();
  const [run, setRun] = useState<string>();
  if (channels === undefined) return null; // outside a Dashboard: no console to show
  const selection: ConsoleSelection | undefined = item.channel === undefined ? undefined : { channel: item.channel, ...(run === undefined ? {} : { ptyId: run }) };
  const select = (picked: ConsoleSelection): void => {
    setRun(picked.ptyId);
    if (picked.channel !== item.channel) ops.retarget(refKey(item), consoleRef(picked.channel, item.locked === true, item.run));
  };
  return (
    <div style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none' }} className="flex min-h-0 min-w-0 overflow-hidden">
      <ConsolePanel
        channels={channels.channels} selection={selection} stamp={channels.stamp} fontFamily={fontFamily}
        onSelect={select} onStale={channels.refresh} locked={item.locked === true} run={item.run}
      />
    </div>
  );
}

// A tab's view (#457, #458): a run's terminal or its split's panes (#641), kept mounted while another tab shows, a task's diff (#270), a file's
// editor pane (#717) or the console (redesign 05)
function TabBody({ item, activity, active, fileLinks, fontFamily, ops, onExit, onWake }: TabBodyProps) {
  if (item.kind === 'console') return <ConsoleTab item={item} active={active} fontFamily={fontFamily} ops={ops} />;
  if (item.kind === 'diff') {
    if (activity.kind === 'local') return null; // a local activity has no stage or worktree to diff (#590)
    const tab = diffTab(activity.task, item.scope, item.checkpoint);
    return <DiffView tab={tab} label={tabLabel(tab)} active={active} activity={activity} onScope={(scope, checkpoint) => ops.retarget(refKey(item), { kind: 'diff', scope, ...(checkpoint === undefined ? {} : { checkpoint }) })} />;
  }
  if (item.kind === 'file') {
    return <EditorPane activityId={activity.activity.id} path={item.path} label={`${activityTitle(activity)} · ${baseName(item.path)}`} active={active} fontFamily={fontFamily} workspace={activity.activity.workspace} openKey={activityKey(activity)} />;
  }
  if (item.kind === 'design') return <DesignPane activity={activity} path={item.path} label={t('design.tab', { label: activityTitle(activity), name: baseName(item.path) })} active={active} />;
  if (item.kind === 'preview') {
    return <PreviewPane activity={activity} path={item.path} label={t('preview.tab', { label: activityTitle(activity), name: baseName(item.path) })} active={active} />;
  }
  if (item.kind === 'changes') {
    return <ChangesPane activity={activity} path={item.path} label={`${activityTitle(activity)} · ${refText(item, activity)}`} active={active} fontFamily={fontFamily} />;
  }
  if (item.kind === 'untitled') {
    return <UntitledPane activityId={activity.activity.id} n={item.n} active={active} fontFamily={fontFamily} onSaved={(path) => ops.retarget(refKey(item), { kind: 'file', path })} />;
  }
  return <TerminalSplit item={item} activity={activity} active={active} fileLinks={fileLinks} fontFamily={fontFamily} ops={ops} onExit={onExit} onWake={onWake} />;
}

/** One group of the center (#458), VS Code's editor group and the handoff's pane (#536): its 34px tab strip with the + right after the tabs and dividir ⌄ at its right end,
 * its header, then every tab's view with only the shown one visible. A pointer down anywhere in it (capture phase, so a terminal's own
 * handlers cannot hide it) focuses it, and the next open lands here. The whole strip row is the drag's strip. */
export function CenterGroup({ group, activity, groups, focused, ops, drag, fileLinks, fontFamily, pane, onSplit, onExit, onWake, onClose }: CenterGroupProps) {
  const shade = shadeOf(drag.landing, group.id);
  const isEnd = drag.landing?.kind === 'strip' && drag.landing.group === group.id && drag.landing.target === 'end';
  const shown = group.tabs[group.active];
  // The header describes what the keys act on (#641): a split tab's focused pane
  // a console tab has none: its panel's own line is its header (#755); nor a file tab: the editor's bar names its path (#850)
  const headed: CenterTabRef | undefined = shown?.kind === 'run' && shown.panes !== undefined ? { kind: 'run', ptyId: shown.panes.focused } : shown?.kind === 'console' || shown?.kind === 'file' ? undefined : shown;
  const focus = (): void => {
    if (focused !== group.id) ops.select(group.id, group.active);
  };
  return (
    <section data-center-group={group.id} data-focused={focused === group.id ? 'true' : undefined} onPointerDownCapture={focus} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div data-center-strip className="flex h-[34px] shrink-0 items-stretch border-b">
        <div role="tablist" aria-label={t('terminal.panel.tabs')} aria-orientation="horizontal" data-drop={isEnd ? 'end' : undefined} className={`flex min-w-0 items-stretch ${LINE_END}`}>
          {group.tabs.map((item, index) => <CenterTab key={refKey(item)} item={item} index={index} group={group} groups={groups} activity={activity} ops={ops} drag={drag} onClose={onClose} onWake={onWake} />)}
        </div>
        {/* Beside the tablist, never in it: ARIA allows only tabs there, as DockGroup keeps its actions (#491). Right after the tabs
            (redesign 04); a click focuses this group first, so the run it opens lands here */}
        <div className="flex shrink-0 items-stretch"><NewRunButton activity={activity} onNewFile={() => ops.open({ kind: 'untitled', n: models.nextUntitled() })} /></div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 px-1"><ChangesButton activity={activity} group={group} /><SplitMenu activity={activity} group={group} onSplit={onSplit} /></div>
      </div>
      {headed && <PaneHeader item={headed} label={refText(headed, activity)} activity={activity} context={pane} />}
      <div data-center-body className={`relative flex min-h-0 min-w-0 flex-1 flex-row ${shown?.kind === 'run' ? RUN_INSET : ''}`}>
        {group.tabs.map((item, index) => (
          <TabBody key={refKey(item)} item={item} activity={activity} active={index === group.active} fileLinks={fileLinks} fontFamily={fontFamily} ops={ops} onExit={onExit} onWake={onWake} />
        ))}
        {shade && <div aria-hidden data-drop-edge={shade} style={SHADE[shade]} className="pointer-events-none absolute bg-primary/20" />}
      </div>
    </section>
  );
}
