import type {
  BoardConfig, BoardQuota, Budget, Card, EpicsMode, EventsPayload, Language, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult, Signal, Slot,
  State, Task, UsageSample, WorkersMode,
} from '../types.js';
import { addColumnRow, columnsFromForm, fillColumnOptions, renderBoard, renderColumnRows } from './board.js';
import { esc, renderOutput } from './highlight.js';
import { LOCALE, applyTranslations, type MessageKey, setLanguage, slotEventText, statusText, t } from './i18n.js';
import { addRuleRow, renderRules, usageRulesFromForm } from './limits.js';

const SIGNAL_HINT: Record<Signal, MessageKey | undefined> = { green: undefined, yellow: 'signal.yellow', red: 'signal.red' };
const RERENDER_MS = 30_000;
const OUTPUT_POLL_MS = 2_000;
const DEFAULT_OWNER = '@me';
const DEFAULT_MARKDOWN_PATH = 'board.md';
// Mirrors src/usage.ts, which cannot be imported here (it pulls node:fs into the browser).
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
// Mirrors src/rate-limits.ts, which cannot be imported here (the served module graph only has app.js); the text comes from the dictionary.
const WINDOW_LABEL: Record<string, MessageKey> = { five_hour: 'window.session', seven_day: 'window.week' };
const WEEKLY_PREFIX = 'seven_day_';
const PERCENT_MAX = 100;
// Mirrors src/polling.ts, which cannot be imported here (it pulls the orchestrator into the browser).
const QUOTA_RESERVE = 500;
// Mirrors isFree in src/orchestrator.ts, which cannot be imported here (it pulls node:crypto into the browser).
const isFree = (slot: Slot): boolean => slot.status === 'empty' && !slot.draining;

type BoardType = BoardConfig['type'];

let state: State | undefined;
const cardOf = (slot: Slot): Card | undefined => state?.cards.find((c) => c.task.itemId === slot.cardId); // the card running in this slot
let selectedSlotId: string | undefined;
let setupInfo: SetupInfo | undefined;
let outputTimer: ReturnType<typeof setInterval> | undefined;
let outputSlotId: string | undefined; // the slot the output polling follows
let lastOutput = '';
let revealing = false; // guards the invalid listener below against re-entry from later controls in the same submit

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function elapsed(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// 842, 12.3k, 1.2M: fits the header and the card meta
function fmt(n: number): string {
  if (n < THOUSAND) return String(n);
  if (n < MILLION) return `${(n / THOUSAND).toFixed(1)}k`;
  return `${(n / MILLION).toFixed(1)}M`;
}

function usageTotals(usage: UsageSample[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

const withinLimit = (total: number, limit?: number): boolean => limit === undefined || limit <= 0 || total < limit;
const meter = (value: number, max: number): string => `<meter min="0" max="${max}" value="${value}"></meter>`;

const locale = (): string => LOCALE[setupInfo?.language ?? 'en'];
const clock = (iso: string): string => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return t(WINDOW_LABEL[key]);
  if (key.startsWith(WEEKLY_PREFIX)) return `${t('window.week')} ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
}

// Static text first, then whatever is already rendered: the caller renders again when there is a State on screen.
function applyLanguage(language: Language): void {
  setLanguage(language);
  applyTranslations();
}

function showBanner(id: 'error' | 'notice', message?: string): void {
  const el = $(id);
  el.textContent = message ?? '';
  el.classList.toggle('show', Boolean(message));
}
const showError = (message?: string): void => showBanner('error', message);
const showNotice = (message?: string): void => showBanner('notice', message);

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({ error: res.statusText }))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function getJson<T>(path: string): Promise<T> {
  return fetch(path).then((res) => parseJson<T>(res));
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return fetch(path, {
    // x-hive-ui is the CSRF gate of every dashboard route: a form on another site cannot set it (see server.ts)
    method: 'POST', headers: { 'content-type': 'application/json', 'x-hive-ui': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => parseJson<T>(res));
}

function post(path: string, body?: unknown): void {
  postJson(path, body).catch((err: Error) => showError(err.message));
}

// ---------- dashboard ----------

function renderCard(slot: Slot): string {
  const occupied = slot.status !== 'empty';
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${statusText('empty')}</div></div>`;
  const tokens = slot.tokens === undefined ? '' : ` · ${fmt(slot.tokens)} tokens`;
  const card = cardOf(slot);
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${esc(card?.task.id ?? '')} ${esc(card?.task.title ?? '')}</div>
      <div class="meta">${statusText(slot.status)} · ${elapsed(slot.startedAt)}${slot.draining ? ` · ${t('card.draining')}` : ''}${tokens}</div>
      <div class="meta">${t('card.column')} ${esc(card?.column ?? '')} · ${esc(card?.branch ?? card?.slug ?? '')}</div>
      <div class="meta">${esc(slot.lastEvent ? slotEventText(slot.lastEvent) : '')}</div>
      <div class="actions"><button data-focus="${slot.id}">terminal</button><button class="danger" data-kill="${slot.id}">kill</button></div>
    </div>`;
}

function taskLink(task: Task): string {
  // GitHub tasks link to the issue; markdown tasks carry the board file path, which is not a browsable URL
  return task.url.startsWith('http')
    ? `<div class="meta"><a href="${esc(task.url)}" target="_blank" rel="noreferrer">issue</a></div>`
    : `<div class="meta">board: ${esc(task.url)}</div>`;
}

async function loadOutput(): Promise<void> {
  const slotId = outputSlotId;
  if (!slotId) return;
  try {
    const { lines } = await getJson<{ lines: string[] }>(`/slots/${slotId}/output`);
    if (slotId !== outputSlotId) return; // the panel moved on while the request was in flight
    const text = lines.join('\n');
    if (text === lastOutput) return;
    lastOutput = text;
    const el = $('output');
    el.innerHTML = renderOutput(lines); // every worker character is escaped inside renderOutput
    el.scrollTop = el.scrollHeight; // follows the worker as the output grows
  } catch (err) {
    showError((err as Error).message);
  }
}

// One timer, for the selected slot only: opening the panel starts it, closing or switching restarts it clean.
function syncOutputPolling(slotId: string | undefined): void {
  if (slotId === outputSlotId) return;
  if (outputTimer) clearInterval(outputTimer);
  outputTimer = undefined;
  outputSlotId = slotId;
  $('output').innerHTML = '';
  lastOutput = '';
  if (!slotId) return;
  void loadOutput();
  outputTimer = setInterval(() => void loadOutput(), OUTPUT_POLL_MS);
}

function renderDetail(): void {
  const slot = state?.slots.find((s) => s.id === selectedSlotId);
  const panel = $('detail');
  if (!slot || slot.status === 'empty') {
    panel.classList.remove('show');
    selectedSlotId = undefined;
    syncOutputPolling(undefined);
    return;
  }
  const card = cardOf(slot);
  const lines = [
    `<div class="title">#${esc(card?.task.id ?? '')} ${esc(card?.task.title ?? '')}</div>`,
    card?.prUrl ? `<p>PR: <a href="${esc(card.prUrl)}" target="_blank" rel="noreferrer">${esc(card.prUrl)}</a></p>` : '',
    slot.question ? `<p>${t('detail.pending')}</p><pre>${esc(slot.question)}</pre>` : '',
    `<div class="meta">worktree: ${esc(card?.worktree ?? '—')}</div><div class="meta">branch: ${esc(card?.branch ?? '—')}</div>`,
    slot.sessionId ? `<div class="meta">${t('detail.session')} <code>claude --resume ${esc(slot.sessionId)}</code></div>` : '',
    card ? taskLink(card.task) : '',
  ];
  $('detail-body').innerHTML = lines.join('');
  panel.classList.add('show');
  syncOutputPolling(slot.id);
}

function renderSignal(signal: Signal): void {
  document.querySelectorAll<HTMLButtonElement>('#signal button').forEach((button) => {
    button.classList.toggle('active', button.dataset.signal === signal);
  });
  const hint = SIGNAL_HINT[signal];
  $('signal-hint').textContent = hint ? t(hint) : '';
}

// Every interpolated value is a number, so no escaping is needed. The header shows a meter per configured limit
// (same shape as the plan meters) and nothing without a budget; the raw counter lives in the settings "limites" tab.
function renderUsage(usage: UsageSample[], budget: Budget): void {
  const { hour, day } = usageTotals(usage, Date.now());
  const over = !withinLimit(hour, budget.maxTokensPerHour) || !withinLimit(day, budget.maxTokensPerDay);
  const line = (label: string, used: number, limit?: number): string =>
    limit ? `<span>${label} ${Math.round((used / limit) * PERCENT_MAX)}% ${meter(used, limit)}</span>` : '';
  const el = $('usage');
  el.classList.toggle('over', over);
  el.innerHTML = [
    line(t('usage.hour'), hour, budget.maxTokensPerHour),
    line(t('usage.day'), day, budget.maxTokensPerDay),
    over ? `<span>${t('usage.over')}</span>` : '',
  ].filter(Boolean).join('');
  $('usage-raw').textContent = t('usage.raw', { hour: fmt(hour), day: fmt(day) });
}

// Percent and times are numbers / Date output; the label derives from a key another process chose, so it is escaped.
// One line per window in the order the status line sent them (session first, week below); the reading time is a tooltip.
function renderLimits(limits?: RateLimits): void {
  const el = $('limits');
  if (!limits) {
    el.textContent = '';
    el.title = '';
    return;
  }
  el.innerHTML = Object.entries(limits.windows).map(([key, w]) =>
    `<span>${esc(windowLabel(key))} ${Math.round(w.usedPercent)}% ${meter(w.usedPercent, PERCENT_MAX)} ${t('limits.resets', { time: clock(w.resetsAt) })}</span>`).join('');
  el.title = t('limits.at', { time: clock(limits.at) });
}

// Numbers and a Date: nothing to escape. Rendered into the settings board tab; empty without a reading (markdown board, or no poll yet).
function renderQuota(quota?: BoardQuota): void {
  const el = $('quota');
  el.classList.toggle('low', quota !== undefined && quota.remaining < QUOTA_RESERVE);
  el.textContent = quota
    ? `GitHub ${quota.remaining.toLocaleString(locale())}/${quota.limit.toLocaleString(locale())} · ${t('limits.resets', { time: clock(quota.resetsAt) })}`
    : '';
}

function render(): void {
  if (!state) return;
  const active = state.slots.filter((s) => s.status !== 'empty').length;
  $('summary').textContent = t('header.activeWorkers', { active, max: state.maxConcurrent });
  renderSignal(state.signal);
  renderUsage(state.usage, state.budget);
  renderLimits(state.rateLimits);
  renderQuota(state.boardQuota);
  const max = $<HTMLInputElement>('max');
  if (document.activeElement !== max) max.value = String(state.maxConcurrent);
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString(locale())}` : '';
  showError(state.error);
  $('grid').innerHTML = state.slots.map(renderCard).join('');
  $('board').innerHTML = renderBoard(state);
  renderDetail();
}

function connect(): void {
  const source = new EventSource('/events');
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data) as EventsPayload;
    if (!('slots' in payload)) return; // setup mode: the form is already showing, the first real State follows the save
    state = payload;
    render();
  };
  source.onerror = () => showError(t('error.disconnected'));
}

// ---------- setup form ----------

// Panels are hidden, never disabled, so native validation still covers every tab.
function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('#setup-tabs [data-tab]')
    .forEach((tab) => { tab.setAttribute('aria-pressed', String(tab.dataset.tab === name)); });
  document.querySelectorAll<HTMLElement>('#setup [data-panel]')
    .forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
}

function setupError(message?: string): void {
  $('setup-error').textContent = message ?? '';
}

function fillSelect(select: HTMLSelectElement, options: { value: string; label: string }[], selected?: string): void {
  select.innerHTML = options
    .map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
}

function ownerValue(): string {
  return $<HTMLInputElement>('owner').value.trim();
}

function markdownPathValue(): string {
  return $<HTMLInputElement>('md-path').value.trim();
}

function boardType(): BoardType {
  return $<HTMLSelectElement>('board-type').value as BoardType;
}

// A disabled fieldset is hidden by CSS and skipped by form validation, so only the visible fields count.
function applyBoardType(): void {
  const type = boardType();
  $<HTMLFieldSetElement>('github-fields').disabled = type !== 'github';
  $<HTMLFieldSetElement>('markdown-fields').disabled = type !== 'markdown';
}

function columnsUrl(board: BoardConfig): string {
  const params = new URLSearchParams(
    board.type === 'github' ? { type: board.type, owner: board.owner, number: String(board.number) } : { type: board.type, path: board.path },
  );
  return `/setup/columns?${params.toString()}`;
}

// The board columns the editor offers (datalist behind from / onStart / onFinish): github by owner + project, markdown by path.
async function loadColumnOptions(): Promise<void> {
  const board = boardFromForm();
  if (!board) return;
  setupError();
  try {
    fillColumnOptions(await getJson<string[]>(columnsUrl(board)));
  } catch (err) {
    setupError((err as Error).message);
  }
}

async function loadProjects(selectedNumber?: number): Promise<void> {
  const owner = ownerValue();
  if (!owner) {
    setupError(t('setup.error.owner'));
    return;
  }
  setupError();
  try {
    const projects = await getJson<ProjectSummary[]>(`/setup/projects?owner=${encodeURIComponent(owner)}`);
    fillSelect(
      $('project'),
      projects.map((p) => ({ value: String(p.number), label: `#${p.number} ${p.title}` })),
      selectedNumber === undefined ? undefined : String(selectedNumber),
    );
    if (projects.length === 0) {
      setupError(t('setup.error.noProjects', { owner }));
      return;
    }
    await loadColumnOptions();
  } catch (err) {
    setupError((err as Error).message);
  }
}

const budgetField = (limit?: number): string => (limit ? String(limit) : ''); // 0 or absent = no limit = empty field

// Only filled fields above 0 become keys, so hive.config.json stays clean.
function budgetFromForm(): Budget {
  const limit = (id: string): number | undefined => {
    const value = Number($<HTMLInputElement>(id).value);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  };
  const hour = limit('budget-hour');
  const day = limit('budget-day');
  return { ...(hour ? { maxTokensPerHour: hour } : {}), ...(day ? { maxTokensPerDay: day } : {}) };
}

async function openSetup(): Promise<void> {
  const config = setupInfo?.config;
  const board = config?.board;
  document.body.classList.add('setup');
  showTab('board');
  $<HTMLButtonElement>('cancel').hidden = !setupInfo?.configured;
  $<HTMLSelectElement>('board-type').value = board?.type ?? 'github';
  applyBoardType();
  $<HTMLInputElement>('owner').value = board?.type === 'github' ? board.owner : DEFAULT_OWNER;
  $<HTMLInputElement>('md-path').value = board?.type === 'markdown' ? board.path : DEFAULT_MARKDOWN_PATH;
  $<HTMLSelectElement>('language').value = setupInfo?.language ?? 'en'; // the effective one: saving writes it explicitly
  $<HTMLSelectElement>('workers-mode').value = config?.workers ?? 'embedded';
  $<HTMLSelectElement>('epics').value = config?.epics ?? 'ignore';
  $<HTMLInputElement>('budget-hour').value = budgetField(config?.budget.maxTokensPerHour);
  $<HTMLInputElement>('budget-day').value = budgetField(config?.budget.maxTokensPerDay);
  renderRules(config?.usageRules ?? []);
  renderColumnRows(config?.columns ?? []);
  fillColumnOptions([]);
  setupError(setupInfo?.configured ? undefined : setupInfo?.error);
  if (board?.type !== 'markdown') await loadProjects(board?.type === 'github' ? board.number : undefined);
}

function closeSetup(): void {
  document.body.classList.remove('setup');
}

function boardFromForm(): BoardConfig | undefined {
  if (boardType() === 'markdown') {
    const path = markdownPathValue();
    return path ? { type: 'markdown', path } : undefined;
  }
  const project = $<HTMLSelectElement>('project').value;
  return project ? { type: 'github', owner: ownerValue(), number: Number(project) } : undefined;
}

async function saveSetup(): Promise<void> {
  const board = boardFromForm();
  if (!board) {
    showTab('board');
    setupError(boardType() === 'markdown' ? t('setup.error.path') : t('setup.error.project'));
    return;
  }
  if (columnsFromForm().length === 0) {
    showTab('board');
    setupError(t('setup.columns.none'));
    return;
  }
  // usageRulesFromForm throws for a row with no effect; the row lives on a tab that may be hidden, so reveal it
  let usageRules: SetupBody['usageRules'];
  try {
    usageRules = usageRulesFromForm();
  } catch (err) {
    showTab('limites');
    setupError((err as Error).message);
    return;
  }
  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  setupError();
  try {
    const body: SetupBody = {
      board,
      columns: columnsFromForm(),
      workers: $<HTMLSelectElement>('workers-mode').value as WorkersMode,
      epics: $<HTMLSelectElement>('epics').value as EpicsMode,
      budget: budgetFromForm(),
      usageRules,
      language: $<HTMLSelectElement>('language').value as Language,
    };
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
    applyLanguage(setupInfo.language); // the save may have changed it: static text now, the dashboard on the render below
    closeSetup();
    render(); // no-op without a State; otherwise cards, queue and header switch without waiting for the next event
    showNotice(result.restartForPort ? t('notice.restartPort', { port: result.restartForPort }) : undefined);
  } catch (err) {
    setupError((err as Error).message);
  } finally {
    save.disabled = false;
  }
}

async function init(): Promise<void> {
  try {
    setupInfo = await getJson<SetupInfo>('/setup');
  } catch (err) {
    showError((err as Error).message);
    return;
  }
  applyLanguage(setupInfo.language); // before any render: neither the form nor the dashboard ever shows the wrong language
  if (!setupInfo.configured) await openSetup();
  connect();
}

// ---------- events ----------

$('grid').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const killId = target.dataset.kill;
  if (killId) {
    event.stopPropagation();
    if (confirm(t('confirm.kill'))) post(`/slots/${killId}/kill`);
    return;
  }
  const focusId = target.dataset.focus;
  if (focusId) {
    event.stopPropagation(); // opens the terminal, not the panel
    post(`/slots/${focusId}/focus`);
    return;
  }
  const card = target.closest<HTMLElement>('.card.occupied');
  if (!card) return;
  selectedSlotId = card.dataset.id;
  renderDetail();
});

// Board actions. start: the human override (#47), with the confirm to raise the max when no slot is free. close / keep: the answer
// to a card that left the board. The ids go escaped into the attributes and encoded into the URLs.
$('board').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const { start, close, keep, focus } = target.dataset;
  if (focus) { post(`/slots/${focus}/focus`); return; }
  if (close) { if (confirm(t('confirm.close'))) post(`/cards/${encodeURIComponent(close)}/close`); return; }
  if (keep) { post(`/cards/${encodeURIComponent(keep)}/keep`); return; }
  const card = start === undefined ? undefined : state?.cards.find((c) => c.task.itemId === start);
  if (!state || !card) return;
  const path = `/cards/${encodeURIComponent(card.task.itemId)}/start`;
  if (state.slots.some(isFree)) { post(path); return; }
  const next = state.slots.filter((s) => s.status !== 'empty').length + 1;
  if (confirm(t('confirm.raiseMax', { from: state.maxConcurrent, to: next, id: card.task.id }))) post(path, { raiseMax: true });
});

$('max').addEventListener('change', (event) => {
  const value = Number((event.target as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= 0) post('/config', { maxConcurrent: value });
});
$('refresh').addEventListener('click', () => post('/board/refresh'));
$('signal').addEventListener('click', (event) => {
  const signal = (event.target as HTMLElement).dataset.signal;
  if (signal) post('/signal', { signal });
});
$('focus').addEventListener('click', () => {
  if (selectedSlotId) post(`/slots/${selectedSlotId}/focus`);
});
$('close').addEventListener('click', () => {
  selectedSlotId = undefined;
  renderDetail();
});
$('configure').addEventListener('click', () => void openSetup());
$('load-projects').addEventListener('click', () => void loadProjects());
$('board-type').addEventListener('change', applyBoardType);
$('load-columns').addEventListener('click', () => void loadColumnOptions());
$('project').addEventListener('change', () => void loadColumnOptions());
$('add-column').addEventListener('click', () => addColumnRow());
$('setup').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSetup();
});
$('cancel').addEventListener('click', closeSetup);
$('add-rule').addEventListener('click', () => addRuleRow());
$('setup-tabs').addEventListener('click', (event) => {
  const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (tab) showTab(tab);
});
// invalid fires once per invalid control in tree order; only react to the first one per submit attempt
$('setup').addEventListener('invalid', (event) => {
  if (revealing) return;
  revealing = true;
  queueMicrotask(() => { revealing = false; });
  const panel = (event.target as HTMLElement).closest<HTMLElement>('[data-panel]');
  if (panel?.dataset.panel) showTab(panel.dataset.panel);
}, { capture: true });

setInterval(render, RERENDER_MS);
void init();
