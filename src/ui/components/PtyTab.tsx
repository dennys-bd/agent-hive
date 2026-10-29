import { createContext, type RefObject, useContext, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { LinkConfirm } from '@/components/LinkConfirm';
import { TerminalFind, useFindBar } from '@/components/TerminalFind';
import { type OpenFile, type RunTab, useOpenFile } from '@/components/terminal-tabs';
import { t } from '@/i18n';
import { localKey } from '@/lib/activities';
import type { FileAt } from '@/lib/editor-models';
import { connectPty } from '@/lib/pty-stream';
import { linkHandler, openLink } from '@/lib/trusted-links';
import { followTheme, linkFiles, linkTaskRefs, loadSearch, openRefUrl, terminalCopy, terminalKeys, terminalPaste, trackTerminal } from '@/lib/xterm-setup';

// activityId: the activity the run is in (#629), what its task references post open-ref for. active: its tab is shown. focused: of a split tab's
// panes (#641), the one that takes the keyboard; a tab alone always does. isAsleep (#672): the run ended with its session kept; its tail shows
// dimmed and read-only, and onWake continues it
interface PtyTabProps {
  tab: RunTab; activityId?: string; label: string; active: boolean; focused?: boolean; fileLinks: boolean; fontFamily: string; onExit(ptyId: string): void;
  isAsleep?: boolean; onWake?(): void;
}
interface OpenTerminal { xterm: Terminal; fit: FitAddon; host: HTMLElement; postSize(): void }
type FitView = Pick<OpenTerminal, 'fit' | 'host'>;

// A collapsed terminal (a tab behind another, or the whole panel closed) is 0 wide or 0 tall, and the FitAddon clamps that to a 2x1 grid
// that connectPty would post to the pty (#390): the run would redraw for 2 columns. Skipped, the pty keeps its last real size, and the
// observer's resize when the terminal shows again fits it then. The console's view fits the same way (#353). Answers whether it fit (#808).
export function fitShown({ fit, host }: FitView): boolean {
  const isShown = host.clientWidth > 0 && host.clientHeight > 0;
  if (isShown) fit.fit();
  return isShown;
}

/** Fits the view on every resize of its host while it shows (#390). The first fit that finds it shown also posts its grid (#808), even one
 * the fit left as it was: xterm's 80x24 against a wider pty. A later fit posts only through connectPty's onResize, when the grid changes. */
export function fitOnResize(view: FitView, postSize: () => void): ResizeObserver {
  let hasPosted = false;
  const observer = new ResizeObserver(() => {
    if (!fitShown(view) || hasPosted) return;
    hasPosted = true;
    postSize();
  });
  observer.observe(view.host);
  return observer;
}

// A sleeping run's pane (#672), as the user's design draws it: the transcript at .45, its colours grey too
const SLEEPING_OPACITY = 0.45;

/** What a tab's task references need from the flow (#588): the prefixes a PREFIX-N may use, and what opens a task's panel. */
export interface TaskRefs { prefixes: readonly string[]; openTask(taskId: string): void }

// Outside App (a test's render, a harness) `#N` still links, and a click opens nothing in the Hive
export const TaskRefContext = createContext<TaskRefs>({ prefixes: [], openTask: () => {} });

// The flow's latest prefixes and opener (#588), read at each row and click: a Settings save reaches the open terminals without recreating
// them, as the font does (#376)
function useTaskRefs(): RefObject<TaskRefs> {
  const taskRefs = useContext(TaskRefContext);
  const refs = useRef(taskRefs);
  useEffect(() => {
    refs.current = taskRefs;
  }, [taskRefs]);
  return refs;
}

// The dock's latest file opener (#717), read at each click: it is a new function on every render, and a new one must never recreate the xterm
function useFileOpenerRef(): RefObject<OpenFile | undefined> {
  const openFile = useOpenFile();
  const ref = useRef(openFile);
  useEffect(() => {
    ref.current = openFile;
  }, [openFile]);
  return ref;
}

const atOf = (line?: number, col?: number): FileAt | undefined => (line === undefined ? undefined : { line, ...(col === undefined ? {} : { col }) });

/** One tab's xterm over its run's pty (#251), through connectPty (the stream, the keys, the sizes). It stays
 * mounted and hidden while another tab shows, so its stream and screen survive a switch. The stream's exit, or a route that no longer knows
 * the run, closes the tab. A link to an untrusted host waits in LinkConfirm (#404).
 * The find binding opens the tab's own find bar (#12), which keeps its query while the tab is hidden. */
export function PtyTab({ tab, activityId, label, active, focused = true, fileLinks, fontFamily, onExit, isAsleep = false, onWake }: PtyTabProps) {
  const host = useRef<HTMLDivElement>(null);
  const open = useRef<OpenTerminal | undefined>(undefined);
  const font = useRef(fontFamily); // the latest font (#376), read when the terminal is created: a font change alone never recreates it
  const asleep = useRef(isAsleep); // read when the terminal is created, as the font is (#672)
  const [pendingUrl, setPendingUrl] = useState<string>(); // an untrusted http(s) link the user clicked (#404)
  const { ptyId } = tab;
  const fileKey = tab.task ?? (tab.project === undefined ? undefined : localKey(tab.project)); // the activity its file links open in (#590, #717)
  const files = useFileOpenerRef();
  const refLinks = openRefUrl(activityId); // #588: its task references, always
  const taskRefs = useTaskRefs();
  const find = useFindBar(); // #12: this tab's find bar
  const { onFind, setTarget: setFindTarget } = find;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // claude turns mouse tracking on, which hands every drag to it; Option+drag is the macOS way back to a selection
    const xterm = new Terminal({
      fontFamily: font.current, cursorBlink: true, macOptionClickForcesSelection: true, linkHandler: linkHandler(setPendingUrl),
      allowProposedApi: true, // #12: the find bar's highlights are xterm decorations, still proposed API
      disableStdin: asleep.current, cursorInactiveStyle: asleep.current ? 'none' : 'outline', // #672: no key reaches a run that ended
    });
    terminalKeys(xterm, onFind);
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const search = loadSearch(xterm);
    xterm.open(element);
    setFindTarget({ term: xterm, search });
    terminalCopy(xterm); // #543: after open, like the paste; a ⌘C with no selection leaves the clipboard to what Claude copied
    terminalPaste(xterm, () => window.hive?.clipboardFiles() ?? Promise.resolve([])); // #843: after open, which gives it its element; outside the viewer, the text
    const { disconnect, postSize } = connectPty(xterm, ptyId, () => onExit(ptyId)); // before the first fit, so its grid reaches the pty
    const terminal = { xterm, fit, host: element, postSize };
    open.current = terminal;
    const untrack = trackTerminal(ptyId, xterm);
    const stopTheme = followTheme(xterm);
    if (fileLinks && fileKey !== undefined) linkFiles(xterm, (path, line, col) => { files.current?.(fileKey, path, atOf(line, col)); });
    if (refLinks !== undefined) {
      linkTaskRefs(xterm, refLinks, () => taskRefs.current.prefixes, { task: (taskId) => taskRefs.current.openTask(taskId), url: (url) => openLink(url, setPendingUrl) });
    }
    const sized = fitOnResize(terminal, postSize); // the first shown fit posts its grid (#808); a later one that changes it, connectPty
    return () => {
      untrack();
      sized.disconnect();
      disconnect();
      stopTheme();
      setFindTarget(undefined);
      xterm.dispose();
      open.current = undefined;
    };
  }, [ptyId, fileKey, refLinks, fileLinks, onExit, taskRefs, files, onFind, setFindTarget]);
  // The tab the user turns to (#808): fitted and its grid posted at once, past the resize debounce, so its pty follows the view in front;
  // the host drops a grid the pty already has. A mount already active and focused posts here too.
  useEffect(() => {
    const current = open.current;
    if (!active || !focused || isAsleep || current === undefined) return;
    current.xterm.focus();
    if (fitShown(current)) current.postSize();
  }, [active, focused, isAsleep]);
  // A run that falls asleep while shown (#672): its terminal turns read-only in place, its screen kept
  useEffect(() => {
    asleep.current = isAsleep;
    const xterm = open.current?.xterm;
    if (xterm === undefined) return;
    xterm.options.disableStdin = isAsleep;
    xterm.options.cursorInactiveStyle = isAsleep ? 'none' : 'outline';
  }, [isAsleep]);
  // A font saved in Settings (#376) reaches the open terminal in place, its screen and stream kept; the refit changes the grid for the new
  // cell size, and connectPty sends it.
  useEffect(() => {
    font.current = fontFamily;
    if (!open.current) return;
    open.current.xterm.options.fontFamily = fontFamily;
    fitShown(open.current);
  }, [fontFamily]);
  const shownOpacity = isAsleep ? SLEEPING_OPACITY : 1;
  // Collapsed with an inline opacity and a zero basis when not shown, not the `hidden` attribute or a class: dom-accessibility-api refuses a
  // name to a `hidden` element even under getByRole's own `hidden: true` (which the panel's tab switch needs while every tab and its stream
  // stay mounted), and Tailwind's utility classes never reach a computed style under jsdom, which has no build step to generate them.
  // LinkConfirm renders in a portal, so a hidden tab's opacity never reaches it.
  return (
    <section
      aria-label={label} data-pty-id={ptyId} data-asleep={isAsleep ? 'true' : undefined}
      style={{ flex: active ? '1 1 0%' : '0 0 0%', opacity: active ? shownOpacity : 0, filter: isAsleep ? 'grayscale(1)' : undefined, pointerEvents: active ? 'auto' : 'none' }}
      className="relative min-h-0 min-w-0 overflow-hidden p-1"
    >
      <div ref={host} className="h-full w-full" />
      {find.target && <TerminalFind {...find.target} isOpen={find.isOpen} request={find.request} onClose={find.close} />}
      {/* #672: a click anywhere in a sleeping pane continues its session, a terminal's wakes it (#696); a button, so the keyboard reaches it too */}
      {isAsleep && <button type="button" aria-label={t(tab.kind === 'terminal' ? 'terminal.wake' : 'session.continue')} className="absolute inset-0 cursor-pointer" onClick={onWake} />}
      <LinkConfirm url={pendingUrl} onClose={() => setPendingUrl(undefined)} />
    </section>
  );
}
