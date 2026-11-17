// What the new source dialog and the source detail share for a Jira source (#822)
import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { clock } from '@/hooks/use-project';
import { type MessageKey, t } from '@/i18n';
import type { JiraProject, JiraReadError } from '@/lib/settings-jira';

const FIELD = 'flex flex-col gap-2'; // SourceDetail's label-over-control cell
const NOTICE = 'text-xs';

export interface JiraChoice { value: string; label: string }
export const asChoices = (values: readonly string[]): JiraChoice[] => values.map((value) => ({ value, label: value }));
export const projectLabel = (project: JiraProject): string => `${project.key} · ${project.name}`;

interface JiraSelectProps { id: string; label: MessageKey; value: string; choices: readonly JiraChoice[]; placeholder?: MessageKey; anchor?: string; onPick(value: string): void }

export function JiraSelect({ id, label, value, choices, placeholder, anchor, onPick }: JiraSelectProps): ReactNode {
  return (
    <div id={anchor} className={FIELD}>
      <Label htmlFor={id}>{t(label)}</Label>
      <Select value={value} onValueChange={onPick}>
        <SelectTrigger id={id} className="w-full"><SelectValue placeholder={placeholder === undefined ? undefined : t(placeholder)} /></SelectTrigger>
        <SelectContent>
          {choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ConnectionsLink({ onClick }: { onClick(): void }): ReactNode {
  return <button type="button" className="text-review" onClick={onClick}>{t('settings.source.jira.openConnections')}</button>;
}

/** No connected site (#822): the line and its link to connections; no connect form here, the one form lives in connections (#817). */
export function JiraNoSite({ onOpenConnections }: { onOpenConnections(): void }): ReactNode {
  return <p className={`${NOTICE} text-muted-foreground`}><span>{t('settings.source.jira.noSite')}</span> · <ConnectionsLink onClick={onOpenConnections} /></p>;
}

/** A failed read, inline next to its control, never a toast (#822): its message in its own span, so the link sits beside it. */
export function JiraReadNotice({ error, onOpenConnections }: { error?: JiraReadError; onOpenConnections(): void }): ReactNode {
  if (error === undefined) return null;
  if (error.kind === 'not-connected') {
    return <p role="alert" className={`${NOTICE} text-destructive`}><span>{t('settings.source.jira.error.notConnected')}</span> · <ConnectionsLink onClick={onOpenConnections} /></p>;
  }
  const time = error.kind === 'rate-limited' ? clock(error.resetsAt) : '';
  // An unreadable reset reads empty (clock), and "try again at " would end on nothing
  const text = error.kind === 'rate-limited' ? (time === '' ? t('settings.source.jira.error.rateLimitedNoTime') : t('settings.source.jira.error.rateLimited', { time })) : t('settings.source.jira.error.failed');
  return <p role="alert" className={`${NOTICE} text-destructive`}>{text}</p>;
}
