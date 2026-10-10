import { CHILD, FIELD, FIELD_LABEL, FIELD_ROW } from '@/components/settings/field-row';
import { SettingSwitch } from '@/components/settings/SettingSwitch';
import { SettingsGroup } from '@/components/settings/SettingsGroup';
import { TrustedDomainsGroup } from '@/components/settings/TrustedDomainsGroup';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t, type MessageKey } from '@/i18n';
import type { SettingsDraft } from '@/lib/settings-form';
import { CONSOLE_LINES_MAX, CONSOLE_LINES_MIN, FILE_ICON_SCOPES, FILE_ICON_SETS, NOTIFICATION_KINDS, ON_CLOSE, THEMES, type FileIcons, type FileIconScope, type FileIconSet, type Language, type NotificationKind, type NotificationSettings, type OnClose, type SidebarsPerView, type Theme } from '../../../types';

interface AppSectionProps {
  draft: SettingsDraft;
  onChange(patch: Partial<SettingsDraft>): void;
}

const THEME_KEY: Record<Theme, MessageKey> = { system: 'settings.theme.system', light: 'settings.theme.light', dark: 'settings.theme.dark' };
const ON_CLOSE_KEY: Record<OnClose, MessageKey> = { menuBar: 'settings.onClose.menuBar', quit: 'settings.onClose.quit' };
const NOTIFICATION_KEY: Record<NotificationKind, MessageKey> = {
  waiting: 'settings.notifications.waiting', approval: 'settings.notifications.approval', pr: 'settings.notifications.pr', failed: 'settings.notifications.failed',
};
const FILE_ICON_SET_KEY: Record<FileIconSet, MessageKey> = { material: 'settings.fileIcons.set.material', vscode: 'settings.fileIcons.set.vscode', none: 'settings.fileIcons.set.none' };
const FILE_ICON_SCOPE_KEY: Record<FileIconScope, MessageKey> = { all: 'settings.fileIcons.scope.all', folders: 'settings.fileIcons.scope.folders' };

// What closing the last window does (#513): one choice where two switches could contradict each other. The viewer applies a save at once.
function OnCloseSelect({ value, onChange }: { value: OnClose; onChange(onClose: OnClose): void }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="settings-on-close">{t('settings.onClose')}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as OnClose)}>
        <SelectTrigger id="settings-on-close" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{ON_CLOSE.map((o) => <SelectItem key={o} value={o}>{t(ON_CLOSE_KEY[o])}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );
}

interface NotificationsFieldsProps { value: NotificationSettings; onChange(notifications: NotificationSettings): void }

// Which transitions show a macOS notification (#199), one switch each, beside onClose: both are the viewer's own behaviour, read at the next
// event, no restart. A fieldset carries role="group" natively (as SignalRuler does).
function NotificationsFields({ value, onChange }: NotificationsFieldsProps) {
  return (
    <fieldset aria-label={t('settings.notifications')} className="m-0 flex min-w-0 flex-col gap-3 border-0 border-t p-0 pt-4">
      <div className="flex flex-col gap-0.5">
        <span className="font-medium text-sm leading-none">{t('settings.notifications')}</span>
        <p className="text-muted-foreground text-xs">{t('settings.notifications.hint')}</p>
      </div>
      {NOTIFICATION_KINDS.map((kind) => (
        <SettingSwitch key={kind} id={`settings-notifications-${kind}`} label={NOTIFICATION_KEY[kind]} checked={value[kind]} onCheckedChange={(on) => onChange({ ...value, [kind]: on })} />
      ))}
    </fieldset>
  );
}

interface ThemeSelectProps { value: Theme; onChange(theme: Theme): void }

// The UI's colors (#296): system follows macOS live, light and dark force one. The main window applies a save at once; an open terminal window on its next open.
function ThemeSelect({ value, onChange }: ThemeSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor="settings-theme">{t('settings.theme')}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as Theme)}>
        <SelectTrigger id="settings-theme" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {THEMES.map((theme) => <SelectItem key={theme} value={theme}>{t(THEME_KEY[theme])}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

interface FileIconsFieldsProps { value: FileIcons; onChange(fileIcons: FileIcons): void }

// The files tree's icons (#754): the set, where they show, and whether they are muted. With none there is no icon for the other two to act
// on, so they are disabled, and keep their value for when a set comes back.
function FileIconsFields({ value, onChange }: FileIconsFieldsProps) {
  const isOff = value.set === 'none';
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-file-icons">{t('settings.fileIcons')}</Label>
          <Select value={value.set} onValueChange={(v) => onChange({ ...value, set: v as FileIconSet })}>
            <SelectTrigger id="settings-file-icons" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{FILE_ICON_SETS.map((set) => <SelectItem key={set} value={set}>{t(FILE_ICON_SET_KEY[set])}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="settings-file-icons-scope">{t('settings.fileIcons.scope')}</Label>
          <Select value={value.scope} disabled={isOff} onValueChange={(v) => onChange({ ...value, scope: v as FileIconScope })}>
            <SelectTrigger id="settings-file-icons-scope" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{FILE_ICON_SCOPES.map((scope) => <SelectItem key={scope} value={scope}>{t(FILE_ICON_SCOPE_KEY[scope])}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <SettingSwitch id="settings-file-icons-muted" label="settings.fileIcons.muted" hint="settings.fileIcons.muted.hint" checked={value.muted} disabled={isOff} onCheckedChange={(muted) => onChange({ ...value, muted })} />
    </div>
  );
}

interface TerminalFontFieldProps { value: string; onChange(font: string): void }

// The terminal's font family (#376): one name, as typed; empty is the system monospace. Never checked against the installed fonts: the stack
// falls back to the system monospace, and the terminal shows the result at once. The panel's tabs take a save in place; an open terminal
// window on its next open.
function TerminalFontField({ value, onChange }: TerminalFontFieldProps) {
  return (
    <div className={FIELD}>
      <Label htmlFor="settings-terminal-font" className={FIELD_LABEL}>{t('settings.terminalFont')}</Label>
      <Input id="settings-terminal-font" defaultValue={value} placeholder={t('settings.terminalFont.placeholder')} onChange={(e) => onChange(e.target.value)} />
      <p className="text-muted-foreground text-xs">{t('settings.terminalFont.hint')}</p>
    </div>
  );
}

interface SidebarsPerViewGroupProps { value: SidebarsPerView; onChange(sidebarsPerView: SidebarsPerView): void }

// Which sidebar state each view keeps (#821): open or closed and width, per side. The right sidebar's tab only means something while the right
// side is kept per view, so its switch sits under that one, disabled otherwise, and keeps its value for when it comes back.
function SidebarsPerViewGroup({ value, onChange }: SidebarsPerViewGroupProps) {
  return (
    <SettingsGroup title="settings.sidebarsPerView" hint="settings.sidebarsPerView.hint">
      <SettingSwitch id="settings-sidebars-left" label="settings.sidebarsPerView.left" checked={value.left} onCheckedChange={(left) => onChange({ ...value, left })} />
      <SettingSwitch id="settings-sidebars-right" label="settings.sidebarsPerView.right" checked={value.right} onCheckedChange={(right) => onChange({ ...value, right })} />
      <div className={CHILD}>
        <SettingSwitch
          id="settings-sidebars-right-tab" label="settings.sidebarsPerView.rightTab" hint="settings.sidebarsPerView.rightTab.hint"
          checked={value.rightTab} disabled={!value.right} onCheckedChange={(rightTab) => onChange({ ...value, rightTab })}
        />
      </div>
    </SettingsGroup>
  );
}

// Settings › app (#510): how the Hive looks and behaves on this computer.
export function AppSection({ draft, onChange }: AppSectionProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <SettingsGroup title="settings.group.appearance">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settings-language">{t('settings.language')}</Label>
            <Select value={draft.language} onValueChange={(v) => onChange({ language: v as Language })}>
              <SelectTrigger id="settings-language" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pt">português</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <ThemeSelect value={draft.theme} onChange={(theme) => onChange({ theme })} />
        </div>
        <FileIconsFields value={draft.fileIcons} onChange={(fileIcons) => onChange({ fileIcons })} />
      </SettingsGroup>
      <SettingsGroup title="settings.group.window">
        <OnCloseSelect value={draft.onClose} onChange={(onClose) => onChange({ onClose })} />
        <NotificationsFields value={draft.notifications} onChange={(notifications) => onChange({ notifications })} />
      </SettingsGroup>
      <SettingsGroup title="settings.group.terminal">
        <div className={FIELD_ROW}>
          <TerminalFontField value={draft.terminalFont} onChange={(terminalFont) => onChange({ terminalFont })} />
          {/* #353: how many lines each console channel keeps; a save applies to the next output */}
          <div className={FIELD}>
            <Label htmlFor="settings-console-lines" className={FIELD_LABEL}>{t('settings.consoleLines')}</Label>
            <Input id="settings-console-lines" type="number" min={CONSOLE_LINES_MIN} max={CONSOLE_LINES_MAX} step={1} defaultValue={draft.consoleLines} onChange={(e) => onChange({ consoleLines: e.target.value })} />
            <p className="text-muted-foreground text-xs">{t('settings.consoleLines.hint')}</p>
          </div>
        </div>
      </SettingsGroup>
      <TrustedDomainsGroup hosts={draft.trustedDomains} onChange={(trustedDomains) => onChange({ trustedDomains })} />
      <SidebarsPerViewGroup value={draft.sidebarsPerView} onChange={(sidebarsPerView) => onChange({ sidebarsPerView })} />
    </div>
  );
}
