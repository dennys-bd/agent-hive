import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { agentName, isAvailable, knownAgent } from '../../agents';
import { isLaunchModel } from '../../launch-pick';
import { AGENT_IDS, type AgentAvailability, type AgentId, type AgentLaunchOptions, type LaunchOption } from '../../types';
import { AGENT_COLOR, AgentIcon } from '@/components/SessionLabel';
import { Button } from '@/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { t } from '@/i18n';

// cmdk values no model or agent name can take ('@' is outside both shapes): the default model's item and none's
const DEFAULT_ITEM = '@default';
const NONE_ITEM = '@none';
const ONE_M = '[1m]';
const PLUGIN = 'hive'; // the Hive plugin, the hive: of every specialized agent (codex-home's CODEX_PLUGIN, which the page cannot import)

interface FieldMenuProps { label: string; shown: string; isDefault: boolean; disabled?: boolean; open: boolean; onOpenChange(open: boolean): void; children: ReactNode }

// A field's menu (#257): a combobox button showing the pick (the default muted, a pick in mono) over a searchable list. Modal: its content is
// portalled out of the dialog that holds it, and the dialog's scroll lock eats the wheel there unless the popover registers its own (#290)
function FieldMenu({ label, shown, isDefault, disabled = false, open, onOpenChange, children }: FieldMenuProps) {
  return (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={label} title={shown} disabled={disabled} className="w-full min-w-0 justify-between font-normal">
          <span className={isDefault ? 'truncate text-muted-foreground' : 'truncate font-mono text-xs'}>{shown}</span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0">{children}</PopoverContent>
    </Popover>
  );
}

// A list row: ✓ on the pick, the id in mono, its hint muted on the right
function Row({ id, hint, isPicked, isMono = true }: { id: string; hint?: string; isPicked: boolean; isMono?: boolean }) {
  return (
    <>
      <CheckIcon className={isPicked ? 'opacity-100' : 'opacity-0'} />
      <span className={isMono ? 'font-mono text-xs' : ''}>{id}</span>
      {hint !== undefined && <span className="ml-auto truncate pl-2 text-muted-foreground text-xs">{hint}</span>}
    </>
  );
}

// A [1m] alias names its context in the page's language; any other option its own hint
const hintOf = ({ id, hint }: LaunchOption): string | undefined => (id.endsWith(ONE_M) ? t('newSession.model.context1m') : hint);

interface ModelMenuProps { agent: AgentId; options?: AgentLaunchOptions; value: string; disabled?: boolean; defaultLabel?: string; open: boolean; onOpenChange(open: boolean): void; onPick(model: string): void }

/** modelo (#257): the agent's default (the Hive passes no flag), its aliases and its versions, most recent first, and a typed name the lists
 * lack, offered when it has a model's shape. '' is the default; defaultLabel names what '' runs when a stage gives it a model (#290): '' never
 * unsets it. */
export function ModelMenu({ agent, options, value, disabled = false, defaultLabel, open, onOpenChange, onPick }: ModelMenuProps) {
  const [search, setSearch] = useState('');
  const toggle = (isOpen: boolean): void => { onOpenChange(isOpen); if (!isOpen) setSearch(''); };
  const pick = (model: string): void => { onPick(model); toggle(false); };
  const name = agentName(agent);
  const fallback = defaultLabel ?? t('newSession.model.default', { agent: name });
  const typed = search.trim();
  const aliases = options?.aliases ?? [];
  const versions = options?.versions ?? [];
  const isListed = [...aliases, ...versions].some((m) => m.id === typed);
  const item = (option: LaunchOption) => (
    <CommandItem key={option.id} value={option.id} onSelect={() => pick(option.id)}><Row id={option.id} hint={hintOf(option)} isPicked={option.id === value} /></CommandItem>
  );
  return (
    <FieldMenu label={t('newSession.model')} shown={value === '' ? fallback : value} isDefault={value === ''} disabled={disabled} open={open} onOpenChange={toggle}>
      <Command label={t('newSession.model.search')}>
        <CommandInput value={search} onValueChange={setSearch} aria-label={t('newSession.model.search')} placeholder={t('newSession.model.search')} />
        <CommandList>
          <CommandItem value={DEFAULT_ITEM} keywords={[name]} onSelect={() => pick('')}>
            <CheckIcon className={value === '' ? 'opacity-100' : 'opacity-0'} />
            <span className="flex min-w-0 flex-col">
              <span>{fallback}</span>
              <span className="truncate text-muted-foreground text-xs">{t('newSession.model.defaultHint', { agent: name })}</span>
            </span>
          </CommandItem>
          <CommandSeparator />
          {aliases.length > 0 && <CommandGroup heading={t('newSession.model.aliases')}>{aliases.map(item)}</CommandGroup>}
          {versions.length > 0 && <CommandGroup heading={t('newSession.model.versions')}>{versions.map(item)}</CommandGroup>}
          {typed !== '' && !isListed && (
            <CommandItem value={typed} disabled={!isLaunchModel(typed)} onSelect={() => pick(typed)}><Row id={t('newSession.model.typed', { model: typed })} isPicked={false} /></CommandItem>
          )}
        </CommandList>
      </Command>
    </FieldMenu>
  );
}

interface AgentMenuProps { agent: AgentId; agents?: AgentLaunchOptions['specializedAgents']; value: string; disabled?: boolean; open: boolean; onOpenChange(open: boolean): void; onPick(name: string): void }

/** agente especializado (#257): none, or one of the Hive plugin's agents, searched by name or description; disabled with the reason when the
 * plugin lists none. '' is none. No list yet (the answer is still coming): the field works with none. */
export function SpecializedAgentMenu({ agent, agents, value, disabled = false, open, onOpenChange, onPick }: AgentMenuProps) {
  const pick = (name: string): void => { onPick(name); onOpenChange(false); };
  const isEmpty = agents !== undefined && agents.length === 0;
  const none = t('newSession.agents.none');
  const shown = value !== '' ? value : isEmpty ? t('newSession.agents.empty', { agent: agentName(agent) }) : none;
  return (
    <FieldMenu label={t('newSession.specializedAgent')} shown={shown} isDefault={value === ''} disabled={isEmpty || disabled} open={open} onOpenChange={onOpenChange}>
      <Command label={t('newSession.agents.search')}>
        <CommandInput aria-label={t('newSession.agents.search')} placeholder={t('newSession.agents.search')} />
        <CommandList>
          <CommandItem value={NONE_ITEM} keywords={[none]} onSelect={() => pick('')}><Row id={none} isPicked={value === ''} isMono={false} /></CommandItem>
          {agents !== undefined && agents.length > 0 && (
            <CommandGroup heading={t('newSession.agents.group', { plugin: PLUGIN, agent: agentName(agent) })}>
              {agents.map((a) => (
                <CommandItem key={a.name} value={a.name} keywords={[a.description]} onSelect={() => pick(a.name)}>
                  <CheckIcon className={a.name === value ? 'opacity-100' : 'opacity-0'} />
                  <span className="flex min-w-0 flex-col">
                    <span className="font-mono text-xs">{a.name}</span>
                    <span className="truncate text-muted-foreground text-xs">{a.description}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </FieldMenu>
  );
}

interface AgentFieldProps { id: string; value: AgentId; agents: readonly AgentAvailability[]; onChange(agent: AgentId): void; onOpenChange(open: boolean): void }

/** agente (#257, #290): each agent with its mark in its own colour; one boot did not find is disabled and named off PATH, as the + names it. */
export function AgentField({ id, value, agents, onChange, onOpenChange }: AgentFieldProps) {
  return (
    <Select value={value} onValueChange={(v) => { const picked = knownAgent(v); if (picked !== undefined) onChange(picked); }} onOpenChange={onOpenChange}>
      <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {AGENT_IDS.map((agent) => (
          <SelectItem key={agent} value={agent} disabled={!isAvailable(agent, agents)}>
            <AgentIcon agent={agent} className={`size-4 ${AGENT_COLOR[agent] ?? ''}`} />
            {isAvailable(agent, agents) ? agentName(agent) : `${agentName(agent)} · ${t('settings.agent.offPath')}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
