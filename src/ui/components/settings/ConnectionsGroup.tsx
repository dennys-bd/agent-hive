import { useState } from 'react';
import { JiraConnections } from '@/components/settings/JiraConnections';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useJiraSites } from '@/hooks/use-jira-sites';
import { t } from '@/i18n';
import { settingAnchor } from '@/lib/settings-search';
import type { GithubAuth, GithubAuthStatus } from '../../../types';

export interface GithubRowProps { auth: GithubAuth; github?: GithubAuthStatus; sourceNames: string[]; onConnect(): void; onAuthChange(auth: GithubAuth): void; onOpenQuota(): void }

// The status half of the row's one line (#524): gh CLI is detected, the Hive login is pending, connected as @login or not yet.
function statusText(auth: GithubAuth, github?: GithubAuthStatus): string {
  if (auth === 'cli') return t('settings.connections.detected');
  if (github?.pending) return t('settings.auth.pending', { url: github.pending.verificationUri });
  return github?.connected ? t('settings.auth.connected', { login: github.login ?? '' }) : t('settings.auth.disconnected');
}

function GithubActions({ auth, github, onConnect, onAuthChange }: Omit<GithubRowProps, 'sourceNames' | 'onOpenQuota'>) {
  const action = (label: string, onClick: () => void) => <Button type="button" variant="ghost" size="sm" onClick={onClick}>{label}</Button>;
  if (auth === 'cli') return action(t('settings.connections.signIn'), () => onAuthChange('api'));
  return (
    <div className="flex items-center gap-1">
      {!github?.pending && action(t(github?.connected ? 'settings.auth.reconnect' : 'settings.auth.connect'), onConnect)}
      {action(t('settings.connections.useCli'), () => onAuthChange('cli'))}
    </div>
  );
}

// The one row the Hive can reach today, laid out like the sources rows (#524): name, badge and one status line, the action on the right.
// gh CLI needs no connect step, so "entrar com GitHub" only switches the mode to api and lets an existing token show at once;
// "usar gh CLI" switches back.
function GithubRow({ auth, github, sourceNames, onConnect, onAuthChange, onOpenQuota }: GithubRowProps) {
  const line = `${statusText(auth, github)} · ${t('settings.connections.usedBy', { sources: sourceNames.join(', ') })}`;
  return (
    <div data-testid="connection-row" className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-4 border-t px-5 py-3">
      <span className="font-medium text-sm">{t('settings.connections.github')}</span>
      <div className="flex min-w-0 items-center gap-3">
        <Badge variant="secondary">{t(auth === 'cli' ? 'settings.auth.cli' : 'settings.auth.api')}</Badge>
        <div className="flex min-w-0 flex-col">
          <span className="text-muted-foreground text-xs">
            <span>{line}</span> · <button type="button" className="text-review" onClick={onOpenQuota}>{t('settings.connections.quota')}</button>
          </span>
          {auth === 'api' && github?.pending && <code className="select-all font-mono text-xs">{github.pending.userCode}</code>}
          {auth === 'api' && github?.error && <span className="text-destructive text-xs">{github.error}</span>}
        </div>
      </div>
      <GithubActions auth={auth} github={github} onConnect={onConnect} onAuthChange={onAuthChange} />
    </div>
  );
}

// a source's detail links here (#524): its connection line opens the list scrolled to this group
export const CONNECTIONS_ANCHOR = settingAnchor('settings.connections');

/** The flow list's connections card, scrolled to once the list has rendered (#524, #822): the detail's change link and the dialog's no-site link. */
export const scrollToConnections = (): void => { requestAnimationFrame(() => document.getElementById(CONNECTIONS_ANCHOR)?.scrollIntoView({ block: 'start' })); };

export interface ConnectionsGroupProps { githubRow?: GithubRowProps } // GitHub's row only when a GitHub source exists (#817)

/** conexões (#524): one row per service the Hive can reach. The card always renders (#817): GitHub's row only when a GitHub source exists,
 * then one row per connected Jira site. `+ conexão` opens the Jira form, the only service that connects from here. */
export function ConnectionsGroup({ githubRow }: ConnectionsGroupProps) {
  const jira = useJiraSites();
  const [isFormOpen, setFormOpen] = useState(false);
  const isEmpty = githubRow === undefined && jira.sites?.length === 0 && !isFormOpen;
  return (
    <SettingsGroup
      title="settings.connections" hint="settings.connections.hint" flush
      action={<Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(true)}>{t('settings.connections.add')}</Button>}
    >
      {isEmpty && <p className="border-t px-5 py-3 text-muted-foreground text-xs">{t('settings.connections.empty')}</p>}
      {githubRow && <GithubRow {...githubRow} />}
      <JiraConnections jira={jira} isFormOpen={isFormOpen} onFormOpen={setFormOpen} />
    </SettingsGroup>
  );
}
