import { Fragment, type ReactNode } from 'react';
import type { CatalogueItem, UpdatePreview } from '../../../types';
import { Confirm } from '@/components/Confirm';
import { CHIP, STATE_LOOK } from '@/components/plugins/marks';
import { OriginCard } from '@/components/plugins/OriginCard';
import { ReviewerMenu } from '@/components/plugins/ReviewerMenu';
import { VersionMenu } from '@/components/plugins/VersionMenu';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Annotations } from '@/hooks/use-annotations';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { Plugins } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN, type ListSection, savedLabel, sectionOf } from '@/lib/plugins';

// The header drags the window: its controls opt out to keep their clicks, as Header's own do
const NO_DRAG = '[-webkit-app-region:no-drag]';
const ALL = '*'; // the filter's "all workspaces": no workspace may be named `*` (WORKSPACE_NAME)
const META: Record<ListSection, MessageKey> = { skills: 'plugins.list.meta.skills', specialists: 'plugins.list.meta.specialists' };
const NEW: Record<ListSection, MessageKey> = { skills: 'plugins.list.newSkill', specialists: 'plugins.list.newSpecialist' };

interface HeadProps { title: string; isMono?: boolean; version?: ReactNode; chip?: ReactNode; meta?: ReactNode; children?: ReactNode }

function Head({ title, isMono = false, version, chip, meta, children }: HeadProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 font-semibold text-[13px]"><span className={isMono ? 'truncate font-mono' : 'truncate'}>{title}</span>{version}{chip}</span>
        {meta && <span className="truncate text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </div>
  );
}

function ListHead({ plugins, section, workspaces }: { plugins: Plugins; section: ListSection; workspaces: readonly string[] }) {
  return (
    <Head title={t(`plugins.section.${section}`)} meta={t(META[section])}>
      <Select value={plugins.filter ?? ALL} onValueChange={(value) => plugins.setFilter(value === ALL ? undefined : value)}>
        <SelectTrigger size="sm" aria-label={t('plugins.list.filter')} className={NO_DRAG}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('plugins.list.allWorkspaces')}</SelectItem>
          {workspaces.filter((w) => w !== HIVE_ORIGIN).map((w) => <SelectItem key={w} value={w}>{w}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button type="button" size="sm" className={NO_DRAG} onClick={() => plugins.setCreating(true)}>{t(NEW[section])}</Button>
    </Head>
  );
}

interface ItemProps { item: CatalogueItem; editor: ItemEditor; annotations: Annotations; workspaces: readonly string[] }
interface ItemHeadProps extends ItemProps { onUpdate(version: string): void }

// The handoff's mcp head: its "+ server" opens the screen's form through isCreating, as a list's "new skill" opens its field
function McpHead({ plugins }: { plugins: Plugins }) {
  return (
    <Head title={t('plugins.section.mcp')} meta={t('plugins.mcp.meta')}>
      <Button type="button" size="sm" variant="outline" className={NO_DRAG} onClick={() => plugins.setCreating(true)}>{t('plugins.mcp.addServer')}</Button>
    </Head>
  );
}

// The head's actions (decisions 11, 12): the reviewer's counter and menu (#327, #329), the test is HIVE-25's, drawn disabled; revert only for a Hive item with a
// version open. The preview draws neither the counter nor revert
function ItemActions({ item, editor, annotations, workspaces }: ItemProps) {
  const viewAs = item.origin === HIVE_ORIGIN ? editor.viewAs : undefined;
  const target = viewAs ?? workspaces[0];
  const version = editor.item?.id === item.id ? editor.version : null;
  const canRevert = item.origin === HIVE_ORIGIN && !item.userCreated && version !== null && viewAs === undefined;
  return (
    <>
      {viewAs === undefined && <ReviewerMenu annotations={annotations} workspaces={workspaces} className={NO_DRAG} />}
      {target !== undefined && (
        // a disabled button gets no pointer events: its wrapper carries the tooltip
        <span title={t('plugins.head.soon')} className={NO_DRAG}><Button type="button" size="sm" variant="outline" disabled>{t('plugins.head.test', { workspace: target })}</Button></span>
      )}
      {canRevert && (
        <Confirm
          title={t('plugins.revert.title')} message={t('plugins.revert.message', { version })} confirmLabel={t('plugins.revert.confirm')} onConfirm={editor.revert}
          trigger={<Button type="button" size="sm" variant="outline" className={NO_DRAG}>{t('plugins.head.revert')}</Button>}
        />
      )}
    </>
  );
}

// #320, decision 14: the menu opens versions; the chip stays the way into a version's update, the first with one, in catalogue order
function ItemHead({ item, editor, annotations, workspaces, onUpdate }: ItemHeadProps) {
  const look = STATE_LOOK[item.state];
  const updated = item.state === 'update available' ? item.versions.find((v) => v.updateAvailable) : undefined;
  const chip = updated === undefined
    ? <span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>
    : <button type="button" title={t('plugins.update.review')} onClick={() => onUpdate(updated.name)} className={`${CHIP} ${look.chip} ${NO_DRAG} hover:bg-accent`}>{t(look.label)}</button>;
  // decision 10: the open file's mtime; the original answers none, so the part goes
  const savedAt = editor.read?.item.id === item.id ? editor.read.files.find((file) => file.path === editor.path)?.savedAt : undefined;
  const meta = [t(`plugins.section.${sectionOf(item.kind)}`), ...(savedAt === undefined ? [] : [t('plugins.head.saved', { time: savedLabel(savedAt) })])].join(' · ');
  // #320 decision 15, #338 decision 11: one link and card per origin, in header order, after the saved time
  const origins = (item.basedOn ?? []).map((origin) => (
    <Fragment key={`${origin.name} ${origin.url}`}> · <OriginCard basedOn={origin} description={item.description} className={NO_DRAG} /></Fragment>
  ));
  const metaLine = origins.length === 0 ? meta : <>{meta}{origins}</>;
  return (
    <Head title={item.name} isMono version={<VersionMenu item={item} editor={editor} workspaces={workspaces} className={NO_DRAG} />} chip={chip} meta={metaLine}>
      <ItemActions item={item} editor={editor} annotations={annotations} workspaces={workspaces} />
    </Head>
  );
}

const metaOf = ({ from, to }: UpdatePreview): string => (from !== undefined && to !== undefined ? t('plugins.update.meta', { from, to }) : t('plugins.update.metaBare'));

export interface UpdateHeadProps { item: CatalogueItem; version: string; preview?: UpdatePreview; onVersion(version: string): void }

/** The update screen's head (#325, decisions 3 and 5): the item's mono name, the yellow chip, `hive <from> → <to>` once the preview answers;
 * a select of the versions with an update when there are two or more, since the version menu opens versions, not their updates (#320, decision 14). The update
 * screen portals it, since only it holds the preview. */
export function UpdateHead({ item, version, preview, onVersion }: UpdateHeadProps) {
  const look = STATE_LOOK['update available'];
  const updated = item.versions.filter((v) => v.updateAvailable);
  return (
    <Head title={item.name} isMono chip={<span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>} meta={preview && metaOf(preview)}>
      {updated.length >= 2 && (
        <Select value={version} onValueChange={onVersion}>
          <SelectTrigger size="sm" aria-label={t('plugins.update.version')} className={NO_DRAG}><SelectValue /></SelectTrigger>
          <SelectContent>{updated.map((v) => <SelectItem key={v.name} value={v.name}>{v.name}</SelectItem>)}</SelectContent>
        </Select>
      )}
    </Head>
  );
}

/** The header's centre in the plugins view (#313, decision 17; #319): an item's head carries its saved time, the reviewer's counter and menu (#327, #329), the test and revert. Its version
 * selector (#320). An item the catalogue no longer has heads nothing. */
export function PluginsHead({ plugins, editor, annotations, workspaces }: { plugins: Plugins; editor: ItemEditor; annotations: Annotations; workspaces: readonly string[] }) {
  const { screen } = plugins;
  if (screen.kind === 'list') return <ListHead plugins={plugins} section={screen.section} workspaces={workspaces} />;
  if (screen.kind === 'update') return null; // the update screen portals its own head: its meta needs the preview (#325)
  if (screen.kind === 'mcp') return <McpHead plugins={plugins} />;
  if (screen.kind === 'protocol') return <Head title={t('plugins.section.protocol')} meta={t('plugins.protocol.meta')} />; // #337: no actions
  const item = plugins.items?.find((i) => i.id === screen.id);
  const onUpdate = (version: string): void => plugins.open({ kind: 'update', id: screen.id, version });
  return item === undefined ? null : <ItemHead item={item} editor={editor} annotations={annotations} workspaces={workspaces} onUpdate={onUpdate} />;
}

