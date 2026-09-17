# Agent Hive — interface reconstruída em Vite + React + shadcn/ui

Extensão da v1 (`2026-09-15-agent-hive-design.md`), do setup pela interface (`2026-09-16-hive-cli-and-setup-design.md`), do idioma (`2026-09-17-ui-language-design.md`) e das colunas do Hive (`2026-09-17-hive-columns-design.md`). Issue: [#81](https://github.com/dennys-bd/agent-hive/issues/81). Objetivo: as mesmas superfícies do dashboard e do formulário de setup, hoje HTML + TypeScript à mão em `src/ui/` (template strings em `innerHTML`, controles nativos estilizados um a um), passam a ser componentes React com shadcn/ui (Radix + Tailwind), empacotados pelo Vite. A interface continua um cliente fino da mesma API: o servidor, suas rotas e o `State` não mudam; a única alteração em `server.ts` é como os arquivos estáticos são servidos.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Stack | Vite + React 19 + shadcn/ui (Radix + Tailwind v4), componentes copiados pra `src/ui/components/ui/` pela CLI do shadcn | O que a issue pede; shadcn é código no repo, não dependência de runtime, então cada componente é ajustável à paleta |
| Build | Um só: `build: tsc && vite build`. `vite.config.ts` na raiz com `root: 'src/ui'`, `outDir: '../../dist/src/ui'`, `emptyOutDir: false`; `pnpm test`, `pnpm start` e `run:headless` continuam chamando `pnpm build` | O Express já serve `dist/src/ui`; `tsc` e Vite escrevem no mesmo diretório sem um apagar o outro |
| Divisão de compiladores | `src/ui/lib/*.ts`, `i18n.ts` e `highlight.ts` (sem DOM, sem React) compilam pelo `tsc` da raiz e são testados por `node:test`; `*.tsx`, `main.tsx` e o CSS só passam pelo Vite (`src/ui/tsconfig.json`); o `tsconfig.json` da raiz exclui `src/ui/**/*.tsx` e `src/ui/hooks/**` | Os testes existentes importam `dist/src/ui/i18n.js` e `highlight.js`; o Vite não precisa do `tsc` e o `tsc` não sabe importar CSS |
| Servir | `app.get('/')` → `index.html` e `app.use(express.static(UI_DIR))` depois do middleware de host/origem, no lugar das seis rotas `sendFile` | O Vite emite `assets/*-[hash].js\|css`; é a única mudança no servidor e não toca rota de API, `State` nem middleware |
| Dev | `dev: vite`, com `server.proxy` pras rotas da API (`/events`, `/setup`, `/slots`, `/cards`, `/config`, `/signal`, `/board`) em `127.0.0.1:<porta>` | HMR enquanto um Hive roda; cinco linhas de config |
| Estado → DOM | `useHiveState()` é dono do `EventSource('/events')`; `useSetupInfo()` do `GET /setup`; `App` guarda `mode` (`dashboard` \| `setup`), `selectedSlotId` e `language`. Sem biblioteca de estado | Cliente fino: um `State` por evento, renderizado inteiro; nada a memorizar |
| `i18n.ts` | Mantido como única fonte de texto; `t`, `setLanguage`, `statusText`, `slotEventText`, `LOCALE` inalterados. `applyTranslations` e os atributos `data-i18n*` são apagados; `language` vira estado React que chama `setLanguage` | Sem HTML estático não há o que varrer; os componentes chamam `t()` e re-renderizam quando `language` muda |
| `highlight.ts` | Mantido igual (string → HTML, já escapado); o componente `Output` renderiza via `dangerouslySetInnerHTML`; só o CSS das classes (`add`, `del`, `hunk`, `comment`, `string`, `number`, `keyword`) migra pra tokens | 82 linhas, zero dependências, testado; uma lib (shiki, prism) traria grammars pro bundle e ainda exigiria o parser de fences |
| Matemática dos medidores | `usageTotals`, `withinLimit`, `fmt`, `elapsed`, `windowLabel` saem do `app.ts` pra `src/ui/lib/usage.ts`, puro; os componentes importam | Hoje `limits.ts` é a tabela de regras (DOM), não a matemática; a matemática vira módulo testável por `node:test` e os hooks só chamam |
| Formulário de setup | Estado controlado `SetupDraft`; `lib/setup-form.ts` com `validateSetup(draft): { tab, message } \| undefined`, `toSetupBody(draft): SetupBody` e `draftFrom(setupInfo): SetupDraft` | As `Tabs` do Radix desmontam painéis escondidos, então a validação nativa + evento `invalid` não alcança mais os campos de outra aba |
| Multi-select de `from` | `Popover` + `Command` com checkboxes (padrão combobox do shadcn), mostrando os escolhidos como `Badge`s | Substitui o `<select multiple>` de #80; `onStart` / `onFinish` usam `Select` simples com a opção "—" |
| Confirmações e erros | `AlertDialog` pra `kill`, `close` e `raiseMax`; toasts (`sonner`) pra `state.error`, POST falho, SSE desconectado e `notice.restartPort` | O que a issue pede; some o `confirm()` nativo e as faixas `#error` / `#notice` |
| Detalhe | `Sheet` à direita com os mesmos dados de hoje (task, PR, pergunta pendente, worktree, branch, `claude --resume`, link do issue/board) e o `Output` (poll de 2 s enquanto aberto) | "Drawer" da issue; mesma informação, um componente |
| Tema | Só escuro; tokens do shadcn em `:root` mapeados pra paleta atual (`--bg #111418`, `--panel #1a1f26`, `--working`, `--waiting`, `--review`, `--danger`) | A issue põe o claro como nice-to-have; com tokens ele vira uma classe depois, sem reescrever componente |
| Sem CDN | Fontes do sistema, ícones de `lucide-react` no bundle | Electron e headless funcionam offline como hoje |
| Testes | `node:test` pros módulos puros (`i18n`, `highlight`, `lib/usage`, `lib/setup-form`); Vitest + Testing Library + jsdom só pra `ColumnEditor`, ações do card do `HiveBoard` e medidores do `Header`; `pnpm test` roda `node --test` e depois `vitest run` | Os componentes com lógica ganham teste de interação; o resto é fino e coberto por `tsc` + `vite build` |
| Lint | Biome continua, agora sobre `.tsx` também | Já está no CI; sem ESLint |
| Fora | Qualquer rota de API, `State`, `types.ts`, Electron, `run.ts`, features novas (drag and drop é #48), tema claro | Escopo da issue |

`docs/superpowers/specs/2026-09-15-agent-hive-design.md` continua valendo pro que não está aqui.

## Estrutura

```
vite.config.ts                 root src/ui, plugins react + @tailwindcss/vite, outDir dist/src/ui, proxy de dev
components.json                shadcn CLI (style default, tailwind css src/ui/index.css, alias @ → src/ui)
src/ui/
  index.html                   <div id="root"> + <script type="module" src="./main.tsx">
  main.tsx                     createRoot, <App/>, importa index.css
  index.css                    @import "tailwindcss"; tokens shadcn com a paleta atual; classes do highlight
  tsconfig.json                jsx react-jsx, lib dom, moduleResolution bundler, paths @/*
  App.tsx                      mode, selectedSlotId, language; escolhe <Dashboard/> ou <Setup/>
  hooks/use-hive-state.ts      EventSource, State | undefined, connected, tick de 30 s
  hooks/use-setup-info.ts      GET /setup, reload()
  hooks/use-output.ts          poll de /slots/:id/output enquanto há slot selecionado
  lib/api.ts                   getJson, postJson (header x-hive-ui), parseJson
  lib/usage.ts                 usageTotals, withinLimit, fmt, elapsed, windowLabel, QUOTA_RESERVE, isFree
  lib/setup-form.ts            SetupDraft, draftFrom, validateSetup, toSetupBody, columnsUrl
  i18n.ts                      inalterado menos applyTranslations
  highlight.ts                 inalterado
  components/ui/*              shadcn: button, input, select, tabs, sheet, alert-dialog, badge, card, progress, popover, command, toggle-group, textarea, sonner
  components/Header.tsx        resumo, max workers, sinal, medidores, quota, refresh, configurar, último poll
  components/HiveBoard.tsx     colunas + BoardCard
  components/SlotGrid.tsx      SlotCard por slot
  components/DetailSheet.tsx   dados do slot + <Output/>
  components/Output.tsx        renderOutput → dangerouslySetInnerHTML, scroll pro fim
  components/setup/Setup.tsx   Tabs, SetupDraft, salvar / cancelar
  components/setup/BoardTab.tsx, GeneralTab.tsx, LimitsTab.tsx
  components/setup/ColumnEditor.tsx, FromMultiSelect.tsx, RulesEditor.tsx
test/ui/*.test.tsx             Vitest (ColumnEditor, HiveBoard, Header)
```

Apagados: `src/ui/app.ts`, `src/ui/board.ts`, `src/ui/limits.ts` e o `index.html` atual.

## Scripts (`package.json`)

```json
"build": "tsc && vite build",
"dev": "vite",
"test": "pnpm build && node --test \"dist/test/*.test.js\" \"dist/test/boards/*.test.js\" && vitest run",
"lint": "biome lint --error-on-warnings",
"start": "pnpm build && node bin/hive.js",
"run:headless": "pnpm build && node dist/src/run.js"
```

- `tsc` da raiz: ganha `exclude: ["src/ui/**/*.tsx", "src/ui/hooks/**", "test/ui/**"]` (os hooks importam React); `lib` mantém `dom`.
- `vitest.config.ts`: `environment: 'jsdom'`, `include: ['test/ui/**/*.test.tsx']`, mesmo alias `@`.
- Dependências: `react`, `react-dom`, `lucide-react`, `sonner`, `class-variance-authority`, `clsx`, `tailwind-merge`, mais os pacotes `@radix-ui/*` que o shadcn instalar. Dev: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`, `@types/react`, `@types/react-dom`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`.
- CI (`.github/workflows/ci.yml`): inalterado; `pnpm test` já cobre o `vite build` e o Vitest.

## `src/server.ts`

```ts
app.get('/', (_req, res) => res.sendFile(join(UI_DIR, 'index.html')));
app.use(express.static(UI_DIR));
```

As seis rotas `sendFile` (`/`, `/ui/app.js`, `/ui/board.js`, `/ui/limits.js`, `/ui/highlight.js`, `/ui/i18n.js`) viram essas duas linhas, na mesma posição (depois do middleware de host e do header `x-hive-ui`). `express.static` não lista diretório nem sobe de `UI_DIR`. Nada mais muda: rotas, `requireLive`, `registerCardRoutes`, Electron (`loadURL` do mesmo `http://127.0.0.1:<porta>/`), `run.ts`.

## Estado e dados

- `useHiveState()`: abre `EventSource('/events')` uma vez; `onmessage` faz `JSON.parse` em `EventsPayload` e guarda só quando `'slots' in payload` (modo setup manda `{ configured: false }`); `onerror` marca `connected = false` (toast `error.disconnected`) e o `EventSource` reconecta sozinho. Um `setInterval` de 30 s incrementa um `tick` pra os `elapsed()` andarem sem evento novo.
- `useSetupInfo()`: `GET /setup` no mount; devolve `{ info, reload }`. `App` chama `setLanguage(info.language)` antes do primeiro render do conteúdo (renderiza nada até o `GET /setup` responder, como o `init()` de hoje) e abre o setup quando `!info.configured`.
- `useOutput(slotId)`: `GET /slots/:id/output` a cada 2 s enquanto `slotId` está definido; devolve `lines`; troca de slot zera; resposta de um slot antigo é ignorada.
- `lib/api.ts`: `getJson`, `postJson` (header `x-hive-ui: 1`, o gate CSRF do servidor), `parseJson` com `{ error }` → `Error`. Toda ação da interface passa por `postJson(...).catch(toast.error)`.
- Ações (mesmas rotas de hoje): `POST /config { maxConcurrent }`, `POST /signal { signal }`, `POST /board/refresh`, `POST /slots/:id/focus`, `POST /slots/:id/kill`, `POST /cards/:itemId/start` (com `{ raiseMax: true }` depois do `AlertDialog` quando nenhum slot está livre), `POST /cards/:itemId/close`, `POST /cards/:itemId/keep`, `POST /setup`.

## Superfícies

**Header.** `{active}/{max}` (`t('header.activeWorkers')`); `Input type=number` do max (POST no `onBlur`/Enter, não a cada tecla; não sobrescreve enquanto focado); `ToggleGroup` do sinal com a dica (`signal.yellow` / `signal.red`); um `Progress` por limite de budget configurado com percentual e a linha `usage.over` em vermelho; um `Progress` por janela de `rateLimits` com `limits.resets` e tooltip `limits.at`; quota do GitHub (`low` abaixo de `QUOTA_RESERVE`); botões refresh e configurar; `board: <hora do último poll>` à direita.

**HiveBoard.** Uma coluna por `state.columns`, título `nome · peso`, cards em ordem do board; `column.empty` quando vazia. `BoardCard`: `#id título`, meta (`statusText` do slot quando há, `branch ?? slug`, `card.orphan`), link do PR, e as ações de hoje na mesma regra: `missing` → barra vermelha com `fechar` / `manter`; com slot → `terminal`; `blockedBy` → texto; coluna com `prompt` → `iniciar`. Borda esquerda pela cor do status; `missing` vermelha; `orphan` com opacidade.

**SlotGrid.** Um `SlotCard` por slot: vazio mostra `status.empty`; ocupado mostra `#id título`, `statusText · elapsed · draining · tokens`, coluna e branch, `slotEventText(lastEvent)`, botões `terminal` e `kill` (este abre `AlertDialog` com `confirm.kill`). Clique no card ocupado seleciona o slot. `waiting` mantém o blink; `draining` risca o título.

**DetailSheet.** Aberto quando `selectedSlotId` aponta pra slot ocupado; fecha sozinho quando o slot esvazia. Conteúdo: título, PR, `detail.pending` + pergunta, worktree, branch, `detail.session` + `claude --resume <id>`, link `issue` (URL http) ou `board: <caminho>`, `<Output lines/>`, botões `detail.focus` e `detail.close`.

**Output.** `renderOutput(lines)` de `highlight.ts` em `dangerouslySetInnerHTML` (o módulo escapa cada caractere do worker antes de qualquer markup); `useEffect` rola pro fim quando `lines` muda. Classes `add`/`del`/`hunk`/`comment`/`string`/`number`/`keyword` definidas em `index.css` com os tokens.

**Setup.** `Tabs` board / geral / limites. Estado `SetupDraft` (strings como o usuário digitou, listas de linhas de coluna e de regra). Aba board: `Select` do tipo; GitHub → owner + `carregar` + `Select` de projeto + quota; markdown → caminho + `carregar` + dica; `ColumnEditor` com uma linha por coluna (nome, peso, sessão, modelo, `FromMultiSelect`, onStart, onFinish, prompt, ↑ ↓ remover, adicionar). As opções de coluna do board vêm de `GET /setup/columns?…` (`columnsUrl`) e se fundem com os valores já salvos, como hoje. Aba geral: idioma, modo dos workers. Aba limites: tokens/hora, tokens/dia, `usage.raw`, `RulesEditor` (percent, max workers, sinal, remover, adicionar). Salvar: `validateSetup(draft)` → se erro, muda pra `tab` e mostra `message`; senão `POST /setup` com `toSetupBody(draft)`, `reload()` do setup info, `setLanguage`, volta ao dashboard, toast `notice.restartPort` se vier. Cancelar só existe quando `configured`.

## `src/ui/lib/setup-form.ts`

```ts
interface ColumnDraft { name: string; weight: string; session: 'new' | 'continue'; model: string; from: string[]; onStart: string; onFinish: string; prompt: string }
interface RuleDraft { percent: string; maxWorkers: string; signal: Signal | '' }
interface SetupDraft {
  boardType: BoardConfig['type']; owner: string; project: string; markdownPath: string;
  columns: ColumnDraft[]; language: Language; workers: WorkersMode; epics: EpicsMode;
  budgetHour: string; budgetDay: string; rules: RuleDraft[];
}
type SetupTab = 'board' | 'general' | 'limits';

function draftFrom(info?: SetupInfo): SetupDraft;                      // defaults de hoje: @me, board.md, ignore, embedded, idioma efetivo
function validateSetup(draft: SetupDraft): { tab: SetupTab; message: string } | undefined;
function toSetupBody(draft: SetupDraft): SetupBody;                    // chaves ausentes ficam ausentes (model, onStart, onFinish, prompt, session=new, budget vazio)
function columnsUrl(draft: SetupDraft): string | undefined;            // undefined quando o board ainda não está escolhido
```

`validateSetup` reproduz a ordem de hoje: board sem projeto/caminho (`setup.error.project` / `setup.error.path`, aba board); nenhuma coluna (`setup.columns.none`, board); coluna com nome vazio ou peso não inteiro ≥ 0 (chave nova `setup.columns.error` com `{ n }`, board); regra sem efeito ou percent fora de 0–100 (`setup.rules.error`, limites); budget não inteiro ≥ 0 (`setup.budgetHint`, limites). O servidor continua validando o resto.

## Testes

`node:test` (como hoje, via `dist/test`):
- `test/highlight.test.ts`, `test/i18n.test.ts`: inalterados menos o que testar `applyTranslations`, que sai.
- `test/ui-usage.test.ts`: `usageTotals` (janela de 1 h e 24 h), `withinLimit` (0 / ausente = sem limite), `fmt` (842, 12.3k, 1.2M), `elapsed`, `windowLabel` (`five_hour`, `seven_day_opus`, desconhecido).
- `test/setup-form.test.ts`: `draftFrom` de um `SetupInfo` github, markdown e vazio; `validateSetup` devolve a aba certa em cada erro e `undefined` num draft válido; `toSetupBody` não emite chaves vazias e mantém a ordem das colunas/regras; `columnsUrl` pros dois tipos.
- `test/server.test.ts`: uma asserção a mais: o asset JS que `dist/src/ui/index.html` referencia responde 200 com `content-type` de JavaScript, e `GET /ui/app.js` agora é 404.

Vitest + Testing Library (`test/ui/`):
- `ColumnEditor.test.tsx`: `FromMultiSelect` marca e desmarca opções e mantém um valor salvo que não está entre as carregadas; adicionar / mover / remover linha refletem no `onChange`.
- `HiveBoard.test.tsx`: com `missing` mostra `fechar` / `manter`; com slot mostra `terminal`; com `blockedBy` não mostra `iniciar`; coluna sem `prompt` não mostra `iniciar`; `iniciar` sem slot livre abre o `AlertDialog` com `confirm.raiseMax` e confirma com `{ raiseMax: true }` (fetch mockado).
- `Header.test.tsx`: percentuais dos medidores, estado `over budget`, medidor de janela com `limits.resets`.

## Critério de pronto

- `pnpm build` gera `dist/src/ui/index.html` + `assets/`; `pnpm start`, `run:headless` e o Electron abrem a mesma URL e mostram o dashboard (ou o setup quando não configurado) sem nenhum recurso externo.
- Toda ação de hoje (sinal, max workers, refresh, terminal, kill, iniciar, fechar, manter, configurar, salvar) chama a mesma rota com o mesmo corpo; confirmações são `AlertDialog`s e erros são toasts.
- Trocar o idioma no setup troca todo o texto sem recarregar.
- `pnpm lint` e `pnpm test` verdes (node:test + vitest); `src/ui/app.ts`, `board.ts`, `limits.ts` e as seis rotas `sendFile` não existem mais.
- README: seção de desenvolvimento ganha `pnpm dev` (proxy pra um Hive rodando) e a nota de que a UI é Vite + React + shadcn.

## Fora

- Qualquer rota de API, o `State`, `types.ts`, o orquestrador, Electron e `run.ts` além do que está em `src/server.ts` acima.
- Tema claro (tokens ficam prontos; a classe fica pra outra issue).
- Drag and drop entre colunas (#48) e qualquer feature que a interface atual não tem.
- Migrar os testes do servidor pro Vitest.
