import { useCallback, useEffect, useState } from 'react';
import { BoardTab } from '@/components/setup/BoardTab';
import { GeneralTab } from '@/components/setup/GeneralTab';
import { LimitsTab } from '@/components/setup/LimitsTab';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LOCALE, t } from '@/i18n';
import { getJson, postJson } from '@/lib/api';
import { columnsUrl, draftFrom, toSetupBody, validateSetup, type SetupDraft, type SetupTab } from '@/lib/setup-form';
import type { ProjectSummary, SetupInfo, SetupResult, State } from '../../../types';

interface SetupProps { info: SetupInfo; state?: State; onSaved(result: SetupResult): Promise<void>; onCancel?(): void }

export function Setup({ info, state, onSaved, onCancel }: SetupProps) {
  const [draft, setDraft] = useState<SetupDraft>(() => draftFrom(info));
  const [tab, setTab] = useState<SetupTab>('board');
  const [error, setError] = useState<string | undefined>(info.configured ? undefined : info.error);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [options, setOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(draftFrom(info)); }, [info]);

  const loadColumns = useCallback(async (current: SetupDraft) => {
    const url = columnsUrl(current);
    if (!url) return;
    try { setOptions(await getJson<string[]>(url)); }
    catch (err) { setError((err as Error).message); }
  }, []);

  const loadProjects = useCallback(async () => {
    const owner = draft.owner.trim();
    if (!owner) { setError(t('setup.error.owner')); return; }
    setError(undefined);
    try {
      const list = await getJson<ProjectSummary[]>(`/setup/projects?owner=${encodeURIComponent(owner)}`);
      setProjects(list);
      if (list.length === 0) { setError(t('setup.error.noProjects', { owner })); return; }
      const project = list.some((p) => String(p.number) === draft.project) ? draft.project : String(list[0].number);
      setDraft((d) => ({ ...d, project }));
      await loadColumns({ ...draft, project });
    } catch (err) { setError((err as Error).message); }
  }, [draft, loadColumns]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once on mount only, like the imperative openSetup() did
  useEffect(() => {
    if (draft.boardType === 'github') void loadProjects();
  }, []);

  async function save(): Promise<void> {
    const problem = validateSetup(draft);
    if (problem) { setTab(problem.tab); setError(problem.message); return; }
    setSaving(true);
    setError(undefined);
    try { await onSaved(await postJson<SetupResult>('/setup', toSetupBody(draft))); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }

  return (
    <div className="mx-auto max-w-2xl p-4">
      <h2 className="mb-4 font-semibold text-lg">{t('setup.title')}</h2>
      <Tabs value={tab} onValueChange={(v) => setTab(v as SetupTab)}>
        <TabsList>
          <TabsTrigger value="board">{t('setup.tab.board')}</TabsTrigger>
          <TabsTrigger value="general">{t('setup.tab.general')}</TabsTrigger>
          <TabsTrigger value="limits">{t('setup.tab.limits')}</TabsTrigger>
        </TabsList>
        <TabsContent value="board">
          <BoardTab
            draft={draft} options={options} projects={projects} quota={state?.boardQuota} locale={LOCALE[info.language]}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            onLoadProjects={() => void loadProjects()}
            onLoadColumns={(project) => void loadColumns(project === undefined ? draft : { ...draft, project })}
          />
        </TabsContent>
        <TabsContent value="general">
          <GeneralTab draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        </TabsContent>
        <TabsContent value="limits">
          <LimitsTab draft={draft} state={state} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        </TabsContent>
      </Tabs>
      {error && <p className="mt-4 min-h-[1.4em] whitespace-pre-wrap text-destructive text-sm">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button type="button" disabled={saving} onClick={() => void save()}>{t('setup.save')}</Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>{t('setup.cancel')}</Button>}
      </div>
    </div>
  );
}
