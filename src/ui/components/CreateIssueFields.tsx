import { PlusIcon, XIcon } from 'lucide-react';
import { CreateField as Field } from '@/components/CreateField';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CreateDraft, OptionsEntry } from '@/hooks/use-create-draft';
import { t } from '@/i18n';
import { type CreateTargets, repositoryLabel } from '@/lib/create-targets';

// Radix items cannot carry null: fora do project has a value no Status option can have, as NO_FLOW does in CreateTaskDialog
const OFF_PROJECT = '\u0000off-project';

export interface CreateIssueFieldsProps {
  draft: CreateDraft; sources: CreateTargets['sources']; options: OptionsEntry | undefined;
  onRetry(): void; onSource(source: string): void; onStatus(status: string | null): void; onAddLabel(label: string): void; onRemoveLabel(label: string): void;
}

function RepositoryMenu({ sources, value, onPick }: { sources: CreateTargets['sources']; value?: string; onPick(source: string): void }) {
  return (
    <Select value={value} onValueChange={onPick}>
      <SelectTrigger id="create-repository" className="w-full font-mono"><SelectValue /></SelectTrigger>
      <SelectContent>
        {sources.map((s) => <SelectItem key={s.name} value={s.name}>{repositoryLabel(s, sources)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function StatusMenu({ entry, value, onPick }: { entry: OptionsEntry | undefined; value: string | null | undefined; onPick(status: string | null): void }) {
  const statuses = entry?.state === 'ready' ? entry.options.statuses : [];
  return (
    <Select disabled={entry?.state !== 'ready'} value={value === null ? OFF_PROJECT : value} onValueChange={(v) => onPick(v === OFF_PROJECT ? null : v)}>
      <SelectTrigger id="create-status" className="w-full"><SelectValue placeholder={entry?.state === 'loading' ? t('create.loading') : undefined} /></SelectTrigger>
      <SelectContent>
        {statuses.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
        <SelectSeparator />
        <SelectItem value={OFF_PROJECT}>{t('create.offProject')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface LabelChipsProps { entry: OptionsEntry | undefined; repository: string; picked: string[]; onAdd(label: string): void; onRemove(label: string): void }

function LabelChips({ entry, repository, picked, onAdd, onRemove }: LabelChipsProps) {
  const left = entry?.state === 'ready' ? entry.options.labels.filter((l) => !picked.includes(l)) : [];
  return (
    <fieldset id="create-labels" className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="mb-1 font-normal text-[13px] text-muted-foreground">{t('create.labels')}</legend>
      {picked.map((label) => (
        <Badge key={label} variant="outline">
          {label}
          <button type="button" aria-label={t('create.removeLabel', { label })} onClick={() => onRemove(label)}><XIcon className="size-3" /></button>
        </Badge>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="xs" disabled={left.length === 0}>
            {entry?.state === 'loading' ? t('create.loading') : <><PlusIcon />{t('create.addLabel')}</>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t('create.labelsOf', { repository })}</DropdownMenuLabel>
          {left.map((label) => <DropdownMenuItem key={label} onSelect={() => onAdd(label)}>{label}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </fieldset>
  );
}

/** The issue form (#772): repositório, status and labels of the source's create options, with the loading state and the retry line. */
export function CreateIssueFields({ draft, sources, options, onRetry, onSource, onStatus, onAddLabel, onRemoveLabel }: CreateIssueFieldsProps) {
  const repository = sources.find((s) => s.name === draft.source)?.repository ?? '';
  return (
    <>
      <Field id="create-repository" label={t('create.repository')} hint={t('create.repositoryHint')}>
        <RepositoryMenu sources={sources} value={draft.source} onPick={onSource} />
      </Field>
      <Field id="create-status" label={t('create.status')} note={t('create.onProject')}>
        <StatusMenu entry={options} value={draft.status} onPick={onStatus} />
      </Field>
      <LabelChips entry={options} repository={repository} picked={draft.labels} onAdd={onAddLabel} onRemove={onRemoveLabel} />
      {options?.state === 'failed' && (
        <p className="text-destructive text-xs">
          {t('create.optionsFailed', { repository })}{' '}
          <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={onRetry}>{t('create.retry')}</Button>
        </p>
      )}
    </>
  );
}
