import { type FormEvent, type KeyboardEvent, useId, useState } from 'react';
import { FailedLine } from '@/components/settings/AccountAdd';
import { Field } from '@/components/settings/JiraConnectForm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import type { GitlabConnectOutcome, GitlabRefusal } from '@/hooks/use-gitlab-accounts';
import { type MessageKey, t } from '@/i18n';
import { GITLAB_HOST } from '../../../repo-host';
import type { GitlabAccountRow } from '../../../types';

/** A refusal in our words, by the route's code; failed when it named none (#1048). */
export const GITLAB_REFUSAL_KEY: Record<GitlabRefusal, MessageKey> = {
  host: 'settings.accounts.gitlab.refused.host', token: 'settings.accounts.gitlab.refused.token', refused: 'settings.accounts.gitlab.refused.refused',
  scope: 'settings.accounts.gitlab.refused.scope', unverifiable: 'settings.accounts.gitlab.refused.unverifiable',
  unreachable: 'settings.accounts.gitlab.refused.unreachable', unknown: 'settings.accounts.gitlab.refused.unknown', failed: 'settings.accounts.gitlab.refused.failed',
};

/** Where the token is made on a host: GitLab prefills its name and the api scope from the query. */
export const gitlabTokenUrl = (host: string): string => `https://${host}/-/user_settings/personal_access_tokens?name=Agent%20Hive&scopes=api`;

interface GitlabConnectFormProps {
  hosts: readonly string[]; // the saved gitlabHosts, offered after gitlab.com: a new host is added and saved there first
  onSubmit(host: string, token: string): Promise<GitlabConnectOutcome>;
  onConnected(row: GitlabAccountRow): void;
  onClose(): void;
}

function HostSelect({ id, hosts, value, onChange }: { id: string; hosts: readonly string[]; value: string; onChange(host: string): void }) {
  return (
    <Field id={id} label={t('settings.accounts.gitlab.host')} hint={t('settings.accounts.gitlab.hostHint')}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="h-8 w-[260px]"><SelectValue /></SelectTrigger>
        <SelectContent>{[GITLAB_HOST, ...hosts].map((host) => <SelectItem key={host} value={host}>{host}</SelectItem>)}</SelectContent>
      </Select>
    </Field>
  );
}

const tokenHint = (host: string) => (
  <>
    {t('settings.accounts.gitlab.tokenHint')} ·{' '}
    <a href={gitlabTokenUrl(host)} target="_blank" rel="noreferrer" className="text-review">{t('settings.accounts.gitlab.tokenLink')}</a>
  </>
);

/** GitLab's connect (#1048), inline at the group's foot. The token lives only in this state and is cleared after every submit; a refusal keeps
 * the form open on the host chosen, worded under the fields. */
export function GitlabConnectForm({ hosts, onSubmit, onConnected, onClose }: GitlabConnectFormProps) {
  const id = useId();
  const [host, setHost] = useState<string>(GITLAB_HOST);
  const [token, setToken] = useState('');
  const [isPending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<GitlabRefusal>();
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (isPending) return;
    setPending(true);
    setRefusal(undefined);
    const outcome = await onSubmit(host, token);
    setToken('');
    if ('row' in outcome) return onConnected(outcome.row); // the group closes this form; the hook has re-read the list
    setPending(false);
    setRefusal(outcome.error);
  };
  // Settings' own Escape, on document, skips a prevented key; a running connect would store with no form left to show it
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || isPending) return;
    event.preventDefault();
    onClose();
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <div className={`flex flex-col gap-3 ${isPending ? 'pointer-events-none opacity-60' : ''}`}>
        <HostSelect id={`${id}-host`} hosts={hosts} value={host} onChange={setHost} />
        <Field id={`${id}-token`} label={t('settings.accounts.gitlab.token')} hint={tokenHint(host)}>
          <Input
            id={`${id}-token`} type="password" autoComplete="off" autoFocus value={token} aria-describedby={`${id}-token-hint`}
            aria-invalid={refusal === undefined ? undefined : true} className="h-8 w-[260px]" onChange={(e) => setToken(e.target.value)} onKeyDown={onKeyDown}
          />
        </Field>
      </div>
      {refusal !== undefined && <FailedLine text={t(GITLAB_REFUSAL_KEY[refusal])} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>{t('settings.accounts.add.cancel')}</Button>
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? <><Spinner /> {t('settings.accounts.gitlab.connecting')}</> : t('settings.accounts.gitlab.connect')}
        </Button>
      </div>
    </form>
  );
}
