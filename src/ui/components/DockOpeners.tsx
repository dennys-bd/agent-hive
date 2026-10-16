import type { ReactNode } from 'react';
import {
  DiffOpenerContext, FileOpenerContext, IssueOpenerContext, type OpenDiff, type OpenFile, type OpenPr, type OpenRun, type OpenStarted, PrOpenerContext,
  RunOpenerContext, StartedTaskContext,
} from '@/components/terminal-tabs';
import { ConsoleContext, type OpenConsole, type OpenStageOutput, StageOutputContext } from '@/hooks/use-console';

export interface OpenersProps { openRun: OpenRun; openStarted: OpenStarted; openDiff: OpenDiff; openPr?: OpenPr; openIssue?: OpenPr; openFile: OpenFile; openConsole: OpenConsole; openStageOutput: OpenStageOutput; children: ReactNode }

/** Every opener the dock hands the page below it (#251, #353, #457, #458, #717, #755): the flow's tasks, Detalhes and the chips reach the dock
 * through these. Its own file since #313: MainDock is at its line limit. */
export function Openers({ openRun, openStarted, openDiff, openPr, openIssue, openFile, openConsole, openStageOutput, children }: OpenersProps) {
  return (
    <RunOpenerContext.Provider value={openRun}>
      <StartedTaskContext.Provider value={openStarted}>
        <DiffOpenerContext.Provider value={openDiff}>
          <PrOpenerContext.Provider value={openPr}>
            <IssueOpenerContext.Provider value={openIssue}>
              <FileOpenerContext.Provider value={openFile}>
                <ConsoleContext.Provider value={openConsole}>
                  <StageOutputContext.Provider value={openStageOutput}>{children}</StageOutputContext.Provider>
                </ConsoleContext.Provider>
              </FileOpenerContext.Provider>
            </IssueOpenerContext.Provider>
          </PrOpenerContext.Provider>
        </DiffOpenerContext.Provider>
      </StartedTaskContext.Provider>
    </RunOpenerContext.Provider>
  );
}
