import { useEffect, useId, useState } from 'react';
import { WorkspaceSelect } from '@/components/WorkspaceSelect';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type MessageKey, t } from '@/i18n';
import { getJson } from '@/lib/api';
import { NEW_SOURCE_TYPES, newSourceDraft, newSourceProblem, type NewSource } from '@/lib/flow-sources';
import { projectsUrl } from '@/lib/settings-form';
import { workspaceNameFor } from '../../../tasks';
import type { GithubAuth, ProjectSummary } from '../../../types';

interface NewSourceDialogProps {
  open: boolean; auth: GithubAuth; workspaces: string[]; takenNames: string[];
  onOpenChange(open: boolean): void; onAdd(added: NewSource): void;
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

const DEFAULT_OWNER = '@me';

/** The new-source dialog (#514): it never writes the config on its own. A source no stage enters from is refused by the parser
 * (parseStages), so this hands the row to Settings, which saves it with the rest once a stage feeds it. */
export function NewSourceDialog({ open, auth, workspaces, takenNames, onOpenChange, onAdd }: NewSourceDialogProps) {
  const id = useId();
  const [owner, setOwner] = useState(DEFAULT_OWNER);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [workspace, setWorkspace] = useState(workspaces[0] ?? '');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  // A fresh instance every time the dialog opens (#514): never carries over the last source it added.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to `open` turning true only; workspaces is read fresh on that run
  useEffect(() => {
    if (!open) return;
    setOwner(DEFAULT_OWNER); setProjects([]); setNumber(''); setName(''); setNameTouched(false); setWorkspace(workspaces[0] ?? ''); setError(undefined);
  }, [open]);

  async function load(): Promise<void> {
    const url = projectsUrl(auth, { owner });
    if (!url) return;
    setLoading(true);
    setError(undefined);
    try {
      const list = await getJson<ProjectSummary[]>(url);
      setProjects(list);
      if (list.length === 0) setError(t('settings.error.noProjects', { owner }));
    } catch (err) { setError((err as Error).message); }
    finally { setLoading(false); }
  }

  function pick(picked: string): void {
    setNumber(picked);
    if (!nameTouched) setName(workspaceNameFor(projects.find((p) => String(p.number) === picked)?.title ?? ''));
  }

  function add(): void {
    const fields = { owner, number, name, workspace };
    const problem = newSourceProblem(fields, takenNames);
    if (problem) { setError(problem); return; }
    onAdd({ source: newSourceDraft(fields), projects });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('newSource.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('newSource.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <Label>{t('newSource.type')}</Label>
          <ToggleGroup type="single" variant="outline" className="w-full" value={NEW_SOURCE_TYPES[0]}>
            {NEW_SOURCE_TYPES.map((type) => <ToggleGroupItem key={type} value={type} className="flex-1">{t(`settings.sources.type.${type}` as MessageKey)}</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
        <ProjectFields id={id} owner={owner} projects={projects} number={number} loading={loading} onOwnerChange={setOwner} onLoad={() => void load()} onPick={pick} />
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-name`}>{t('newSource.name')}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
            <p className="text-muted-foreground text-xs">{t('newSource.nameHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <WorkspaceSelect id={`${id}-workspace`} label={t('newSource.workspace')} workspaces={workspaces} value={workspace === '' ? undefined : workspace} fill onChange={(v) => setWorkspace(v ?? '')} />
            <p className="text-muted-foreground text-xs">{t('newSource.workspaceHint')}</p>
          </div>
        </div>
        {error && <p role="alert" className="text-destructive text-sm">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t('settings.cancel')}</Button>
          <Button type="button" onClick={add}>{t('newSource.add')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
