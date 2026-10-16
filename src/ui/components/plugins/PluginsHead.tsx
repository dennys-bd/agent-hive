import type { ReactNode } from 'react';
import type { CatalogueItem, UpdatePreview } from '../../../types';
import { Confirm } from '@/components/Confirm';
import { STATE_LOOK } from '@/components/plugins/marks';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { ItemEditor } from '@/hooks/use-item-editor';
import type { Plugins } from '@/hooks/use-plugins';
import { type MessageKey, t } from '@/i18n';
import { HIVE_ORIGIN, type ListSection, savedLabel, sectionOf } from '@/lib/plugins';

// The header drags the window: its controls opt out to keep their clicks, as Header's own do
const NO_DRAG = '[-webkit-app-region:no-drag]';
const CHIP = 'rounded-full border px-1.5 font-normal text-[11px]';
const ALL = '*'; // the filter's "all workspaces": no workspace may be named `*` (WORKSPACE_NAME)
const META: Record<ListSection, MessageKey> = { skills: 'plugins.list.meta.skills', specialists: 'plugins.list.meta.specialists' };
const NEW: Record<ListSection, MessageKey> = { skills: 'plugins.list.newSkill', specialists: 'plugins.list.newSpecialist' };

interface HeadProps { title: string; isMono?: boolean; chip?: ReactNode; meta?: string; children?: ReactNode }

function Head({ title, isMono = false, chip, meta, children }: HeadProps) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-xs">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2 font-semibold text-[13px]"><span className={isMono ? 'truncate font-mono' : 'truncate'}>{title}</span>{chip}</span>
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

interface ItemProps { item: CatalogueItem; editor: ItemEditor; workspaces: readonly string[] }

// The head's actions (decisions 11, 12): the test is HIVE-25's, drawn disabled; revert only for a Hive item with a version open, never in the
// preview. The reviewer slot draws nothing until 4.1 and 4.3
function ItemActions({ item, editor, workspaces }: ItemProps) {
  const viewAs = item.origin === HIVE_ORIGIN ? editor.viewAs : undefined;
  const target = viewAs ?? workspaces[0];
  const version = editor.read?.item.id === item.id ? editor.read.version : null;
  const canRevert = item.origin === HIVE_ORIGIN && !item.userCreated && version !== null && viewAs === undefined;
  return (
    <>
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

function ItemHead({ item, editor, workspaces }: ItemProps) {
  const look = STATE_LOOK[item.state];
  const chip = <span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>;
  // decision 10: the open file's mtime; the original answers none, so the part goes
  const savedAt = editor.read?.item.id === item.id ? editor.read.files.find((file) => file.path === editor.path)?.savedAt : undefined;
  const meta = [t(`plugins.section.${sectionOf(item.kind)}`), ...(savedAt === undefined ? [] : [t('plugins.head.saved', { time: savedLabel(savedAt) })])].join(' · ');
  return <Head title={item.name} isMono chip={chip} meta={meta}><ItemActions item={item} editor={editor} workspaces={workspaces} /></Head>;
}

const metaOf = ({ from, to }: UpdatePreview): string => (from !== undefined && to !== undefined ? t('plugins.update.meta', { from, to }) : t('plugins.update.metaBare'));

/** The update screen's head (#325, decision 5): the item's mono name, the yellow chip, and `hive <from> → <to>` once the preview answers.
 * The update screen portals it, since only it holds the preview. */
export function UpdateHead({ item, preview }: { item: CatalogueItem; preview?: UpdatePreview }) {
  const look = STATE_LOOK['update available'];
  return <Head title={item.name} isMono chip={<span className={`${CHIP} ${look.chip}`}>{t(look.label)}</span>} meta={preview && metaOf(preview)} />;
}

/** The header's centre in the plugins view (#313, decision 17; #319): an item's head carries its saved time, the test and revert. The version
 * selector (3.6) and the reviewer (4.1) are not drawn yet. An item the catalogue no longer has heads nothing. */
export function PluginsHead({ plugins, editor, workspaces }: { plugins: Plugins; editor: ItemEditor; workspaces: readonly string[] }) {
  const { screen } = plugins;
  if (screen.kind === 'list') return <ListHead plugins={plugins} section={screen.section} workspaces={workspaces} />;
  if (screen.kind === 'update') return null; // the update screen portals its own head: its meta needs the preview (#325)
  if (screen.kind !== 'item') return <Head title={t(`plugins.section.${screen.kind}`)} />;
  const item = plugins.items?.find((i) => i.id === screen.id);
  return item === undefined ? null : <ItemHead item={item} editor={editor} workspaces={workspaces} />;
}

