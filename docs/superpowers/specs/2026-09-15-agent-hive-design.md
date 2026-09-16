# Agent Hive — design v1

Dashboard desktop (Electron) que orquestra N sessões interativas do Claude Code em paralelo, cada uma em sua própria git worktree, puxando tasks de um board GitHub Projects v2. Substitui o fluxo "1 task por vez, esperando PR" por um pipeline com fila automática e status ao vivo.

Ferramenta reutilizável: board, repo, nomes de colunas e limites vêm de configuração. Nada específico da máquina de quem desenvolve é fixo no código.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Modo do worker | Interativo, em tab do iTerm2 | Você responde permissões/perguntas no terminal; `-p` não permite input humano |
| Terminal | iTerm2 via `osascript` | Já instalado; zero deps; clique no card foca o tab |
| Sinal de "slot livre" | `SessionEnd` **ou** `; curl /hooks/exit` após o `claude` | `Stop` dispara a cada turno e não serve; o `; curl` cobre tab fechado na força |
| Detecção de PR | Hook `PostToolUse` (Bash) contendo `gh pr create` | Automático, sem marcador no prompt |
| Board | GitHub Projects v2 via `gh` | Kanban real; `gh` já autenticado |
| Hooks | `--settings <repo>/.hive/hooks.json` por worker | Não toca o `settings.json` global; só workers do Hive reportam |
| Correlação worker↔hook | Env `HIVE_WORKER_ID`, enviado como header pelo `curl` | Sem juggling de `session_id` |
| Worktree | `claude --worktree <slug>` cria; path vem do `cwd` do `SessionStart` | Não usa hooks `WorktreeCreate/Remove` (eles *substituem* o git, não observam) |
| Transporte UI | Express serve HTML + SSE; Electron é só a janela | Um transporte em vez de IPC + HTTP; abre em browser pra debug |
| Linguagem | TypeScript, `tsc` só, sem bundler | Tipos compartilhados server↔UI; tooling mínimo |

## Configuração

`hive.config.json` na raiz do repo alvo. O Hive abre com `hive <repo>` ou picker de pasta e lembra o último.

```json
{
  "project": { "owner": "@me", "number": 6 },
  "status": { "queue": "Ready", "working": "In progress", "review": "In review" },
  "maxConcurrent": 2,
  "port": 47821,
  "claudeArgs": [],
  "promptTemplate": "Task #{number}: {title}\n\n{body}\n\nWork on this branch, open a PR with `gh pr create` when done."
}
```

- `project.owner` aceita `@me`, user ou org; `number` é o número do project.
- `status.*` são os nomes das opções do campo `Status`. IDs de campo/opção são resolvidos no boot e nunca ficam na config. Nome inexistente = erro no boot listando os nomes disponíveis.
- `claudeArgs` é anexado ao comando do worker (ex.: `["--model", "sonnet"]`).
- `promptTemplate` aceita `{number}`, `{title}`, `{body}`, `{url}`.
- `port` fixa. Se ocupada, o boot falha alto; não escolhe outra, porque o `hooks.json` de workers já vivos aponta pra ela.
- `config.ts` valida tipos e obrigatórios e falha com mensagem clara.

## Estado

Um objeto em memória, gravado em `<repo>/.hive/state.json` a cada mudança.

```ts
type Status = 'vazio' | 'trabalhando' | 'esperando_voce' | 'aguardando_review' | 'drenando';

interface Task { itemId: string; number: number; title: string; body: string; url: string }

interface Slot {
  id: string;             // uuid
  status: Status;
  task?: Task;
  slug?: string;          // hive-<number>-<kebab(title)[:30]>
  worktree?: string;      // cwd do SessionStart
  branch?: string;
  itermSessionId?: string;
  startedAt?: string;     // ISO
  lastEvent?: string;     // "Bash: pnpm test", "turno encerrado"...
  prUrl?: string;
  question?: string;      // message do Notification
}

interface State {
  maxConcurrent: number;
  slots: Slot[];          // length == maxConcurrent (+ drenando)
  queue: Task[];
  lastPolledAt?: string;
  error?: string;         // último stderr do gh, pro banner
}
```

`slots` tem exatamente `maxConcurrent` posições ocupáveis. Diminuir `maxConcurrent` não mata worker: slots excedentes ocupados viram `drenando` e são removidos quando esvaziam. Aumentar cria slots `vazio` e chama `fill()`.

## Máquina de estados do slot

```
vazio ──spawn──▶ trabalhando ──Notification(permission_prompt|idle_prompt|elicitation_*|agent_needs_input)──▶ esperando_voce
                     ▲                                                                                        │
                     └──────────────────────── UserPromptSubmit | PreToolUse ◀────────────────────────────────┘
trabalhando | esperando_voce ──PostToolUse(Bash, cmd contém "gh pr create", resposta contém URL de PR)──▶ aguardando_review
qualquer ocupado ──SessionEnd | POST /hooks/exit──▶ vazio (ou removido, se drenando) → fill()
```

- `Stop` só atualiza `lastEvent = "turno encerrado"`.
- Saída sem `prUrl`: item volta pra `status.queue` no board e pro fim de `state.queue`.
- Saída com `prUrl`: item fica em `status.review`; slot esvazia.
- `aguardando_review` continua ocupando o slot enquanto a sessão viver (você pode pedir ajustes no PR). Slot libera na saída da sessão.

## Fila e fill

- Poll do board a cada 30 s (`board.listQueue()`) + botão "atualizar" na UI.
- `state.queue` = itens em `status.queue`, na ordem do board, excluindo tasks já em slot.
- `fill()` roda sempre que: um slot vira `vazio`, `maxConcurrent` sobe, ou o poll traz item novo. Puxa do topo da fila pra cada slot `vazio`.

## Orquestrador (`orchestrator.ts`)

Puro: `reduce(state, event): { state, effects[] }`. Não conhece `gh`, iTerm nem fs. Efeitos (`spawn`, `setStatus`, `persist`, `broadcast`) são executados por `server.ts`. É o único módulo com testes automatizados na v1.

Eventos de entrada: `hook` (payload do Claude Code + workerId), `exit(workerId)`, `poll(tasks)`, `setMax(n)`, `kill(slotId)`, `boot(pidsVivos)`.

## Spawn (`spawn.ts`)

1. `slug = hive-<number>-<kebab(title) até 30 chars>`.
2. Renderiza `promptTemplate` → `<repo>/.hive/prompts/<slug>.md` (arquivo evita brigar com aspas/quebras de linha do body).
3. `board.setStatus(itemId, 'working')` (falha não cancela o spawn; loga e mostra banner).
4. `osascript` abre tab no iTerm2 rodando:
   ```sh
   cd <repo> && HIVE_WORKER_ID=<id> HIVE_PORT=<port> claude --worktree <slug> \
     --settings <repo>/.hive/hooks.json <claudeArgs> "$(cat <repo>/.hive/prompts/<slug>.md)"; \
   curl -s -m 2 -X POST localhost:<port>/hooks/exit -H 'x-hive-worker: <id>'
   ```
5. Guarda `itermSessionId` (`unique id` da session) no slot. Focar = `tell session id "…" to select` + ativar o iTerm.

**Kill**: `pkill -f -- "--worktree <slug>"`; o `; curl exit` cuida do resto. Remoção da worktree fica com o Claude Code (v1 não toca).

**Boot / restart do Hive**: recarrega `state.json`; para cada slot ocupado roda `pgrep -f -- "--worktree <slug>"`; morto → `vazio`. Tab do iTerm não é readotado (perde o foco-por-clique até o próximo spawn).

## Hooks (`hooks-settings.ts`)

Gerado no boot em `<repo>/.hive/hooks.json`. Todos os eventos usam o mesmo comando:

```sh
curl -s -m 2 -X POST localhost:<port>/hooks/event \
  -H "x-hive-worker: $HIVE_WORKER_ID" -H 'content-type: application/json' -d @- >/dev/null; exit 0
```

`-m 2` + `exit 0`: Hive morto ou lento nunca trava nem bloqueia um worker.

```json
{ "hooks": {
  "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "PostToolUse":      [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "Notification":     [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "Stop":             [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }],
  "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "<CURL>" }] }]
}}
```

Tabela evento → efeito:

| `hook_event_name` | efeito |
|---|---|
| `SessionStart` | `worktree = cwd`; `branch = git -C cwd branch --show-current` |
| `UserPromptSubmit`, `PreToolUse` | `status = trabalhando`; `lastEvent` = `"<tool_name>: <resumo do tool_input>"` |
| `Notification` | se `notification_type ∈ {permission_prompt, idle_prompt, elicitation_*, agent_needs_input}`: `status = esperando_voce`, `question = message`; senão ignora |
| `PostToolUse` | se `tool_input.command` contém `gh pr create` e `tool_response` contém `https://github.com/.../pull/N`: `status = aguardando_review`, `prUrl`, `board.setStatus(review)` |
| `Stop` | `lastEvent = "turno encerrado"` |
| `SessionEnd` | igual a `exit` |

Header `x-hive-worker` desconhecido → 200 e ignora (sessão de outro Hive/repo).

## Servidor (`server.ts`)

Express na `config.port`, só `localhost`.

| rota | função |
|---|---|
| `POST /hooks/event` | despacha pelo `hook_event_name` |
| `POST /hooks/exit` | slot → vazio |
| `GET /` | `ui/index.html` |
| `GET /ui/app.js` | UI compilada |
| `GET /events` | SSE; envia o `State` inteiro a cada mudança (sem diffs) |
| `POST /config` | `{ maxConcurrent }` |
| `POST /slots/:id/kill` | pkill |
| `POST /slots/:id/focus` | foca tab do iTerm |
| `POST /board/refresh` | força poll |

## Board (`board.ts`)

Wrapper fino de `execFile('gh', [...])` (sem shell). Três funções; é a única fronteira que outro backend (Linear, `board.json`) precisa reimplementar.

- `resolveFields(config)` — `gh project view` (projectId) + `gh project field-list --format json` → `statusFieldId` e `optionIds[queue|working|review]`.
- `listQueue()` — `gh project item-list --limit 200 --format json`, filtra `status == config.status.queue`, ignora drafts (sem issue → sem repo/branch), retorna `Task[]` na ordem do board.
- `setStatus(itemId, key)` — `gh project item-edit --id --project-id --field-id --single-select-option-id`.

Falha de `gh` não derruba nada: `state.error = stderr`, banner na UI, tenta de novo no próximo poll.

## UI (`ui/index.html` + `ui/app.ts`)

Sem framework. `EventSource('/events')` → re-renderiza tudo a cada estado.

- **Topo**: `N/M workers ativos` · `<input type="number">` do `maxConcurrent` · "atualizar board" · banner vermelho de `state.error`.
- **Grid**: um card por slot. Cores: `vazio` cinza, `trabalhando` verde, `esperando_voce` amarelo piscando (`@keyframes`), `aguardando_review` azul, `drenando` cinza riscado. Conteúdo: `#num título`, branch, `lastEvent`, tempo decorrido, botão kill.
- **Lateral**: fila em ordem com posição.
- **Painel de detalhe**: clique em card ocupado → `question` ou link do PR, "ir pro terminal", path da worktree.
- Links externos: Electron intercepta `will-navigate` / `setWindowOpenHandler` → `shell.openExternal`.

## Electron (`main.ts`)

Sobe o servidor, espera `listen`, abre `BrowserWindow` em `http://localhost:<port>` (tema escuro). Sem preload, sem IPC. Fechar a janela encerra o Hive; workers seguem vivos no iTerm e são readotados no próximo boot.

## Estrutura

```
agent-hive/
  package.json        deps: electron, express, typescript, @types/express, @types/node
  tsconfig.json       target es2022, module nodenext, strict, outDir dist
  src/
    main.ts  server.ts  orchestrator.ts  board.ts  spawn.ts  hooks-settings.ts  config.ts  types.ts
    ui/index.html  ui/app.ts
  test/               node --test sobre dist/
```

Scripts: `pnpm build` (tsc + cp html), `pnpm start` (build + `electron dist/main.js`), `pnpm test` (build + `node --test`).

## Testes

Automatizados (`node --test`, sem framework) só no orquestrador puro:

- `fill` respeita `maxConcurrent`, preenche em ordem do board, não duplica task já em slot.
- Cada linha da tabela de hooks: `Notification` só pros tipos listados; `gh pr create` vira `aguardando_review` com a URL; exit sem PR devolve pra fila; exit com PR não devolve.
- Reduzir `maxConcurrent` drena; aumentar dispara `fill`.
- `boot` com pids mortos esvazia slots.

`board.ts` / `spawn.ts` / UI: smoke manual = critério de pronto abaixo.

## Critério de pronto (v1)

1. `maxConcurrent = 3`, 5 itens em `Ready` no board → 3 tabs do iTerm abrem sozinhos com worktrees próprias, 2 itens aparecem na fila, os 3 itens vão pra `In progress` no board.
2. Matar um worker (kill no card ou fechar o tab) → slot esvazia, próximo da fila entra sozinho, item morto volta pra `Ready`.
3. Worker pede permissão → card fica amarelo piscando; clicar foca o tab certo; responder no terminal → card volta a verde.
4. Worker roda `gh pr create` → card azul com link do PR; item vai pra `In review`.

## Fora da v1

Aprovação inline pelo dashboard, notificação nativa/som, múltiplos repos, readoção de tabs do iTerm após restart, outros backends de board, outros terminais, multi-máquina, auth.
