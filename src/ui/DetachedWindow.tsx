// A detached window's page (#553): one activity's center in a window of its own, the main window's per-viewer habits read and never written
// (main.tsx turns view-state writes off). The setup is App's (app-setup.tsx) minus what acts on the main window's frame: no Settings, no
// reviewer, no view or panel keys, no search, no dock.
import { useCallback, useEffect } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { activityPane } from '@/components/PaneHeader';
import { ActivityCenter } from '@/components/ActivityCenter';
import { windowTitle } from '@/components/ActivityBar';
import { DesignLayer, DesignLayerProvider } from '@/components/DesignLayer';
import { DetachedStrip } from '@/components/DetachedStrip';
import { Openers, type OpenersProps } from '@/components/DockOpeners';
import type { OpenDiff, OpenRun } from '@/components/terminal-tabs';
import { closeTabSettings, SetupProviders, taskRefsOf, useAppSetup } from '@/app-setup';
import { FullScreenContext, useFullScreen } from '@/hooks/use-full-screen';
import { useHiveState } from '@/hooks/use-hive-state';
import { useSettingsInfo } from '@/hooks/use-settings-info';
import { useFileOpener } from '@/hooks/use-file-opener';
import { type ConsoleChannels, ConsoleChannelsContext, consoleRunsOf, type OpenConsole, type OpenStageOutput, useConsoleChannels } from '@/hooks/use-console';
import { type DetachedLayout, useDetachedLayout } from '@/hooks/use-detached-layout';
import { type Activity, activitiesOf, activityKey, localKey } from '@/lib/activities';
import { type CenterTabRef, consoleRef, shownTab } from '@/lib/center-layout';
import { terminalFontStack } from '@/lib/xterm-setup';
import type { State } from '../types';

// A task reference or another task's run: the main window opens that task's panel (#588)
const openTaskInMain = (taskId: string): void => {
  window.hive?.openTask(taskId).catch((err: unknown) => console.error('detached window: openTask refused', err));
};

// The window's openers (spec decision 7): this activity's run, diff, console, stage output and file open as tabs here; a run, a start or a
// stage output of another task asks the main window to open the task; a run of another workspace's local activity opens nothing
function useWindowOpeners(activities: Activity[], key: string, request: (tab?: CenterTabRef) => void, channels: ConsoleChannels): Omit<OpenersProps, 'children'> {
  const openFile = useFileOpener(activities, (target, path, kind) => { if (target === key) request({ kind, path }); }); // a terminal's file links too (decision 8)
  const openRun: OpenRun = useCallback((tab) => {
    const target = tab.task ?? (tab.project === undefined ? undefined : localKey(tab.project));
    if (target === key) request({ kind: 'run', ptyId: tab.ptyId });
    else if (tab.task !== undefined) openTaskInMain(tab.task);
  }, [key, request]);
  const openStarted = useCallback((taskId: string) => (taskId === key ? request() : openTaskInMain(taskId)), [key, request]);
  const openStageOutput: OpenStageOutput = useCallback((taskId, channel, run) => (taskId === key ? request(consoleRef(channel, true, run)) : openTaskInMain(taskId)), [key, request]);
  const openDiff: OpenDiff = (task, scope, checkpoint) => { if (task.item.itemId === key) request({ kind: 'diff', scope, ...(checkpoint === undefined ? {} : { checkpoint }) }); };
  // A command's start only flags the drawer's chip, which the window has none of; a setup's ver log (show) opens its channel as a tab
  const openConsole: OpenConsole = (channel, ptyId, show) => {
    channels.select({ channel, ptyId });
    channels.refresh();
    if (show) request(consoleRef(channel));
  };
  return { openRun, openStarted, openDiff, openFile, openConsole, openStageOutput };
}

interface WindowPageProps { state: State; activityKey: string; fontFamily: string }

// The center the page is (spec decision 5): ActivityCenter whole over the window's layout, with the design layer over its slots (#533) and
// the run tabs' pane header from the State (decision 6); the strip's back button docks the focused group's shown tab (decision 10)
function WindowPage({ state, activityKey: key, fontFamily }: WindowPageProps) {
  const activities = activitiesOf(state);
  const activity = activities.find((a) => activityKey(a) === key);
  const layouts: DetachedLayout = useDetachedLayout(activities, activity);
  const channels = useConsoleChannels(consoleRunsOf(state));
  const openers = useWindowOpeners(activities, key, layouts.request, channels);
  const title = activity && windowTitle(activity);
  useEffect(() => { if (title !== undefined) document.title = title; }, [title]); // main names the window by it (#552 decision 14)
  if (activity === undefined) return null;
  const shown = shownTab(layouts.layout);
  return (
    <Openers {...openers}>
      <ConsoleChannelsContext.Provider value={channels}>
        <div className="flex h-screen flex-col overflow-hidden">
          <DetachedStrip title={windowTitle(activity)} canGoBack={shown !== undefined} onBack={() => { if (shown) void layouts.dock(shown); }} />
          <div className="relative flex min-h-0 min-w-0 flex-1">
            <DesignLayerProvider>
              <ActivityCenter
                activity={activity} layout={layouts.layout} ops={layouts} fileLinks fontFamily={fontFamily} pane={activityPane(activity, state)}
                onOpenRun={(ptyId) => layouts.request({ kind: 'run', ptyId })} onDock={(ref) => void layouts.dock(ref)}
              />
              <DesignLayer activities={activities} layouts={layouts.layouts} />
            </DesignLayerProvider>
          </div>
        </div>
      </ConsoleChannelsContext.Provider>
    </Openers>
  );
}

/** The page main.tsx mounts in window mode (#553): App's setup through app-setup.tsx, the providers the panes read, and the activity's center. */
export function DetachedWindow({ activity }: { activity: string }) {
  const { info, error, reload } = useSettingsInfo();
  const { state, connected } = useHiveState();
  const setup = useAppSetup({ info, reload, state, connected }); // no openLanguage: no Settings here (spec decision 18)
  const isFullScreen = useFullScreen(); // the strip's inset, through index.css's data-fullscreen (#295)
  if (error) return <p className="p-4 pt-11 text-destructive">{error}</p>;
  if (!info || !setup.language) return null;
  return (
    <FullScreenContext.Provider value={isFullScreen}>
      <SetupProviders info={info} setup={setup} closeTab={closeTabSettings(info, reload)} taskRefs={taskRefsOf(info, openTaskInMain)}>
        {state && <WindowPage state={state} activityKey={activity} fontFamily={terminalFontStack(info.config?.terminalFont ?? '')} />}
      </SetupProviders>
      <Toaster theme={setup.theme} />
    </FullScreenContext.Provider>
  );
}
