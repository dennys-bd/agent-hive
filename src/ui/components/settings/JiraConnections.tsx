import { useState } from 'react';
import { DialogBase } from '@/components/DialogBase';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { JiraSites } from '@/hooks/use-jira-sites';
import { t } from '@/i18n';
import type { JiraSiteStatus } from '../../../types';
import { JiraConnectForm } from './JiraConnectForm';
import { JIRA_FORM_KEYS, STATE_KEY } from './jira-keys';

export { JIRA_FORM_KEYS, REFUSAL_KEY, REFUSAL_RECONNECT_KEY, STATE_KEY } from './jira-keys';

// connected is plain muted, refused is the one failure, unreachable is transient (the login stays saved) so it takes `waiting`
const STATE_TONE: Record<JiraSiteStatus['state'], string> = { connected: 'text-muted-foreground', refused: 'text-destructive', unreachable: 'text-waiting' };

function statusLine({ site, state, name }: JiraSiteStatus): string {
  const parts = [site, t(STATE_KEY[state], { name: name ?? '' })];
  if (state === 'unreachable') parts.push(t('settings.connections.jira.loginKept'));
  return parts.join(' · ');
}

interface SiteRowProps { status: JiraSiteStatus; onReconnect(): void; onDisconnect(): void }

function SiteRow({ status, onReconnect, onDisconnect }: SiteRowProps) {
  return (
    <div data-testid="jira-site" className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-4 border-t px-5 py-3">
      <span className="font-medium text-sm">{t('settings.connections.jira')}</span>
      <div className="flex min-w-0 items-center gap-3">
        <Badge variant="secondary">{t('settings.connections.jira.badge')}</Badge>
        <span className={`truncate text-xs ${STATE_TONE[status.state]}`}>{statusLine(status)}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onReconnect}>{t(JIRA_FORM_KEYS.reconnect)}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDisconnect}>{t(JIRA_FORM_KEYS.disconnect)}</Button>
      </div>
    </div>
  );
}

interface JiraConnectionsProps { jira: JiraSites; isFormOpen: boolean; onFormOpen(open: boolean): void }

/** The Jira part of Settings › connections (#817): one row per site, the connect form at the card's foot, a reconnect form in place of its
 * row, and a dialog before a disconnect. */
export function JiraConnections({ jira, isFormOpen, onFormOpen }: JiraConnectionsProps) {
  const [reconnecting, setReconnecting] = useState<string>();
  const [leaving, setLeaving] = useState<string>();
  const closeReconnect = (): void => setReconnecting(undefined);
  return (
    <>
      {(jira.sites ?? []).map((status) => status.site === reconnecting
        ? <JiraConnectForm key={status.site} site={status.site} onSubmit={jira.connect} onClose={closeReconnect} />
        : <SiteRow key={status.site} status={status} onReconnect={() => setReconnecting(status.site)} onDisconnect={() => setLeaving(status.site)} />)}
      {isFormOpen && <JiraConnectForm onSubmit={jira.connect} onClose={() => onFormOpen(false)} />}
      {leaving !== undefined && (
        <DialogBase
          open onOpenChange={(open) => { if (!open) setLeaving(undefined); }} title={t('settings.connections.jira.offTitle', { site: leaving })}
          primary={{ label: t(JIRA_FORM_KEYS.disconnect), onConfirm: () => jira.disconnect(leaving) }}
        >
          <p className="text-muted-foreground text-sm">{t('settings.connections.jira.offMessage')}</p>
        </DialogBase>
      )}
    </>
  );
}
