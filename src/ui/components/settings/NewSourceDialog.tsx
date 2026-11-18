import { useEffect, useId, useState } from 'react';
import { NewJiraSourceFields } from '@/components/settings/NewJiraSourceFields';
import { WorkspaceSelect } from '@/components/WorkspaceSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useGithubNewSource } from '@/hooks/use-github-new-source';
import { useNewJiraSource } from '@/hooks/use-new-jira-source';
import { type MessageKey, t } from '@/i18n';
import { NEW_SOURCE_TYPES, newSourceDraft, newSourceProblem, type NewSource } from '@/lib/flow-sources';
import type { JiraProject } from '@/lib/settings-jira';
import { workspaceNameFor } from '../../../tasks';
import type { GithubAuth, ProjectSummary, SourceFields } from '../../../types';

interface NewSourceDialogProps {
  open: boolean; auth: GithubAuth; workspaces: string[]; takenNames: string[]; flowId: string; // #670: the first flow's id, where a new source enters
  onOpenChange(open: boolean): void; onAdd(added: NewSource): void;
  onOpenConnections(): void; // #822: the no-site line's link
}

interface ProjectFieldsProps {
  id: string; owner: string; projects: ProjectSummary[]; number: string; loading: boolean;
  onOwnerChange(owner: string): void; onLoad(): void; onPick(number: string): void;
}

// The owner + carregar and the project select (#514): a small group so NewSourceDialog stays under 50 lines.
function ProjectFields({ id, owner, projects, number, loading, onOwnerChange, onLoad, onPick }: ProjectFieldsProps) {
  return (
    <>
      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={`${id}-owner`}>{t('settings.owner')}</Label>
          <Input id={`${id}-owner`} value={owner} onChange={(e) => onOwnerChange(e.target.value)} />
        </div>
        <Button type="button" variant="outline" disabled={loading} onClick={onLoad}>{t('settings.load')}</Button>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-project`}>{t('settings.project')}</Label>
        <Select value={number} onValueChange={onPick}>
          <SelectTrigger id={`${id}-project`} className="w-full"><SelectValue placeholder={t('settings.projectPlaceholder')} /></SelectTrigger>
          <SelectContent>
            {projects.map((p) => <SelectItem key={p.number} value={String(p.number)}>{`#${p.number} ${p.title}`}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </>
  );
}

function TypeToggle({ type, onChange }: { type: SourceFields['type']; onChange(type: SourceFields['type']): void }) {
  return (
    <div className="flex flex-col gap-1">
      <Label>{t('newSource.type')}</Label>
      {/* Radix answers '' on a re-click of the checked item: that keeps the type */}
      <ToggleGroup type="single" variant="outline" className="w-full" value={type} onValueChange={(v) => { if (v === 'github' || v === 'jira') onChange(v); }}>
        {NEW_SOURCE_TYPES.map((item) => <ToggleGroupItem key={item} value={item} className="flex-1">{t(`settings.sources.type.${item}` as MessageKey)}</ToggleGroupItem>)}
      </ToggleGroup>
    </div>
  );
}

interface NameFieldsProps {
  id: string; type: SourceFields['type']; name: string; workspace: string; workspaces: string[];
  onName(name: string): void; onWorkspace(workspace: string): void;
}

function NameFields({ id, type, name, workspace, workspaces, onName, onWorkspace }: NameFieldsProps) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-name`}>{t('newSource.name')}</Label>
        <Input id={`${id}-name`} value={name} onChange={(e) => onName(e.target.value)} />
        <p className="text-muted-foreground text-xs">{t(type === 'jira' ? 'newSource.nameHint.jira' : 'newSource.nameHint')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <WorkspaceSelect id={`${id}-workspace`} label={t('newSource.workspace')} workspaces={workspaces} value={workspace === '' ? undefined : workspace} fill onChange={(v) => onWorkspace(v ?? '')} />
        <p className="text-muted-foreground text-xs">{t('newSource.workspaceHint')}</p>
      </div>
    </div>
  );
}

function NewSourceHeader() {
  return (
    <DialogHeader>
      <DialogTitle>{t('newSource.title')}</DialogTitle>
      <DialogDescription className="text-xs">{t('newSource.description')}</DialogDescription>
    </DialogHeader>
  );
}

function NewSourceFooter({ canAdd, onCancel, onAdd }: { canAdd: boolean; onCancel(): void; onAdd(): void }) {
  return (
    <DialogFooter>
      <Button type="button" variant="outline" onClick={onCancel}>{t('settings.cancel')}</Button>
      <Button type="button" disabled={!canAdd} onClick={onAdd}>{t('newSource.add')}</Button>
    </DialogFooter>
  );
}

/** The new-source dialog (#514): it never writes the config on its own. A source no stage enters from is refused by the parser
 * (parseStages), so this hands the row to Settings, which saves it with the rest once a stage feeds it. */
export function NewSourceDialog({ open, auth, workspaces, takenNames, flowId, onOpenChange, onAdd, onOpenConnections }: NewSourceDialogProps) {
  const id = useId();
  const [type, setType] = useState<SourceFields['type']>('github');
  const jira = useNewJiraSource();
  const github = useGithubNewSource(auth);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [workspace, setWorkspace] = useState(workspaces[0] ?? '');

  // A fresh instance every time the dialog opens (#514): never carries over the last source it added.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to `open` turning true only; workspaces is read fresh on that run
  useEffect(() => {
    if (!open) return;
    github.reset(); setName(''); setNameTouched(false); setWorkspace(workspaces[0] ?? '');
    setType('github'); jira.reset();
  }, [open]);

  // The name follows the picked project until the user types their own
  const suggest = (title: string): void => { if (!nameTouched) setName(workspaceNameFor(title)); };
  function pick(picked: string): void { github.setNumber(picked); suggest(github.projects.find((p) => String(p.number) === picked)?.title ?? ''); }
  function pickJira(picked: JiraProject): void { jira.pickProject(picked); suggest(picked.name); }

  function add(): void {
    const fields = { type, owner: github.owner, number: github.number, jira: jira.jira, name, workspace };
    const problem = newSourceProblem(fields, takenNames);
    if (problem) { github.setError(problem); return; }
    onAdd({ source: newSourceDraft(fields, flowId), projects: type === 'github' ? github.projects : [] });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <NewSourceHeader />
        <TypeToggle type={type} onChange={setType} />
        {type === 'github'
          ? <ProjectFields id={id} owner={github.owner} projects={github.projects} number={github.number} loading={github.loading} onOwnerChange={github.setOwner} onLoad={() => void github.load()} onPick={pick} />
          : <NewJiraSourceFields id={id} source={jira} onPickProject={pickJira} onOpenConnections={onOpenConnections} />}
        <NameFields id={id} type={type} name={name} workspace={workspace} workspaces={workspaces} onName={(v) => { setName(v); setNameTouched(true); }} onWorkspace={setWorkspace} />
        {github.error && <p role="alert" className="text-destructive text-sm">{github.error}</p>}
        <NewSourceFooter canAdd={type === 'github' || jira.isReady} onCancel={() => onOpenChange(false)} onAdd={add} />
      </DialogContent>
    </Dialog>
  );
}
