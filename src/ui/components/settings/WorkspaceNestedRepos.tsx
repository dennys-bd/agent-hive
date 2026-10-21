import { FolderGit2Icon, XIcon } from 'lucide-react';
import { useId } from 'react';
import type { NestedProblem, NestedRepoRead } from '../../../types';
import { StatusLine } from '@/components/settings/ForkSyncStatus';
import { Suggestion } from '@/components/settings/WorkspaceFork';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNestedRepos } from '@/hooks/use-nested-repos';
import { t } from '@/i18n';
import type { WorkspaceDraft } from '@/lib/settings-form';
import { type NestedRepoDraft, nestedPaths } from '@/lib/settings-nested';

const HINT = 'text-muted-foreground text-xs';
const newRow = (path: string): NestedRepoDraft => ({ id: crypto.randomUUID(), path });
const problemLines = (path: string, { cause, root = '' }: NestedProblem) =>
  ({ first: t(`settings.nested.problem.${cause}`, { path, root }), second: t(`settings.nested.problem.${cause}.fix`, { path, root }) });
// What the Hive read of a listed path: its GitHub repository, then the base its branches start from
const readLine = (read: NestedRepoRead | undefined): string =>
  [read?.repository, read?.base === undefined ? undefined : t('settings.nested.base', { base: read.base })].filter((part) => part !== undefined).join(' · ');

interface RowProps { draft: NestedRepoDraft; n: number; read?: NestedRepoRead; onPath(path: string): void; onRemove(): void }

// One nested repo (tweak configurado / inválido): the mono path, what the Hive read or the cause and its fix, and the ghost ×
function NestedRow({ draft, n, read, onPath, onRemove }: RowProps) {
  const id = useId();
  const path = draft.path.trim();
  const problem = read?.problem;
  return (
    <div className="grid grid-cols-[12.5rem_minmax(0,1fr)_auto] items-start gap-3">
      <Input
        aria-label={t('settings.nested.path', { n })} className="font-mono" value={draft.path} placeholder="docs"
        aria-invalid={problem ? true : undefined} aria-describedby={problem ? `${id}-problem` : undefined} onChange={(e) => onPath(e.target.value)}
      />
      {problem ? <StatusLine id={`${id}-problem`} ok={false} {...problemLines(path, problem)} /> : <span className={`pt-2 ${HINT}`}>{readLine(read)}</span>}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t('settings.nested.remove', { path })} onClick={onRemove}><XIcon /></Button>
    </div>
  );
}

export interface WorkspaceNestedReposProps { row: WorkspaceDraft; oldSetup?: string; flagId: string; onChange(patch: Partial<WorkspaceDraft>): void }

/** Settings › workspaces › repos aninhados (#653): the Hive's suggestions, one row per nested repo, `+ repo aninhado`, and the old setup line
 * flag (oldSetup, the path it names) whose id the setup textarea points at. What the Hive read comes from GET /settings/nested-repos, never
 * the draft; a suggestion already listed or dismissed is not shown. */
export function WorkspaceNestedRepos({ row, oldSetup, flagId, onChange }: WorkspaceNestedReposProps) {
  const paths = nestedPaths(row);
  const answer = useNestedRepos(row.path, paths);
  const shown = answer.suggested.filter((s) => !paths.includes(s.path) && !row.notNestedRepos.includes(s.path));
  const setRows = (nestedRepos: NestedRepoDraft[]): void => onChange({ nestedRepos });
  return (
    <div className="flex flex-col gap-3">
      {shown.map((s) => (
        <Suggestion
          key={s.path} icon={FolderGit2Icon} line={t('settings.nested.found', { path: `${s.path}/` })} mono={`${s.path}/`}
          hint={[s.repository, t('settings.nested.suggestion')].filter((part) => part !== undefined).join(' · ')}
          dismiss={t('settings.nested.dismiss')} accept={t('settings.nested.accept')}
          onDismiss={() => onChange({ notNestedRepos: [...row.notNestedRepos, s.path] })} onAccept={() => setRows([...row.nestedRepos, newRow(s.path)])}
        />
      ))}
      {row.nestedRepos.map((draft, i) => (
        <NestedRow
          key={draft.id} draft={draft} n={i + 1} read={answer.repos.find((r) => r.path === draft.path.trim())}
          onPath={(path) => setRows(row.nestedRepos.map((r) => (r.id === draft.id ? { ...r, path } : r)))} onRemove={() => setRows(row.nestedRepos.filter((r) => r.id !== draft.id))}
        />
      ))}
      {oldSetup !== undefined && <StatusLine id={flagId} ok={false} first={t('settings.nested.oldSetup', { path: oldSetup })} second={t('settings.nested.oldSetup.fix')} />}
      <div><Button type="button" variant="ghost" size="sm" onClick={() => setRows([...row.nestedRepos, newRow('')])}>{t('settings.nested.add')}</Button></div>
    </div>
  );
}
