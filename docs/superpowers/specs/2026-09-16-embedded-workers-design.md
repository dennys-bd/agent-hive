# Agent Hive — workers embutidos (sem terminal externo)

Extensão da v1 (`2026-09-15-agent-hive-design.md`). Objetivo: o próprio Hive (Electron ou `run:headless`) passa a ser o processo pai de cada `claude`, sem iTerm, `osascript`, `pgrep` nem `pkill` no caminho normal. O worker roda em modo print com entrada e saída em JSON por stdio; o painel de detalhe do dashboard mostra a saída e aceita mensagens de follow-up. Vale para macOS e Linux. Issue: <https://github.com/dennys-bd/agent-hive/issues/7>.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Como rodar o `claude` | `child_process.spawn('claude', argv, { cwd: repo, stdio: pipe })`, argv em array | Zero dependências novas; `execFile`/`spawn` com argv já é a regra do repo |
| Modo do worker | `-p --input-format stream-json --output-format stream-json --verbose` | É o único modo documentado com entrada e saída por stdio; a sessão fica viva até EOF no stdin, então follow-ups continuam possíveis |
| Prompt inicial | Primeira mensagem `{"type":"user",...}` no stdin | Evita limite de tamanho de argv; o arquivo `.hive/prompts/<slug>.md` continua sendo escrito como registro |
| Permissões | Não há prompt de permissão em modo print: a ferramenta é negada. Permissões vêm de `claudeArgs` (ex.: `--permission-mode acceptEdits`) e do `.claude/settings.json` do repo, que o `claude` carrega normalmente | O protocolo de aprovação por stdio não é documentado fora do Agent SDK; adotar o SDK seria uma dependência de runtime grande e com CLI próprio. Aprovação inline pelo dashboard fica para outra issue |
| Saída do worker | Buffer em memória por worker (últimas 200 linhas formatadas), `GET /slots/:id/output` | Não entra no `State`: evitaria um `persist` + broadcast por linha e incharia o `state.json`; morreu o processo, a saída não interessa mais |
| Entrada do worker | `POST /slots/:id/input { text }` grava uma mensagem `user` no stdin | É o que "o app é dono da entrada" significa; o hook `UserPromptSubmit` já muda o status do slot |
| Fim da sessão | Ao chegar um `result` com o slot em `aguardando_review` (PR aberto), o Hive fecha o stdin; sem PR, a sessão fica aberta esperando follow-up | Slot libera sozinho quando a task acabou; sem PR o humano ainda pode orientar via input ou matar |
| Kill | `SIGTERM` no filho; o `exit` do processo libera o slot | Sem `pkill -f`; processo desconhecido (após restart) → `exit` direto, como hoje |
| Boot / restart | Todo slot ocupado é dado como morto (`boot` sem `aliveSlugs`); antes disso, `pkill -f -- --worktree=<slug>` em cada slug ocupado limpa órfãos | Os workers são filhos do Hive: sem Hive, sem worker. O `pkill` é só defesa contra um órfão que ainda segure a worktree |
| Encerrar o Hive | `close()` manda `SIGTERM` a todos os filhos; o Electron chama no `will-quit` | Não deixar `claude` órfão rodando às cegas |
| Ambiente do filho | `process.env` + `HIVE_WORKER_ID`, `HIVE_PORT`, sem `CLAUDECODE` | Os hooks via curl continuam iguais; `CLAUDECODE` herdado de um Hive lançado de dentro de uma sessão do Claude Code impediria o filho de subir |
| Foco no terminal | Removido (`POST /slots/:id/focus`, botão "ir pro terminal", `itermSessionId`, evento `spawned`) | Não existe mais tab; o painel de detalhe é o terminal |
| `POST /hooks/exit` | Removido | O `exit` vem do processo filho |

## Config

`workers: "embedded" | "iterm"` (default `embedded`), no arquivo e no formulário de setup. `claudeArgs` passa a ser onde o usuário define o modo de permissão do worker embutido (o hint do formulário diz isso). `hive.config.json` continua sem tokens.

## Modo `iterm` (adendo)

O modo iTerm2 da v1 continua disponível atrás da mesma interface `SpawnWorker`, escolhido por `config.workers`. `src/spawn-iterm.ts` guarda o que era o `spawn.ts` da v1: `shellQuote`, `workerCommand` (a única shell string do repo, digitada na tab pelo `osascript`) e os scripts de abrir tab, focar e digitar. Diferenças em relação ao embutido: `send` digita na tab (`write text`), `end` é no-op, `kill` é `pkill` pelo slug, `focus` traz a tab pra frente (`POST /slots/:id/focus`, botão "ir pro terminal"), a saída não chega ao painel e o `exit` vem do `; curl /hooks/exit` no fim do comando (a rota volta e encaminha pro pool via `pool.exit`). Permissões viram prompt interativo no terminal. Restart do Hive não readota tabs: mata e devolve as tasks pra fila, igual ao embutido.

## Tipos

```ts
interface Slot { /* como hoje, sem itermSessionId */ }

type HiveEvent =
  | { type: 'boot' }                       // antes: { type: 'boot'; aliveSlugs: string[] }
  | /* poll, setMax, setSignal, setBudget, setUsageRules, hook, exit, kill, error inalterados */
  // `spawned` removido

/** O que o server injeta para não abrir processo em teste. */
interface WorkerHandlers { onLine(line: string): void; onExit(): void }
interface WorkerHandle { send(text: string): void; end(): void; kill(): void }
type SpawnWorker = (argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, handlers: WorkerHandlers) => WorkerHandle;
```

## `src/spawn.ts`

Mantém `renderPrompt`, `writePrompt`. Remove `shellQuote`, `workerCommand`, `openWorker`, `focusWorker`, `aliveSlugs`. Novo:

- `workerArgv(o: { slug, hooksPath, claudeArgs }): string[]` = `['--worktree=<slug>', '--settings', hooksPath, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...claudeArgs]`.
- `workerEnv(base, workerId, port)`: cópia de `base` sem `CLAUDECODE`, com `HIVE_WORKER_ID` e `HIVE_PORT`.
- `spawnWorker: SpawnWorker` real: `spawn('claude', argv, { cwd, env, stdio: ['pipe','pipe','pipe'] })`; `readline` em stdout e stderr chama `onLine` (stderr prefixado com `stderr: `); `exit`/`error` do processo chamam `onExit` uma vez. `send(text)` grava `JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'`; `end()` fecha o stdin; `kill()` manda `SIGTERM`.
- `killStray(slug)`: o `killWorker` de hoje (`pkill -f -- --worktree=<slug>`), usado só no boot.

## `src/workers.ts` (novo)

Registro em memória dos processos vivos, chave `workerId`:

- `createWorkerPool(spawn: SpawnWorker)` → `{ start, send, end, kill, killAll, output, has }`.
- `start({ workerId, argv, cwd, env, prompt, onExit, onResult })`: abre o processo, manda o prompt como primeira mensagem, guarda o handle e o buffer de saída. Cada linha passa por `formatOutput(line)`; o que voltar entra no buffer (ring de 200). Uma linha `{"type":"result"}` também chama `onResult(workerId)`. No `exit`, remove do registro e chama `onExit`.
- `formatOutput(line): string[]`: JSON inválido → a linha como está (stderr, avisos do CLI). `assistant` → cada bloco `text` (até 2000 chars) e cada `tool_use` como `▶ <name>: <command | file_path | pattern | description>` (até 120 chars). `result` → `✔ turno encerrado`. `system`, `user` (tool results), `stream_event` → nada.
- `output(workerId)`: cópia do buffer; `[]` se desconhecido.
- `send(workerId, text)` / `end(workerId)` / `kill(workerId)`: `false` se desconhecido.

## `src/server.ts`

- `ServerDeps.spawnWorker?: SpawnWorker` (default: o real). O pool é criado em `createServer`.
- Efeito `spawn`: `writePrompt` + `pool.start({ ..., onExit: () => dispatch({ type: 'exit', workerId }), onResult })`. `onResult`: se o slot desse `workerId` está em `aguardando_review`, `pool.end(workerId)`.
- Efeito `kill`: `pool.kill(workerId)`; se `false`, `dispatch({ type: 'exit', workerId })`.
- `configure` / `bootHive`: `killStray` em cada slug ocupado do estado salvo, depois `dispatch({ type: 'boot' })`. `detectAlive` some.
- `close()`: `pool.killAll()` antes de fechar o HTTP.
- Rotas novas: `GET /slots/:id/output` → `{ lines: string[] }` (404 se o slot não existe ou está `vazio`); `POST /slots/:id/input { text }` → 400 se `text` não é string não vazia, 404 se não há processo vivo para o slot, senão `pool.send` e `{ ok: true }`.
- Removidas: `POST /hooks/exit`, `POST /slots/:id/focus`.

## `src/orchestrator.ts`

- `boot`: sem `aliveSlugs`; todo slot ocupado passa por `exit` (task sem PR volta pra fila, como hoje).
- `spawned` removido.

## `src/main.ts`

`app.on('will-quit')` → `server.close()` (best effort, sem esperar além do que o Electron dá).

## UI

- Painel de detalhe: sai "ir pro terminal"; entra `<pre id="output">` (monoespaçado, `max-height` com scroll, rola pro fim quando cresce) e uma linha `input` + botão "enviar" (`Enter` também envia). Enquanto o painel está aberto, a UI busca `GET /slots/:id/output` a cada 2 s e ao abrir. Fechar o painel para o polling.
- Hint do campo `prompt do worker` ganha uma linha sobre permissões: em modo print não há prompt de permissão, então `claudeArgs` no `hive.config.json` (ex.: `["--permission-mode", "acceptEdits"]`) ou o `.claude/settings.json` do repo precisam liberar as ferramentas.
- Confirmação do kill continua: "Matar esse worker? A task volta pra fila." (verdade sem PR; com PR o slot só libera).

## Testes

- `test/spawn.test.ts`: `workerArgv` (ordem e flags), `workerEnv` (remove `CLAUDECODE`, injeta os dois), `killStray` sem processo → `false`. Somem os testes de `shellQuote` / `workerCommand` / `aliveSlugs`.
- `test/workers.test.ts` (novo, spawn falso): `formatOutput` para `assistant` com text e tool_use, `result`, `system`, JSON inválido; `start` manda o prompt como primeira mensagem `user`; ring de 200; `onResult` no `result`; `exit` remove do registro e chama `onExit`; `send`/`kill` em desconhecido → `false`; `killAll`.
- `test/orchestrator.test.ts`: `boot` sem `aliveSlugs` esvazia todo slot ocupado; teste de `spawned` removido.
- `test/setup.test.ts` ou `test/server.test.ts` (novo): com `spawnWorker` falso e `maxConcurrent: 1`, salvar o setup abre um worker com o argv esperado e `cwd = repo`; `POST /slots/:id/input` grava no falso; `GET /slots/:id/output` devolve o que o falso emitiu; `result` com PR fecha o stdin; `exit` do falso libera o slot; `POST /slots/:id/kill` chama `kill` do handle; `close()` mata todos.

## Critério de pronto

1. `pnpm start` num repo configurado com `maxConcurrent = 1` e uma task em `Ready`: o card fica verde sem nenhum tab de terminal abrir; o painel de detalhe mostra o que o worker está fazendo; digitar uma mensagem e enviar aparece como `prompt enviado` no card; após o `gh pr create` e o fim do turno, o slot esvazia sozinho.
2. Fechar o Hive encerra os workers; abrir de novo dá os slots como vazios e as tasks sem PR voltam pra fila.
3. `pnpm test` verde com os testes acima.

## Fora

Aprovação de permissões pelo dashboard (`canUseTool` / protocolo de controle); readoção de workers após restart; terminal completo (PTY + xterm); múltiplas mensagens de follow-up enfileiradas enquanto o worker está no meio de um turno (o `claude` já enfileira); streaming parcial (`--include-partial-messages`).
