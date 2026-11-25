import { useId, useState } from 'react';
import { Done, FailedLine, HeaderAdd, TextButton } from '@/components/settings/AccountAdd';
import { GitlabConnectForm } from '@/components/settings/GitlabConnectForm';
import { RemoveAction } from '@/components/settings/RemoveAction';
import { Spinner } from '@/components/ui/spinner';
import { type GitlabAccounts, useGitlabAccounts } from '@/hooks/use-gitlab-accounts';
import { t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';
import type { GitlabAccountRow } from '../../../types';

// Settings › execution › accounts › gitlab (#1048): the stored GitLab accounts, one per host. No radio: no selection points at one, so the rows
// only show and remove, and a remove is always allowed. The header's add opens the connect form at the group's foot, as Claude's add does.

interface GitlabAccountsGroupProps { hosts: readonly string[] } // the saved config's gitlabHosts: the form's choices after gitlab.com

// GitLab's tokens stop at 00:00 UTC of their expires_at day, so that day already reads as expired
const isExpired = (expiresAt: string, now: Date): boolean => expiresAt <= now.toISOString().slice(0, 10);

function ExpiryNote({ expiresAt }: { expiresAt?: string }) {
  if (expiresAt === undefined) return null;
  if (isExpired(expiresAt, new Date())) return <span className="shrink-0 text-waiting text-xs">{t('settings.accounts.gitlab.expired')}</span>;
  return <span className="shrink-0 text-muted-foreground text-xs">{t('settings.accounts.gitlab.expires', { date: expiresAt })}</span>;
}

// The other groups' row grid, with the host where their radio's label sits
function AccountItem({ row, onRemove }: { row: GitlabAccountRow; onRemove(): Promise<boolean> }) {
  return (
    <li className="flex min-h-8 items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <span className="whitespace-nowrap text-sm">{row.host}</span>
      <span className="truncate text-muted-foreground text-xs">{row.username}</span>
      <ExpiryNote expiresAt={row.expiresAt} />
      <span className="ml-auto flex shrink-0 items-center"><RemoveAction name={row.host} onRemove={onRemove} /></span>
    </li>
  );
}

// The rows, and under them a remove that failed, with its retry
function AccountList({ nameId, accounts }: { nameId: string; accounts: GitlabAccounts }) {
  const [failedHost, setFailedHost] = useState<string>();
  const remove = async (host: string): Promise<boolean> => {
    setFailedHost(undefined);
    const isRemoved = await accounts.remove(host);
    if (!isRemoved) setFailedHost(host);
    return isRemoved;
  };
  const rows = accounts.accounts ?? [];
  return (
    <>
      {rows.length > 0 && (
        <ul aria-labelledby={nameId} className="-mx-2 flex flex-col gap-0.5">
          {rows.map((row) => <AccountItem key={row.host} row={row} onRemove={() => remove(row.host)} />)}
        </ul>
      )}
      {failedHost !== undefined && (
        <FailedLine text={t('settings.accounts.remove.failed', { name: failedHost })}>
          <TextButton onClick={() => { void remove(failedHost); }}>{t('settings.accounts.retry')}</TextButton>
        </FailedLine>
      )}
    </>
  );
}

export function GitlabAccountsGroup({ hosts }: GitlabAccountsGroupProps) {
  const nameId = useId();
  const accounts = useGitlabAccounts();
  const [isFormOpen, setFormOpen] = useState(false);
  const [added, setAdded] = useState<string>(); // the screen reader's announcement; the eye sees the new row
  const isLoading = !accounts.isFailed && accounts.accounts === undefined;
  const open = (): void => { setAdded(undefined); setFormOpen(true); };
  const connected = (row: GitlabAccountRow): void => { setFormOpen(false); setAdded(`${row.username} · ${row.host}`); };
  return (
    <div id={settingAnchor('settings.accounts', 'gitlab')} className="flex flex-col gap-3 border-t px-5 py-4 first:border-t-0">
      <div className="flex min-h-8 items-center gap-3">
        <span id={nameId} className="font-semibold text-sm">{t('settings.accounts.gitlab')}</span>
        <HeaderAdd label="settings.accounts.add.gitlab" name={t('settings.accounts.add.gitlab.name')} isHidden={isFormOpen} onClick={open} />
      </div>
      {isLoading && <p role="status" className="flex items-center gap-1.5 text-muted-foreground text-xs"><Spinner />{t('settings.accounts.loading')}</p>}
      {accounts.isFailed && (
        <FailedLine text={t('settings.accounts.failed.gitlab')}>
          <TextButton onClick={accounts.refetch}>{t('settings.accounts.retry')}</TextButton>
        </FailedLine>
      )}
      <AccountList nameId={nameId} accounts={accounts} />
      {isFormOpen && <GitlabConnectForm hosts={hosts} onSubmit={accounts.connect} onConnected={connected} onClose={() => setFormOpen(false)} />}
      <Done name={added} />
    </div>
  );
}
