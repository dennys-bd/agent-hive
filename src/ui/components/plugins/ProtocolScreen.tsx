import { LockIcon } from 'lucide-react';
import { Fragment } from 'react';
import { PassageCard } from '@/components/plugins/PassageCard';
import { VariableList } from '@/components/plugins/VariableList';
import { ViewAsSelect } from '@/components/plugins/ViewAsSelect';
import { Button } from '@/components/ui/button';
import { editErrorKey, type WriteResult } from '@/hooks/use-item-editor';
import { newKey, passageText, type Protocol, type ProtocolBlockView, type ProtocolRead } from '@/hooks/use-protocol';
import { type MessageKey, t } from '@/i18n';

export interface ProtocolScreenProps { protocol: Protocol; workspaces: readonly string[] }
interface TemplateProps extends ProtocolScreenProps { read: ProtocolRead }
interface RenderedProps { protocol: Protocol; read: ProtocolRead; workspace: string }

// A Hive block (handoff 11g): locked. One whose tool mcp turns off is left out of every file, so it shows at .45, struck through, with why
function BlockCard({ block }: { block: ProtocolBlockView }) {
  return (
    <article aria-label={block.id} className={`flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2 text-xs ${block.off ? 'opacity-45' : ''}`}>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <LockIcon aria-hidden className="size-3" />
        <span className="flex-1">{t(block.off ? 'plugins.protocol.leftOutBlock' : 'plugins.protocol.fromHive')}</span>
        {block.off && block.tool !== undefined && <span>{t('plugins.protocol.toolOff', { tool: block.tool })}</span>}
      </div>
      <p className={`whitespace-pre-wrap font-mono text-muted-foreground ${block.off ? 'line-through' : ''}`}>{block.stage}</p>
    </article>
  );
}

// The stage text only: done and stop are the blocks that differ, and a passage goes into both files the same way. Each block, its passages in
// id order, its new draft, then its insert line (none before intro); orphans last, where the render puts them
function Template({ protocol, read, workspaces }: TemplateProps) {
  const orphans = read.passages.filter((p) => p.orphan);
  return (
    <>
      {read.blocks.map((block) => (
        <Fragment key={block.id}>
          <BlockCard block={block} />
          {read.passages.filter((p) => !p.orphan && p.after === block.id).map((p) => (
            <PassageCard key={p.id} protocol={protocol} after={block.id} saved={p} workspaces={workspaces} />
          ))}
          {Object.hasOwn(protocol.drafts, newKey(block.id)) && <PassageCard protocol={protocol} after={block.id} workspaces={workspaces} />}
          <Button type="button" size="xs" variant="ghost" className="self-start text-muted-foreground" onClick={() => protocol.insert(block.id)}>
            {t('plugins.protocol.insert')}
          </Button>
        </Fragment>
      ))}
      {orphans.map((p) => <PassageCard key={p.id} protocol={protocol} after={p.after} saved={p} workspaces={workspaces} />)}
    </>
  );
}

// "View as" a workspace: the saved protocol that workspace's runs receive, memory section and mcp.off included, read-only
function Rendered({ protocol, read, workspace }: RenderedProps) {
  const leftOut = read.passages.flatMap(({ id, errors }) =>
    (Object.hasOwn(errors, workspace) ? errors[workspace].slice(0, 1).map(({ message }) => ({ id, message })) : []));
  return (
    <>
      {leftOut.map(({ id, message }) => <p key={id} className="text-destructive text-xs">{t('plugins.protocol.passageLeftOut', { id, message })}</p>)}
      {protocol.renderError && <p role="alert" className="text-destructive text-xs">{t(protocol.renderError)}</p>}
      {protocol.rendered !== undefined && (
        <pre role="document" aria-label={t('plugins.protocol.rendered', { workspace })} className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
          {protocol.rendered}
        </pre>
      )}
    </>
  );
}

function Content({ protocol, workspaces }: ProtocolScreenProps) {
  const { read, loadError, viewAs } = protocol;
  if (loadError !== undefined) return <p role="alert" className="text-destructive text-xs">{t(loadError)}</p>;
  if (read === undefined) return <p className="text-muted-foreground text-xs">{t('plugins.protocol.loading')}</p>;
  if (viewAs !== undefined) return <Rendered protocol={protocol} read={read} workspace={viewAs} />;
  return <Template protocol={protocol} read={read} workspaces={workspaces} />;
}

/** Screen 11g (#337): the Hive's protocol as locked blocks with the user's passages between them, on #336's routes; with "view as" on a
 * workspace, the text that workspace's runs receive. */
export function ProtocolScreen({ protocol, workspaces }: ProtocolScreenProps) {
  return (
    <section aria-label={t('plugins.section.protocol')} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-6 py-5">
      <Content protocol={protocol} workspaces={workspaces} />
    </section>
  );
}

/** The right pane on the protocol screen (#337): "view as", its hint, then the selected passage's variables. A value lands in that passage's
 * draft and is saved with it; nothing reaches the server from here. */
export function ProtocolPane({ protocol, workspaces }: ProtocolScreenProps) {
  const { selected } = protocol;
  const text = selected === undefined ? undefined : passageText(protocol, selected);
  const onApply = (result: WriteResult): MessageKey | undefined => {
    if (!result.ok) return editErrorKey(result.error.message);
    if (selected !== undefined) protocol.edit(selected, result.text);
    return undefined;
  };
  return (
    <>
      <ViewAsSelect value={protocol.viewAs} workspaces={workspaces} onChange={protocol.setViewAs} />
      <p className="border-b px-3 py-2 text-muted-foreground text-xs">{t('plugins.protocol.viewAsHint')}</p>
      {text === undefined
        ? <p className="p-3 text-muted-foreground text-xs">{t('plugins.protocol.selectHint')}</p>
        : <VariableList key={selected} text={text} workspaces={workspaces} onApply={onApply} />}
    </>
  );
}
