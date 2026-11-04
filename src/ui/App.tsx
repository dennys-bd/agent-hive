import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { FullScreenContext, useFullScreen } from '@/hooks/use-full-screen';
import { closeTabSettings, SetupProviders, taskRefsOf, useAppSetup } from '@/app-setup';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { Settings } from '@/components/settings/Settings';
import { ReviewerContext, type ReviewerSettings, reviewerSaver } from '@/hooks/use-reviewer';
import { useHiveState } from '@/hooks/use-hive-state';
import { useSettingsInfo } from '@/hooks/use-settings-info';
import { LOCALE } from '@/i18n';
import type { SettingsView } from '@/lib/settings-sections';
import { terminalFontStack } from '@/lib/xterm-setup';
import { REVIEWER_DEFAULTS, type LanguageId } from '../types';
import { HIVE_SOURCE } from '../tasks';

// window:select comes from main over IPC (#192): only a task request with a string id is taken (#283: the menu opens the task's panel).
function isTaskSelection(value: unknown): value is Selection {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).taskId === 'string';
}

// window:select also carries the menu bar's Settings… request (#195): untrusted IPC, so its shape is checked too.
function isSettingsRequest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Record<string, unknown>).view === 'settings';
}

export function App() {
  const { info, error: settingsError, reload } = useSettingsInfo();
  const { state, effective, connected, tick } = useHiveState();
  // Settings is a full page over the dashboard once configured (#294, #510); the first-run form has no state of its own here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>(); // the footer's editar regras opens Settings on rules, a source's configurar on its detail page
  const [selected, setSelected] = useState<Selection>();
  const [pending, setPending] = useState<Selection>(); // a menu bar request (#192) waiting for `state` to hold its task
  const isFullScreen = useFullScreen(); // #295: before any early return, so the setup form's Settings gets its insets too

  const openLanguage = useCallback((language: LanguageId) => { setSettingsView({ section: 'editor', language }); setSettingsOpen(true); }, []);
  const setup = useAppSetup({ info, reload, state, connected, openLanguage });
  // The panel follows its task: gone from the Hive → closed. A task id is never reused by another task, so a stale selection can never open
  // on someone else's task.
  useEffect(() => {
    if (!selected) return;
    if (!state?.tasks.some((c) => c.item.itemId === selected.taskId)) setSelected(undefined);
  }, [state, selected]);
  // A worker line of the menu bar (#192): main asks for that task's panel. The panel lives on the dashboard, so the settings
  // page is closed and its edits dropped, without the discard confirm Cancel asks: the menu is an explicit navigation. The
  // request waits for `state` and is dropped when a loaded state lacks the task. The menu's Settings… (#195) opens the page instead; one already open stays as it is, keeping its edits.
  useEffect(() => {
    window.hive?.onSelect((selection) => {
      if (isSettingsRequest(selection)) { setSettingsOpen(true); return; }
      if (!isTaskSelection(selection)) return;
      setSettingsOpen(false);
      setPending(selection);
    });
  }, []);
  useEffect(() => {
    if (!pending || !state) return;
    if (state.tasks.some((c) => c.item.itemId === pending.taskId)) setSelected(pending);
    setPending(undefined);
  }, [state, pending]);

  // The template reviewer's setting (#329) for the plugins view's menu: the saved key, and its write, which posts it with the prefix as the
  // close-tab notices post theirs and reloads the info; a failed reload is a toast, as theirs is
  const reviewer = useMemo<ReviewerSettings>(() => ({
    config: info?.config?.reviewer ?? REVIEWER_DEFAULTS,
    save: reviewerSaver(info?.config?.comb.prefix, () => reload().catch((err: Error) => { toast.error(err.message); })),
  }), [info, reload]);
  if (settingsError) return <p className="p-4 pt-11 text-destructive">{settingsError}</p>;
  if (!info || !setup.language) return null;
  const openSettings = (view: SettingsView): void => { setSettingsView(view); setSettingsOpen(true); };
  const sources = { sources: info.config?.comb.sources ?? [], hiveSource: info.config?.comb.hiveSource ?? true, createIn: info.config?.comb.createIn ?? HIVE_SOURCE, auth: info.config?.auth?.github ?? 'cli', onConfigure: (source: string) => openSettings({ section: 'flow', source }), onAdd: () => openSettings({ section: 'flow' }) } as const;

  const closeTab = closeTabSettings(info, reload, openSettings);
  // A task reference clicked in a panel tab (#588) opens that task's panel, as the menu bar's window:select does (#192, #283)
  const taskRefs = taskRefsOf(info, (taskId) => setSelected({ taskId }));

  async function onSaved(): Promise<void> {
    const next = await reload();
    setup.applyLanguage(next.language);
    setSettingsOpen(false);
    setSettingsView(undefined);
  }

  // The first run has no dashboard to show behind it, and no Cancel (#294): a full page, same as always.
  if (!info.configured) {
    return (
      <>
        <Settings info={info} state={state} onSaved={onSaved} />
        <Toaster theme={setup.theme} />
      </>
    );
  }

  return (
    <>
      {/* #510: the dashboard stays mounted under the Settings page, so its terminals keep their sessions; inert keeps focus and clicks off it */}
      <FullScreenContext.Provider value={isFullScreen}>
      <div className="contents" inert={settingsOpen}>
        <SetupProviders info={info} setup={setup} closeTab={closeTab} taskRefs={taskRefs}>
          <ReviewerContext.Provider value={reviewer}>
            <Dashboard state={state} effective={effective} selected={selected} locale={LOCALE[setup.language]} tick={tick} hasSource={(info.config?.comb.sources.length ?? 0) > 0} fileLinks fontFamily={terminalFontStack(info.config?.terminalFont ?? '')} sources={sources} onSelect={setSelected} onEditRules={() => openSettings({ section: 'rules' })} onAddWorkspace={() => openSettings({ section: 'workspaces' })} onOpenSettings={() => setSettingsOpen(true)} openShortcuts={() => openSettings({ section: 'shortcuts' })} onOpenFlowSettings={() => openSettings({ section: 'flow' })} onNewFlow={() => openSettings({ section: 'flow', newFlow: true })} sidebarsPerView={info.config?.sidebarsPerView} />
          </ReviewerContext.Provider>
        </SetupProviders>
      </div>
      </FullScreenContext.Provider>
      {settingsOpen && <Settings info={info} state={state} view={settingsView} onSaved={onSaved} onCancel={() => { setSettingsOpen(false); setSettingsView(undefined); }} />}
      <Toaster theme={setup.theme} />
    </>
  );
}
