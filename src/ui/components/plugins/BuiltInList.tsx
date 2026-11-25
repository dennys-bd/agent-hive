import { useId } from 'react';
import { BUILT_INS, type BuiltIns } from '../../../template';
import { WorkspaceSquare } from '@/components/WorkspaceSquare';
import { type MessageKey, t } from '@/i18n';
import { renderFor, type WorkspaceRenders } from '@/lib/workspace-values';

type BuiltInName = (typeof BUILT_INS)[number];
interface Shown { text: string; isAbsent: boolean }

const WHAT: Record<BuiltInName, MessageKey> = {
  workspace: 'plugins.builtIns.workspace.what', fork: 'plugins.builtIns.fork.what',
  baseBranch: 'plugins.builtIns.baseBranch.what', nestedRepos: 'plugins.builtIns.nestedRepos.what', gitlabHosts: 'plugins.builtIns.gitlabHosts.what',
};

// Absence is valid here (not a fork, no nested repo), so it reads as words and never as the variables' red dash
function shownOf(name: BuiltInName, workspace: string, builtIns: BuiltIns): Shown {
  const absent = (key: MessageKey): Shown => ({ text: t(key), isAbsent: true });
  switch (name) {
    case 'workspace': return { text: workspace, isAbsent: false };
    case 'fork': return builtIns.fork === null ? absent('plugins.builtIns.fork.none')
      : { text: t(`plugins.builtIns.fork.${builtIns.fork.pr}`, { remote: builtIns.fork.remote }), isAbsent: false };
    case 'baseBranch': return builtIns.baseBranch === null ? absent('plugins.builtIns.baseBranch.none') : { text: builtIns.baseBranch, isAbsent: false };
    case 'nestedRepos': return builtIns.nestedRepos.length === 0 ? absent('plugins.builtIns.nestedRepos.none') : { text: builtIns.nestedRepos.join(', '), isAbsent: false };
    case 'gitlabHosts': return { text: builtIns.gitlabHosts.join(', '), isAbsent: false }; // #1044: gitlab.com is always there, so never "none"
  }
}

function BuiltInLine({ name, workspace, builtIns, isDimmed }: { name: BuiltInName; workspace: string; builtIns: BuiltIns; isDimmed: boolean }) {
  const { text, isAbsent } = shownOf(name, workspace, builtIns);
  return (
    <div className={`grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-1.5 text-xs ${isDimmed ? 'opacity-40' : ''}`}>
      <WorkspaceSquare name={workspace} title={workspace} />
      <span title={`${name} · ${workspace}`} className={`truncate ${isAbsent ? 'text-muted-foreground' : 'font-mono text-foreground'}`}>{text}</span>
    </div>
  );
}

/** The variables pane's read-only built-ins (#742): what every template may read without declaring, a line per workspace each, from the
 * workspace's Settings. Nothing here is focusable; "view as" dims the other workspaces' lines as it does the variables'. */
export function BuiltInList({ workspaces, values, viewAs }: { workspaces: readonly string[]; values: WorkspaceRenders; viewAs?: string }) {
  const id = useId();
  const targets = workspaces.map((w) => renderFor(values, w));
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5 pt-2">
      <span id={id} className="text-muted-foreground">{t('plugins.builtIns.title')}</span>
      <p className="text-muted-foreground">{t('plugins.builtIns.hint')}</p>
      <ul aria-labelledby={id} className="flex flex-col gap-1">
        {BUILT_INS.map((name) => (
          <li key={name} aria-label={name} className="flex flex-col gap-1 rounded-md border px-2 py-1.5">
            <span className="truncate font-mono font-semibold">{name}</span>
            <span className="text-muted-foreground">{t(WHAT[name])}</span>
            {targets.map((target) => (
              <BuiltInLine key={target.name} name={name} workspace={target.name} builtIns={target.builtIns} isDimmed={viewAs !== undefined && viewAs !== target.name} />
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
