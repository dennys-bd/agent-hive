// What App and a detached window (#553) both set up: the settings' effects on the page, the values the center's panes read, and the providers that carry them.
// ReviewerContext and Settings stay App's: a detached window has no plugins view and no settings page.
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { act } from '@/components/actions';
import { CloseTabContext, type CloseTabSettings, type NoticeKey } from '@/components/close-tab-notice';
import { type EditorLanguages, EditorLanguagesContext } from '@/components/editor-languages';
import { AgentsContext, DefaultAgentContext } from '@/components/NewRunButton';
import { TaskRefContext, type TaskRefs } from '@/components/PtyTab';
import { FileIconsContext } from '@/hooks/use-file-icons';
import { LOCALE, setLanguage, t } from '@/i18n';
import { AgentModelsContext, offeredAgents } from '@/lib/agent-settings';
import type { SettingsView } from '@/lib/settings-sections';
import { setShortcuts } from '@/lib/shortcut-bindings';
import { refPrefixes } from '@/lib/task-refs';
import { applyTheme, type ResolvedTheme } from '@/lib/theme';
import { onTrust, setTrustedDomains } from '@/lib/trusted-links';
import {
  CLOSE_TAB_DEFAULTS, DEFAULT_AGENT, EDITOR_DEFAULTS, FILE_ICONS_DEFAULTS, type Language, type LanguageId, SLEEP_NOTICE_DEFAULTS, type SettingsInfo, type SettingsResult, type State, type Theme,
} from '../types';

// What closing an agent's tab does (#614) and the four sleep notices (#672): the saved choices, the notices' link to Settings › execution, and
// their checkbox's save. The save posts one key with the prefix, which configFrom has no fallback for (as POST /trusted-domains does), then
// reloads the settings info so the next notice reads the saved switch. A detached window has no Settings to open (#553): without an opener the link is absent
export function closeTabSettings(info: SettingsInfo, reload: () => Promise<unknown>, openSettings?: (view: SettingsView) => void): CloseTabSettings {
  const { closeSessionTab, closeStageTab, closeTerminalTab, closeSessionTabNotice, closeStageTabNotice, closeTerminalTabNotice } = info.config ?? CLOSE_TAB_DEFAULTS;
  const { sleepNotice, sleepAutoNotice, sleepIdleNotice, sleepAllNotice } = info.config ?? SLEEP_NOTICE_DEFAULTS;
  const saveNotice = async (key: NoticeKey, on: boolean): Promise<boolean> => {
    const answer = await act<SettingsResult>('/settings', { prefix: info.config?.comb.prefix, [key]: on });
    if (answer) void reload().catch((err: Error) => toast.error(err.message));
    return answer !== undefined;
  };
  return {
    closeSessionTab, closeStageTab, closeSessionTabNotice, closeStageTabNotice, closeTerminalTab, closeTerminalTabNotice, sleepNotice, sleepAutoNotice, sleepIdleNotice, sleepAllNotice,
    ...(openSettings === undefined ? {} : { openSettings: () => openSettings({ section: 'execution' }) }), saveNotice,
  };
}

// What the editor pane reads of Settings › editor (#780); a detached window has no Settings to open a language in (#553)
export const editorLanguagesOf = (info: SettingsInfo | undefined, openLanguage?: (language: LanguageId) => void): EditorLanguages =>
  ({ editor: info?.config?.editor ?? EDITOR_DEFAULTS, ...(openLanguage === undefined ? {} : { openLanguage }) });

// A task reference clicked in a terminal (#588): App opens its panel, a detached window asks the main window to (#553)
export const taskRefsOf = (info: SettingsInfo, openTask: (taskId: string) => void): TaskRefs =>
  ({ prefixes: info.config ? refPrefixes(info.config) : [], openTask });

export interface AppSetupInput { info?: SettingsInfo; reload(): Promise<SettingsInfo>; state?: State; connected: boolean; openLanguage?(language: LanguageId): void }
export interface AppSetup {
  language?: Language; applyLanguage(language: Language): void; theme: Theme; resolvedTheme: ResolvedTheme;
  offered: ReturnType<typeof offeredAgents>; editorLanguages: EditorLanguages;
}

export function useAppSetup({ info, reload, state, connected, openLanguage }: AppSetupInput): AppSetup {
  const [language, setLanguageState] = useState<Language>();
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark'); // what applyTheme painted: Material's light icons read it (#754)
  const theme = info?.config?.theme ?? 'system'; // setup mode with nothing saved follows macOS (#296)
  const applyLanguage = useCallback((next: Language) => {
    setLanguage(next);
    setLanguageState(next);
  }, []);
  useEffect(() => { // before the first content render: neither the form nor the dashboard ever shows the wrong language
    if (info) applyLanguage(info.language);
  }, [info, applyLanguage]);
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
  const editorLanguages = useMemo(() => editorLanguagesOf(info, openLanguage), [info, openLanguage]); // one value per info, so an attached model is not detached on every render (#780)
  const offered = useMemo(() => offeredAgents(info?.agents ?? [], info?.config?.agentEnabled), [info]);
  return { language, applyLanguage, theme, resolvedTheme, offered, editorLanguages };
}

/** The contexts the center's panes read. */
export function SetupProviders({ info, setup, closeTab, taskRefs, children }: { info: SettingsInfo; setup: AppSetup; closeTab: CloseTabSettings; taskRefs: TaskRefs; children: ReactNode }): ReactNode {
  return (
    // the panel's tabs take a saved terminal font at once (#376): a save reloads info and re-renders them
    <DefaultAgentContext.Provider value={info.config?.defaultAgent ?? DEFAULT_AGENT}>
      {/* #931: the agents boot found, minus the disabled ones (#482); every menu that opens a session disables by it */}
      <AgentsContext.Provider value={setup.offered}>
        <AgentModelsContext.Provider value={info.config?.agentModels ?? {}}>
          {/* the files tree's icons (#754): the saved choice, and the theme applyTheme painted for Material's light overrides */}
          <FileIconsContext.Provider value={{ ...(info.config?.fileIcons ?? FILE_ICONS_DEFAULTS), theme: setup.resolvedTheme }}>
            <CloseTabContext.Provider value={closeTab}>
              <TaskRefContext.Provider value={taskRefs}>
                <EditorLanguagesContext.Provider value={setup.editorLanguages}>{children}</EditorLanguagesContext.Provider>
              </TaskRefContext.Provider>
            </CloseTabContext.Provider>
          </FileIconsContext.Provider>
        </AgentModelsContext.Provider>
      </AgentsContext.Provider>
    </DefaultAgentContext.Provider>
  );
}
