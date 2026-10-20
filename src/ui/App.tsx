import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { FullScreenContext, useFullScreen } from '@/hooks/use-full-screen';
import { act } from '@/components/actions';
import { CloseTabContext, type NoticeKey, type CloseTabSettings } from '@/components/close-tab-notice';
import { EditorLanguagesContext, type EditorLanguages } from '@/components/editor-languages';
import { Dashboard } from '@/components/Dashboard';
import type { Selection } from '@/components/DetailPanel';
import { AgentsContext, DefaultAgentContext } from '@/components/NewRunButton';
import { TaskRefContext, type TaskRefs } from '@/components/PtyTab';
import { Settings } from '@/components/settings/Settings';
import { FileIconsContext } from '@/hooks/use-file-icons';
import { ReviewerContext, type ReviewerSettings, reviewerSaver } from '@/hooks/use-reviewer';
import { useHiveState } from '@/hooks/use-hive-state';
import { useSettingsInfo } from '@/hooks/use-settings-info';
import { LOCALE, setLanguage, t } from '@/i18n';
import type { SettingsView } from '@/lib/settings-sections';
import { refPrefixes } from '@/lib/task-refs';
import { applyTheme, type ResolvedTheme } from '@/lib/theme';
import { setShortcuts } from '@/lib/shortcut-bindings';
import { onTrust, setTrustedDomains } from '@/lib/trusted-links';
import { terminalFontStack } from '@/lib/xterm-setup';
import { CLOSE_TAB_DEFAULTS, DEFAULT_AGENT, EDITOR_DEFAULTS, FILE_ICONS_DEFAULTS, REVIEWER_DEFAULTS, SLEEP_NOTICE_DEFAULTS, type Language, type SettingsInfo, type SettingsResult } from '../types';
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

// What closing an agent's tab does (#614) and the four sleep notices (#672): the saved choices, the notices' link to Settings › execution, and
// their checkbox's save. The save posts one key with the prefix, which configFrom has no fallback for (as POST /trusted-domains does), then
// reloads the settings info so the next notice reads the saved switch
function closeTabSettings(info: SettingsInfo, reload: () => Promise<unknown>, openSettings: (view: SettingsView) => void): CloseTabSettings {
  const { closeSessionTab, closeStageTab, closeTerminalTab, closeSessionTabNotice, closeStageTabNotice, closeTerminalTabNotice } = info.config ?? CLOSE_TAB_DEFAULTS;
  const { sleepNotice, sleepAutoNotice, sleepIdleNotice, sleepAllNotice } = info.config ?? SLEEP_NOTICE_DEFAULTS;
  const saveNotice = async (key: NoticeKey, on: boolean): Promise<boolean> => {
    const answer = await act<SettingsResult>('/settings', { prefix: info.config?.comb.prefix, [key]: on });
    if (answer) void reload().catch((err: Error) => toast.error(err.message));
    return answer !== undefined;
  };
  return {
    closeSessionTab, closeStageTab, closeSessionTabNotice, closeStageTabNotice, closeTerminalTab, closeTerminalTabNotice, sleepNotice, sleepAutoNotice, sleepIdleNotice, sleepAllNotice,
    openSettings: () => openSettings({ section: 'execution' }), saveNotice,
  };
}

export function App() {
  const { info, error: settingsError, reload } = useSettingsInfo();
  const { state, effective, connected, tick } = useHiveState();
  const [language, setLanguageState] = useState<Language>();
  // Settings is a full page over the dashboard once configured (#294, #510); the first-run form has no state of its own here.
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark'); // what applyTheme painted: Material's light icons read it (#754)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>(); // the footer's editar regras opens Settings on rules, a source's configurar on its detail page
  const [selected, setSelected] = useState<Selection>();
  const [pending, setPending] = useState<Selection>(); // a menu bar request (#192) waiting for `state` to hold its task
  const theme = info?.config?.theme ?? 'system'; // setup mode with nothing saved follows macOS (#296)
  const isFullScreen = useFullScreen(); // #295: before any early return, so the setup form's Settings gets its insets too

  useEffect(() => { // before the first content render: neither the form nor the dashboard ever shows the wrong language
    if (!info) return;
    setLanguage(info.language);
    setLanguageState(info.language);
  }, [info]);
  useEffect(() => { if (language) document.documentElement.lang = LOCALE[language]; }, [language]);
  // The saved theme at once (#296), the way the language switches: a save re-runs it through the reloaded info; system follows macOS live.
  useEffect(() => applyTheme(theme, setResolvedTheme), [theme]);
  // The panel's trusted link domains (#404), from the saved config like the theme. A trust from a tab's link dialog reloads info, so the
  // next Settings form drafts the list with the new host and its save cannot drop it.
  useEffect(() => setTrustedDomains(info?.config?.trustedDomains ?? []), [info]);
  // The page's shortcut bindings (#449), from the saved config like the trusted domains: a Settings save reloads info and re-runs it.
  useEffect(() => setShortcuts(info?.config?.shortcuts ?? {}), [info]);
  useEffect(() => onTrust(() => void reload().catch((err: Error) => toast.error(err.message))), [reload]);
  useEffect(() => { if (state?.error) toast.error(state.error); }, [state?.error]);
  useEffect(() => { if (!connected) toast.error(t('error.disconnected')); }, [connected]);
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

  // What the editor pane reads of Settings › editor (#780): one value per info, so an attached model is not detached on every render
  const editorLanguages = useMemo<EditorLanguages>(() => ({
    editor: info?.config?.editor ?? EDITOR_DEFAULTS,
    openLanguage: (language) => { setSettingsView({ section: 'editor', language }); setSettingsOpen(true); },
  }), [info]);
  // The template reviewer's setting (#329) for the plugins view's menu: the saved key, and its write, which posts it with the prefix as the
  // close-tab notices post theirs and reloads the info; a failed reload is a toast, as theirs is
  const reviewer = useMemo<ReviewerSettings>(() => ({
    config: info?.config?.reviewer ?? REVIEWER_DEFAULTS,
    save: reviewerSaver(info?.config?.comb.prefix, () => reload().catch((err: Error) => { toast.error(err.message); })),
  }), [info, reload]);
  if (settingsError) return <p className="p-4 pt-11 text-destructive">{settingsError}</p>;
  if (!info || !language) return null;
  const openSettings = (view: SettingsView): void => { setSettingsView(view); setSettingsOpen(true); };
  const sources = { sources: info.config?.comb.sources ?? [], hiveSource: info.config?.comb.hiveSource ?? true, createIn: info.config?.comb.createIn ?? HIVE_SOURCE, auth: info.config?.auth?.github ?? 'cli', onConfigure: (source: string) => openSettings({ section: 'flow', source }), onAdd: () => openSettings({ section: 'flow' }) } as const;

  const closeTab = closeTabSettings(info, reload, openSettings);
  // A task reference clicked in a panel tab (#588) opens that task's panel, as the menu bar's window:select does (#192, #283)
  const taskRefs: TaskRefs = { prefixes: info.config ? refPrefixes(info.config) : [], openTask: (taskId) => setSelected({ taskId }) };

  async function onSaved(): Promise<void> {
    const next = await reload();
    setLanguage(next.language);
    setLanguageState(next.language);
    setSettingsOpen(false);
    setSettingsView(undefined);
  }

  // The first run has no dashboard to show behind it, and no Cancel (#294): a full page, same as always.
  if (!info.configured) {
    return (
      <>
        <Settings info={info} state={state} onSaved={onSaved} />
        <Toaster theme={theme} />
      </>
    );
  }

  return (
    <>
      {/* #510: the dashboard stays mounted under the Settings page, so its terminals keep their sessions; inert keeps focus and clicks off it */}
      <FullScreenContext.Provider value={isFullScreen}>
      <div className="contents" inert={settingsOpen}>
        {/* the panel's tabs take a saved terminal font at once (#376): a save reloads info and re-renders them */}
        <DefaultAgentContext.Provider value={info.config?.defaultAgent ?? DEFAULT_AGENT}>
          {/* #931: the agents boot found, which every menu that opens a session disables by */}
          <AgentsContext.Provider value={info.agents}>
            {/* the files tree's icons (#754): the saved choice, and the theme applyTheme painted for Material's light overrides */}
            <FileIconsContext.Provider value={{ ...(info.config?.fileIcons ?? FILE_ICONS_DEFAULTS), theme: resolvedTheme }}>
              <CloseTabContext.Provider value={closeTab}>
                <TaskRefContext.Provider value={taskRefs}>
                  <EditorLanguagesContext.Provider value={editorLanguages}>
                    <ReviewerContext.Provider value={reviewer}>
                    <Dashboard state={state} effective={effective} selected={selected} locale={LOCALE[language]} tick={tick} hasSource={(info.config?.comb.sources.length ?? 0) > 0} fileLinks fontFamily={terminalFontStack(info.config?.terminalFont ?? '')} sources={sources} onSelect={setSelected} onEditRules={() => openSettings({ section: 'rules' })} onAddWorkspace={() => openSettings({ section: 'workspaces' })} onOpenSettings={() => setSettingsOpen(true)} openShortcuts={() => openSettings({ section: 'shortcuts' })} sidebarsPerView={info.config?.sidebarsPerView} />
                    </ReviewerContext.Provider>
                  </EditorLanguagesContext.Provider>
                </TaskRefContext.Provider>
              </CloseTabContext.Provider>
            </FileIconsContext.Provider>
          </AgentsContext.Provider>
        </DefaultAgentContext.Provider>
      </div>
      </FullScreenContext.Provider>
      {settingsOpen && <Settings info={info} state={state} view={settingsView} onSaved={onSaved} onCancel={() => { setSettingsOpen(false); setSettingsView(undefined); }} />}
      <Toaster theme={theme} />
    </>
  );
}
