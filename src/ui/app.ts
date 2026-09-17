import type {
  BoardConfig, BoardQuota, Budget, EpicsMode, EventsPayload, ProjectSummary, RateLimits, SetupBody, SetupInfo, SetupResult, Signal, Slot,
  State, StatusKey, Task, UsageSample, WorkersMode,
} from '../types.js';
import { esc, renderOutput } from './highlight.js';
import { addRuleRow, renderRules, usageRulesFromForm } from './limits.js';

const STATUS_LABEL: Record<Slot['status'], string> = {
  vazio: 'vazio', trabalhando: 'trabalhando', esperando_voce: 'esperando você', aguardando_review: 'aguardando review',
};
const SIGNAL_HINT: Record<Signal, string> = { green: '', yellow: 'sem jobs novos', red: 'modo manual' };
const RERENDER_MS = 30_000;
const OUTPUT_POLL_MS = 2_000;
const INPUT_PLACEHOLDER = 'mensagem pro worker';
const ANSWER_PLACEHOLDER = 'responder ao worker';
// Mirrors DEFAULT_CONFIG in config.ts, which cannot be imported here (it pulls node:fs into the browser).
const PRESELECT: Record<StatusKey, string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
const DEFAULT_MAX = 2;
const DEFAULT_OWNER = '@me';
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];
const COLUMN_SELECT: Record<StatusKey, string> = { queue: 'col-queue', working: 'col-working', review: 'col-review' };
const MARKDOWN_INPUT: Record<StatusKey, string> = { queue: 'md-queue', working: 'md-working', review: 'md-review' };
const DEFAULT_MARKDOWN_PATH = 'board.md';
// Mirrors src/usage.ts, which cannot be imported here (it pulls node:fs into the browser).
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const THOUSAND = 1_000;
const MILLION = 1_000_000;
// Mirrors src/rate-limits.ts, which cannot be imported here (the served module graph only has app.js).
const WINDOW_LABEL: Record<string, string> = { five_hour: 'sessão', seven_day: 'semana' };
const WEEKLY_PREFIX = 'seven_day_';
const PERCENT_MAX = 100;
// Mirrors src/polling.ts, which cannot be imported here (it pulls the orchestrator into the browser).
const QUOTA_RESERVE = 500;

type BoardType = BoardConfig['type'];

let state: State | undefined;
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

const clock = (iso: string): string => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function windowLabel(key: string): string {
  if (Object.hasOwn(WINDOW_LABEL, key)) return WINDOW_LABEL[key];
  if (key.startsWith(WEEKLY_PREFIX)) return `semana ${key.slice(WEEKLY_PREFIX.length)}`;
  return key.replaceAll('_', ' ');
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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then((res) => parseJson<T>(res));
}

function post(path: string, body?: unknown): void {
  postJson(path, body).catch((err: Error) => showError(err.message));
}

// ---------- dashboard ----------

function renderCard(slot: Slot): string {
  const occupied = slot.status !== 'vazio';
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : '', slot.paused ? 'paused' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${STATUS_LABEL.vazio}</div></div>`;
  const marks = `${slot.draining ? ' · drenando' : ''}${slot.paused ? ' · pausado' : ''}`;
  const tokens = slot.tokens === undefined ? '' : ` · ${fmt(slot.tokens)} tokens`;
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${esc(slot.task?.id ?? '')} ${esc(slot.task?.title ?? '')}</div>
      <div class="meta">${STATUS_LABEL[slot.status]} · ${elapsed(slot.startedAt)}${marks}${tokens}</div>
      <div class="meta">${esc(slot.branch ?? slot.slug ?? '')}</div>
      <div class="meta">${esc(slot.lastEvent ?? '')}</div>
      <div class="actions"><button class="danger" data-kill="${slot.id}">kill</button></div>
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

const workersMode = (): WorkersMode => setupInfo?.config?.workers ?? 'embedded';

// The CSS keys the panel off this: output for embedded workers, the "ir pro terminal" button for tabs.
function applyWorkersMode(): void {
  document.body.dataset.workers = workersMode();
}

// One timer, for the selected slot only: opening the panel starts it, closing or switching restarts it clean.
// A tab has no output to poll.
function syncOutputPolling(slotId: string | undefined): void {
  if (slotId === outputSlotId) return;
  if (outputTimer) clearInterval(outputTimer);
  outputTimer = undefined;
  outputSlotId = slotId;
  $('output').innerHTML = '';
  lastOutput = '';
  if (!slotId || workersMode() === 'iterm') return;
  void loadOutput();
  outputTimer = setInterval(() => void loadOutput(), OUTPUT_POLL_MS);
}

function sendInput(): void {
  const input = $<HTMLInputElement>('input');
  const text = input.value.trim();
  if (!selectedSlotId || !text) return;
  input.value = '';
  post(`/slots/${selectedSlotId}/input`, { text });
}

function renderDetail(): void {
  const slot = state?.slots.find((s) => s.id === selectedSlotId);
  const panel = $('detail');
  if (!slot || slot.status === 'vazio') {
    panel.classList.remove('show');
    selectedSlotId = undefined;
    syncOutputPolling(undefined);
    return;
  }
  const lines = [
    `<div class="title">#${esc(slot.task?.id ?? '')} ${esc(slot.task?.title ?? '')}</div>`,
    slot.prUrl ? `<p>PR: <a href="${esc(slot.prUrl)}" target="_blank" rel="noreferrer">${esc(slot.prUrl)}</a></p>` : '',
    slot.question ? `<p>pendente:</p><pre>${esc(slot.question)}</pre>` : '',
    `<div class="meta">worktree: ${esc(slot.worktree ?? '—')}</div>`,
    `<div class="meta">branch: ${esc(slot.branch ?? '—')}</div>`,
    slot.task ? taskLink(slot.task) : '',
  ];
  $('detail-body').innerHTML = lines.join('');
  $<HTMLInputElement>('input').placeholder = slot.status === 'esperando_voce' ? ANSWER_PLACEHOLDER : INPUT_PLACEHOLDER;
  panel.classList.add('show');
  syncOutputPolling(slot.id);
}

function renderQueued(task: Task): string {
  const blockers = task.blockedBy?.length
    ? `<span class="meta" style="color:var(--muted)"> · bloqueada por ${esc(task.blockedBy.join(', '))}</span>`
    : '';
  return `<li>#${esc(task.id)} ${esc(task.title)}${blockers}</li>`;
}

function renderSignal(signal: Signal): void {
  document.querySelectorAll<HTMLButtonElement>('#signal button').forEach((button) => {
    button.classList.toggle('active', button.dataset.signal === signal);
  });
  $('signal-hint').textContent = SIGNAL_HINT[signal];
}

// Every interpolated value is a number, so no escaping is needed.
function renderUsage(usage: UsageSample[], budget: Budget): void {
  const { hour, day } = usageTotals(usage, Date.now());
  const over = !withinLimit(hour, budget.maxTokensPerHour) || !withinLimit(day, budget.maxTokensPerDay);
  const el = $('usage');
  el.classList.toggle('over', over);
  el.innerHTML = [
    `tokens: ${fmt(hour)}/h`, budget.maxTokensPerHour ? meter(hour, budget.maxTokensPerHour) : '',
    `· ${fmt(day)}/dia`, budget.maxTokensPerDay ? meter(day, budget.maxTokensPerDay) : '',
    over ? '· sem orçamento' : '',
  ].filter(Boolean).join(' ');
}

// Percent and times are numbers / Date output; the label derives from a key another process chose, so it is escaped.
function renderLimits(limits?: RateLimits): void {
  const el = $('limits');
  if (!limits) {
    el.textContent = '';
    return;
  }
  const windows = Object.entries(limits.windows).map(([key, w]) =>
    `${esc(windowLabel(key))} ${Math.round(w.usedPercent)}% ${meter(w.usedPercent, PERCENT_MAX)} reseta ${clock(w.resetsAt)}`);
  el.innerHTML = [...windows, `às ${clock(limits.at)}`].join(' · ');
}

// Numbers and a Date: nothing to escape. Empty without a reading (markdown board, or no poll yet).
function renderQuota(quota?: BoardQuota): void {
  const el = $('quota');
  el.classList.toggle('low', quota !== undefined && quota.remaining < QUOTA_RESERVE);
  el.textContent = quota
    ? `GitHub ${quota.remaining.toLocaleString('pt-BR')}/${quota.limit.toLocaleString('pt-BR')} · reseta ${clock(quota.resetsAt)}`
    : '';
}

function render(): void {
  if (!state) return;
  const active = state.slots.filter((s) => s.status !== 'vazio').length;
  $('summary').textContent = `${active}/${state.maxConcurrent} workers ativos`;
  renderSignal(state.signal);
  renderUsage(state.usage, state.budget);
  renderLimits(state.rateLimits);
  renderQuota(state.boardQuota);
  const max = $<HTMLInputElement>('max');
  if (document.activeElement !== max) max.value = String(state.maxConcurrent);
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString()}` : '';
  showError(state.error);
  $('grid').innerHTML = state.slots.map(renderCard).join('');
  $('queue').innerHTML = state.queue.map(renderQueued).join('')
    || '<li style="list-style:none;color:var(--muted)">vazia</li>';
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
  source.onerror = () => showError('conexão com o Agent Hive perdida; reconectando…');
}

// ---------- setup form ----------

// Panels are hidden, never disabled, so native validation still covers every tab.
function showTab(name: string): void {
  document.querySelectorAll<HTMLButtonElement>('#setup-tabs [data-tab]')
    .forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.tab === name)));
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

async function loadColumns(): Promise<void> {
  const owner = ownerValue();
  const number = $<HTMLSelectElement>('project').value;
  if (!owner || !number) return;
  setupError();
  try {
    const options = await getJson<string[]>(columnsUrl({ type: 'github', owner, number: Number(number) }));
    const current = setupInfo?.config;
    for (const key of STATUS_KEYS) {
      const wanted = current && options.includes(current.status[key]) ? current.status[key] : PRESELECT[key];
      fillSelect($(COLUMN_SELECT[key]), options.map((o) => ({ value: o, label: o })), wanted);
    }
  } catch (err) {
    setupError((err as Error).message);
  }
}

// Fills the datalist behind the three markdown text fields with the statuses the file already uses.
async function loadMarkdownColumns(): Promise<void> {
  const path = markdownPathValue();
  if (!path) {
    setupError('informe o caminho do arquivo');
    return;
  }
  setupError();
  try {
    const options = await getJson<string[]>(columnsUrl({ type: 'markdown', path }));
    $('md-options').innerHTML = options.map((o) => `<option value="${esc(o)}"></option>`).join('');
    $('md-found').textContent = `status encontrados: ${options.join(', ')} — clique no campo para escolher.`;
    for (const key of STATUS_KEYS) {
      const input = $<HTMLInputElement>(MARKDOWN_INPUT[key]);
      if (!options.includes(input.value)) input.value = ''; // not in the file: clear so the full list shows
    }
  } catch (err) {
    setupError((err as Error).message);
  }
}

async function loadProjects(selectedNumber?: number): Promise<void> {
  const owner = ownerValue();
  if (!owner) {
    setupError('informe o owner (@me, usuário ou org)');
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
      setupError(`nenhum project aberto em ${owner}`);
      return;
    }
    await loadColumns();
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
  for (const key of STATUS_KEYS) $<HTMLInputElement>(MARKDOWN_INPUT[key]).value = config?.status[key] ?? PRESELECT[key];
  $('md-options').innerHTML = '';
  $<HTMLSelectElement>('workers-mode').value = config?.workers ?? 'embedded';
  $<HTMLSelectElement>('epics').value = config?.epics ?? 'ignore';
  $<HTMLInputElement>('max-workers').value = String(config?.maxConcurrent ?? DEFAULT_MAX);
  $<HTMLInputElement>('budget-hour').value = budgetField(config?.budget.maxTokensPerHour);
  $<HTMLInputElement>('budget-day').value = budgetField(config?.budget.maxTokensPerDay);
  renderRules(config?.usageRules ?? []);
  $<HTMLTextAreaElement>('prompt-template').value = config?.promptTemplate ?? '';
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

function statusFromForm(): Record<StatusKey, string> {
  const ids = boardType() === 'markdown' ? MARKDOWN_INPUT : COLUMN_SELECT;
  const read = (key: StatusKey): string => $<HTMLInputElement | HTMLSelectElement>(ids[key]).value.trim();
  return { queue: read('queue'), working: read('working'), review: read('review') };
}

async function saveSetup(): Promise<void> {
  const board = boardFromForm();
  if (!board) {
    showTab('board');
    setupError(boardType() === 'markdown' ? 'informe o caminho do arquivo' : 'escolha um project');
    return;
  }
  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  setupError();
  try {
    // usageRulesFromForm throws for a row with no effect: the message lands in setupError and nothing is posted
    const body: SetupBody = {
      board,
      status: statusFromForm(),
      maxConcurrent: Number($<HTMLInputElement>('max-workers').value),
      workers: $<HTMLSelectElement>('workers-mode').value as WorkersMode,
      epics: $<HTMLSelectElement>('epics').value as EpicsMode,
      promptTemplate: $<HTMLTextAreaElement>('prompt-template').value,
      budget: budgetFromForm(),
      usageRules: usageRulesFromForm(),
    };
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
    applyWorkersMode();
    closeSetup();
    showNotice(result.restartForPort ? `reinicie o Hive pra usar a porta ${result.restartForPort}` : undefined);
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
  applyWorkersMode();
  if (!setupInfo.configured) await openSetup();
  connect();
}

// ---------- events ----------

$('grid').addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const killId = target.dataset.kill;
  if (killId) {
    event.stopPropagation();
    if (confirm('Matar esse worker? A task volta pra fila.')) post(`/slots/${killId}/kill`);
    return;
  }
  const card = target.closest<HTMLElement>('.card.occupied');
  if (!card) return;
  selectedSlotId = card.dataset.id;
  renderDetail();
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
$('send').addEventListener('click', sendInput);
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendInput();
});

$('configure').addEventListener('click', () => void openSetup());
$('load-projects').addEventListener('click', () => void loadProjects());
$('board-type').addEventListener('change', applyBoardType);
$('load-columns').addEventListener('click', () => void loadMarkdownColumns());
$('project').addEventListener('change', () => void loadColumns());
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
