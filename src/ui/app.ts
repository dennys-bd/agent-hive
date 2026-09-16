import type { BoardConfig, EventsPayload, ProjectSummary, SetupBody, SetupInfo, SetupResult, Slot, State, StatusKey, Task } from '../types.js';

const STATUS_LABEL: Record<Slot['status'], string> = {
  vazio: 'vazio', trabalhando: 'trabalhando', esperando_voce: 'esperando você', aguardando_review: 'aguardando review',
};
const RERENDER_MS = 30_000;
// Mirrors DEFAULT_CONFIG in config.ts, which cannot be imported here (it pulls node:fs into the browser).
const PRESELECT: Record<StatusKey, string> = { queue: 'Ready', working: 'In progress', review: 'In review' };
const DEFAULT_MAX = 2;
const DEFAULT_OWNER = '@me';
const STATUS_KEYS: StatusKey[] = ['queue', 'working', 'review'];
const COLUMN_SELECT: Record<StatusKey, string> = { queue: 'col-queue', working: 'col-working', review: 'col-review' };
const MARKDOWN_INPUT: Record<StatusKey, string> = { queue: 'md-queue', working: 'md-working', review: 'md-review' };
const DEFAULT_MARKDOWN_PATH = 'board.md';

type BoardType = BoardConfig['type'];

let state: State | undefined;
let selectedSlotId: string | undefined;
let setupInfo: SetupInfo | undefined;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function elapsed(iso?: string): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
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
  const classes = ['card', slot.status, occupied ? 'occupied' : '', slot.draining ? 'draining' : ''].join(' ');
  if (!occupied) return `<div class="${classes}" data-id="${slot.id}"><div class="meta">${STATUS_LABEL.vazio}</div></div>`;
  return `
    <div class="${classes}" data-id="${slot.id}">
      <div class="title">#${esc(slot.task?.id ?? '')} ${esc(slot.task?.title ?? '')}</div>
      <div class="meta">${STATUS_LABEL[slot.status]} · ${elapsed(slot.startedAt)}${slot.draining ? ' · drenando' : ''}</div>
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

function renderDetail(): void {
  const slot = state?.slots.find((s) => s.id === selectedSlotId);
  const panel = $('detail');
  if (!slot || slot.status === 'vazio') {
    panel.classList.remove('show');
    selectedSlotId = undefined;
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
  panel.classList.add('show');
}

function render(): void {
  if (!state) return;
  const active = state.slots.filter((s) => s.status !== 'vazio').length;
  $('summary').textContent = `${active}/${state.maxConcurrent} workers ativos`;
  const max = $<HTMLInputElement>('max');
  if (document.activeElement !== max) max.value = String(state.maxConcurrent);
  $('polled').textContent = state.lastPolledAt ? `board: ${new Date(state.lastPolledAt).toLocaleTimeString()}` : '';
  showError(state.error);
  $('grid').innerHTML = state.slots.map(renderCard).join('');
  $('queue').innerHTML = state.queue.map((t) => `<li>#${esc(t.id)} ${esc(t.title)}</li>`).join('')
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

async function openSetup(): Promise<void> {
  const config = setupInfo?.config;
  const board = config?.board;
  document.body.classList.add('setup');
  $<HTMLButtonElement>('cancel').hidden = !setupInfo?.configured;
  $<HTMLSelectElement>('board-type').value = board?.type ?? 'github';
  applyBoardType();
  $<HTMLInputElement>('owner').value = board?.type === 'github' ? board.owner : DEFAULT_OWNER;
  $<HTMLInputElement>('md-path').value = board?.type === 'markdown' ? board.path : DEFAULT_MARKDOWN_PATH;
  for (const key of STATUS_KEYS) $<HTMLInputElement>(MARKDOWN_INPUT[key]).value = config?.status[key] ?? PRESELECT[key];
  $('md-options').innerHTML = '';
  $<HTMLInputElement>('max-workers').value = String(config?.maxConcurrent ?? DEFAULT_MAX);
  $<HTMLTextAreaElement>('prompt-template').value = config?.promptTemplate ?? '';
  setupError();
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
    setupError(boardType() === 'markdown' ? 'informe o caminho do arquivo' : 'escolha um project');
    return;
  }
  const body: SetupBody = {
    board,
    status: statusFromForm(),
    maxConcurrent: Number($<HTMLInputElement>('max-workers').value),
    promptTemplate: $<HTMLTextAreaElement>('prompt-template').value,
  };
  const save = $<HTMLButtonElement>('save');
  save.disabled = true;
  setupError();
  try {
    const result = await postJson<SetupResult>('/setup', body);
    setupInfo = await getJson<SetupInfo>('/setup');
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
$('load-columns').addEventListener('click', () => void loadMarkdownColumns());
$('project').addEventListener('change', () => void loadColumns());
$('setup').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSetup();
});
$('cancel').addEventListener('click', closeSetup);

setInterval(render, RERENDER_MS);
void init();
