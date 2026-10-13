import { ProblemCounts } from '@/components/footer/ProblemsButton';
import { Button } from '@/components/ui/button';
import { useEditorLanguages } from '@/components/editor-languages';
import { useDiagnostics } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { type Counts, fileCounts, fileServer, fileSources, type Source } from '@/lib/diagnostics-store';
import { STATUS_DOT } from '@/lib/status';
import type { FormatLog } from '../../types';

interface ServerStatusProps { activityId: string; path: string; onViewLog?(log: FormatLog): void }
interface ProblemsButtonProps { activityId: string; path: string; isOpen: boolean; onToggle(): void }

const Dot = ({ tone }: { tone: string }) => <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;
const hasCounts = (counts: Counts): boolean => counts.errors + counts.warnings + counts.infos > 0;

// ver log beside a failed source, when there is a console to open it in (none outside a Dashboard)
function ViewLog({ log, onViewLog }: { log?: FormatLog; onViewLog?(log: FormatLog): void }) {
  if (log === undefined || onViewLog === undefined) return null;
  return <Button type="button" variant="link" size="xs" className="h-5 p-0 text-review" onClick={() => onViewLog(log)}>{t('editor.viewLog')}</Button>;
}

/** The bar's language server part (#780): starting, ready, failed with ver log, or none with instalar; nothing for a language the catalog serves
 * no server for, or a workspace out of the server's scope. Its counts are the problems button's (#782). */
export function ServerStatus({ activityId, path, onViewLog }: ServerStatusProps) {
  useDiagnostics();
  const { openLanguage } = useEditorLanguages();
  const file = fileServer(activityId, path);
  if (file === undefined || file.state.phase === 'off') return null;
  const { state, server, log } = file;
  return (
    <span data-testid="server-status" className="flex shrink-0 items-center gap-1.5">
      {state.phase === 'starting' && <><Dot tone={STATUS_DOT.empty} />{t('editor.lsp.starting', { server })}</>}
      {state.phase === 'ready' && <><Dot tone={STATUS_DOT.working} />{server}</>}
      {state.phase === 'failed' && <><span title={state.reason} className="text-destructive">{t('editor.lsp.failed', { server })}</span><ViewLog log={log} onViewLog={onViewLog} /></>}
      {state.phase === 'absent' && (
        <>
          <span title={state.reason}>{t('editor.lsp.none')}</span>
          {openLanguage && <Button type="button" variant="outline" size="xs" className="h-5 rounded-sm px-1.5 py-0" onClick={() => openLanguage(file.language)}>{t('editor.lsp.install', { server })}</Button>}
        </>
      )}
    </span>
  );
}

// One checker of the bar (#782): ready green, starting or running grey, failed in red with ver log; one not in the project, or off, none (#850)
function SourceEntry({ source, onViewLog }: { source: Source; onViewLog?(log: FormatLog): void }) {
  if (source.phase === 'failed') {
    return <span className="flex shrink-0 items-center gap-1.5"><span title={source.reason} className="text-destructive">{t('editor.lsp.failed', { server: source.name })}</span><ViewLog log={source.log} onViewLog={onViewLog} /></span>;
  }
  if (source.phase === 'absent') return null;
  return <span className="flex shrink-0 items-center gap-1.5"><Dot tone={source.phase === 'ready' ? STATUS_DOT.working : STATUS_DOT.empty} />{source.name}</span>;
}

/** The open file's checkers in the bar (#782), one entry each, after its language's server. */
export function CheckerSources({ activityId, path, onViewLog }: ServerStatusProps) {
  useDiagnostics();
  return <>{fileSources(activityId, path).map((source) => <SourceEntry key={source.name} source={source} onViewLog={onViewLog} />)}</>;
}

/** The open file's counts over every source (#782), a button that opens and closes the problems list; accent while the list is open. */
export function ProblemsButton({ activityId, path, isOpen, onToggle }: ProblemsButtonProps) {
  useDiagnostics();
  const counts = fileCounts(activityId, path);
  return (
    <Button
      type="button" variant="ghost" size="xs" aria-label={t('problems.title')} aria-pressed={isOpen} title={t('problems.title')} onClick={onToggle}
      className={`h-5 shrink-0 gap-1.5 rounded-sm px-1.5 py-0 font-normal ${isOpen ? 'bg-accent' : ''}`}
    >
      {hasCounts(counts) ? <ProblemCounts counts={counts} /> : t('problems.title')}
    </Button>
  );
}
