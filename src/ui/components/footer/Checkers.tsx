import { useEditorLanguages } from '@/components/editor-languages';
import { Button } from '@/components/ui/button';
import { useOpenConsole } from '@/hooks/use-console';
import { useDiagnostics } from '@/hooks/use-diagnostics';
import { t } from '@/i18n';
import { type ActivitySource, activityStatus } from '@/lib/diagnostics-store';

const ITEM = 'flex shrink-0 items-center gap-1.5 whitespace-nowrap';
const Dot = ({ tone }: { tone: string }) => <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${tone}`} />;

// Starting reads iniciando for a server; a command-line checker's run reads executando (the glossary: never rodar)
const startingText = (source: ActivitySource): string =>
  source.kind === 'checker' ? t('checker.running', { checker: source.name }) : t('editor.lsp.starting', { server: source.name });

// Failed (handoff §3.4): red; with a log, a click opens its channel in the console, there is no ver log in the footer
function Failed({ source }: { source: ActivitySource }) {
  const openConsole = useOpenConsole();
  const { name, log, reason } = source;
  const content = <><Dot tone="bg-destructive" />{t('editor.lsp.failed', { server: name })}</>;
  if (log === undefined || openConsole === undefined) return <span title={reason} className={`${ITEM} text-destructive`}>{content}</span>;
  const title = [reason, t('checker.openLog', { server: name })].filter((part) => part !== undefined).join(' · ');
  return <button type="button" title={title} className={`${ITEM} text-destructive`} onClick={() => openConsole(log.channel, log.run, true)}>{content}</button>;
}

// The language's own server not installed: a muted ring, sem language server, and instalar… to Settings; nothing installs from here
function Absent({ source }: { source: ActivitySource }) {
  const { openLanguage } = useEditorLanguages();
  const { language } = source;
  return (
    <span className={ITEM}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-muted-foreground" />
      <span title={source.reason}>{t('editor.lsp.none')}</span>
      {openLanguage && language && (
        <Button type="button" variant="outline" size="xs" className="h-5 rounded-sm px-1.5 py-0" onClick={() => openLanguage(language)}>{t('editor.lsp.install', { server: source.name })}</Button>
      )}
    </span>
  );
}

function Item({ source }: { source: ActivitySource }) {
  if (source.phase === 'failed') return <Failed source={source} />;
  if (source.phase === 'absent') return <Absent source={source} />;
  if (source.phase === 'starting') return <span className={ITEM}><Dot tone="bg-empty" />{startingText(source)}</span>;
  return <span className={ITEM}><Dot tone="bg-working" />{source.name}</span>;
}

/** The footer's checkers (#225, handoff §3.4): every live language server, checker server and command-line checker of the activity the
 * center shows, one item each; nothing without an activity. */
export function Checkers({ activityId }: { activityId?: string }) {
  useDiagnostics();
  const sources = activityId === undefined ? [] : activityStatus(activityId);
  if (sources.length === 0) return null;
  return <div className="flex shrink-0 items-center gap-2.5 rounded-sm px-2 py-px hover:bg-accent">{sources.map((s) => <Item key={s.name} source={s} />)}</div>;
}
