import { useState } from 'react';
import { prRepo } from '../../pull-requests';
import type { PrCheck, PrChecks as Checks, PrData } from '../../types';
import { act } from '@/components/actions';
import { Button } from '@/components/ui/button';
import { prPath } from '@/hooks/use-pr';
import { t } from '@/i18n';
import { relativeTime } from '@/lib/home';

const MARK: Record<PrCheck['state'], { mark: string; tone: string }> = {
  success: { mark: '✓', tone: 'text-working' }, failure: { mark: '✕', tone: 'text-destructive' }, pending: { mark: '●', tone: 'text-waiting' },
};
const count = (checks: Checks, state: PrCheck['state']): number => checks.items.filter((c) => c.state === state).length;

// The header's mark: ✕ once any failed, ● while any runs, else ✓
function worstOf(failed: number, pending: number): PrCheck['state'] {
  if (failed > 0) return 'failure';
  return pending > 0 ? 'pending' : 'success';
}

type PrRef = Pick<PrData, 'url' | 'canPush'>;

// re-executar falhas (#854, handoff item 10): the failed Actions runs re-run once; off without push rights, its reason on the wrapper
function RerunButton({ pr, onChanged }: { pr: PrRef; onChanged?(): void }) {
  const [isRunning, setRunning] = useState(false);
  const rerun = (): void => {
    setRunning(true);
    void act(prPath(pr.url, '/checks/rerun')).finally(() => { setRunning(false); onChanged?.(); });
  };
  return (
    <span title={pr.canPush ? undefined : t('pr.checks.rerunNoPermission', { repo: prRepo(pr.url) })} className="flex">
      <Button type="button" size="xs" variant="outline" className="px-2.5 py-0.5 font-medium text-xs disabled:opacity-60" disabled={!pr.canPush || isRunning} onClick={rerun}>
        {t('pr.checks.rerun')}
      </Button>
    </span>
  );
}

// workflows awaiting approval with no check run (#854, handoff item 11): ◷ in muted, the text, the list
function AwaitingChecks({ workflows, url }: { workflows: string[]; url?: string }) {
  return (
    <section aria-label={t('prs.col.checks')} className="flex max-w-[680px] flex-col rounded-lg border text-xs">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span aria-hidden="true" className="text-muted-foreground">◷</span>
        <span className="font-medium">{t('pr.checks.awaiting')}</span>
        <span className="flex-1" />
        {url !== undefined && <a href={url} target="_blank" rel="noreferrer" className="text-muted-foreground">{t('repos.menu.open')}</a>}
      </header>
      <p className="px-3 pt-2 text-muted-foreground leading-[18px]">{t('pr.checks.awaitingText', { n: workflows.length, repo: url === undefined ? '' : prRepo(url) })}</p>
      <ul className="flex flex-col gap-1 px-3 py-2">
        {workflows.map((name) => <li key={name} className="flex items-center gap-2"><span aria-hidden="true" className="text-muted-foreground">◷</span>{name}</li>)}
      </ul>
    </section>
  );
}

/** checks (#758, handoff 03): a bordered box; its header counts the head commit's checks that passed of all, says how many failed or are
 * pending when any, and the latest completion; then each check with its mark, linking to its page on GitHub. Hidden while there are none. */
export function PrChecks({ checks, pr, onChanged }: { checks?: Checks; pr?: PrRef; onChanged?(): void }) {
  if (checks === undefined) return null;
  if (checks.items.length === 0 && (checks.awaiting?.length ?? 0) > 0) return <AwaitingChecks workflows={checks.awaiting ?? []} url={pr?.url} />;
  const [failed, pending] = [count(checks, 'failure'), count(checks, 'pending')];
  const head = MARK[worstOf(failed, pending)];
  return (
    <section aria-label={t('prs.col.checks')} className="flex max-w-[680px] flex-col rounded-lg border text-xs">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <span aria-hidden="true" className={head.tone}>{head.mark}</span>
        <span className="font-medium">{t('pr.checks.passed', { n: count(checks, 'success'), m: checks.items.length })}</span>
        {failed > 0 && <span className="text-destructive">{`· ${t('pr.checks.failed', { n: failed })}`}</span>}
        {pending > 0 && <span className="text-waiting">{`· ${t('pr.checks.pending', { n: pending })}`}</span>}
        <span className="flex-1" />
        {failed > 0 && pr && <RerunButton pr={pr} onChanged={onChanged} />}
        {checks.at !== undefined && <span className="text-muted-foreground">{relativeTime(checks.at)}</span>}
      </header>
      <ul className="flex flex-col gap-1 px-3 py-2">
        {checks.items.map((check) => (
          <li key={`${check.name}${check.url ?? ''}`} className="flex items-center gap-2">
            <span aria-hidden="true" className={MARK[check.state].tone}>{MARK[check.state].mark}</span>
            {check.url === undefined ? <span>{check.name}</span> : <a href={check.url} target="_blank" rel="noreferrer" className="hover:underline">{check.name}</a>}
          </li>
        ))}
      </ul>
      {failed > 0 && pr && !pr.canPush && (
        <p className="border-t px-3 pt-1.5 pb-2 text-muted-foreground leading-[18px]">{t('pr.checks.rerunBand', { repo: prRepo(pr.url) })}</p>
      )}
    </section>
  );
}
