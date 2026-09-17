# Agent Hive — worker embutido interativo (terminal sob demanda, painel só de detalhe)

Extensão dos workers embutidos (`2026-09-16-embedded-workers-design.md`) e da sessão no app (`2026-09-16-worker-session-design.md`). Objetivo: o worker embutido deixa de rodar em modo print (`-p`, JSON por stdio, sem prompt de permissão) e passa a ser uma sessão interativa de verdade, que roda escondida e é aberta num terminal por um botão dedicado no card e no painel. O painel lateral fica só com detalhe: status, PR, pergunta pendente, worktree, branch e um trecho do transcript. Vale para macOS e Linux. Issue: <https://github.com/dennys-bd/agent-hive/issues/37>.

Problema: em modo print não há classificador nem prompt de permissão, então qualquer ferramenta fora da allow list é negada e o worker encerra o turno pedindo aprovação a um humano que só tem uma linha de texto no painel (o worker do #25 travou em `gh issue view` por isso). No iTerm isso nunca aconteceu porque a sessão interativa aprova sozinha o que é seguro.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Como dar um PTY ao `claude` | Sessão `tmux` desanexada, num servidor só do Hive (`tmux -L hive`), uma sessão por worker com o nome do slug | `claude` interativo exige TTY; Node não cria PTY sem dependência nativa (`node-pty`) e um terminal dentro do app pediria ainda `xterm.js` e uma ponte de teclas. `tmux` é uma ferramenta de sistema como `gh` e `claude`, roda em macOS e Linux, e o "terminal" do worker vira o terminal que o usuário já usa. O socket próprio isola os workers do `tmux` pessoal do usuário e garante que o ambiente do servidor é o do Hive |
| `tmux` como requisito | Só do modo `embedded`; documentado no README e no hint do formulário (`brew install tmux` / `apt install tmux`) | Modo `iterm` continua sem `tmux`. Sem `tmux` instalado, o spawn falha, a falha aparece na barra de erro e o slot libera (mesmo comportamento de hoje sem `claude` no PATH) |
| Comando da sessão | `workerCommand(launch)` de `spawn-iterm.ts`, a mesma shell string do modo iTerm, passada ao `tmux new-session` como um único argumento | O `tmux` roda o comando pelo shell de qualquer jeito; reusar a string (já com `shellQuote`, `cd`, env inline, prompt via `$(cat)` e o `; curl /hooks/exit` no fim) mantém uma só shell string no repo. O `exit` vem do trailer, como no iTerm |
| Ambiente do filho | `execFile('tmux', …, { env: workerEnv(process.env, workerId, port) })`; `workerEnv` passa a tirar também `NODE_PATH` | O servidor `-L hive` nasce com o ambiente do primeiro cliente: sem `CLAUDECODE`, com as variáveis do Hive. O comando ainda leva `HIVE_WORKER_ID`/`HIVE_PORT` inline (é o que `workerCommand` faz). O Electron do Hive carrega um `NODE_PATH` apontando pro `node_modules` do Hive; herdado, um worker que rode `pnpm test` resolveria o `electron` do Hive e abriria uma janela que nunca fecha |
| Tamanho da sessão | `-x 200 -y 50` no `new-session` | Desanexada, a sessão seria 80×24 e a saída passada ficaria quebrada em 80 colunas quando o terminal abrisse. Ao anexar, o `tmux` redimensiona pro cliente |
| Abrir o terminal | `POST /slots/:id/focus` (rota que já existe) → `handle.focus()` → `openTerminal('tmux -L hive attach -d -t <slug>')`. macOS: tenta uma tab do iTerm2 (o `OPEN_TAB_SCRIPT` que já existe em `spawn-iterm.ts`) e, se o `osascript` falhar (iTerm ausente), usa o Terminal.app via `do script` + `activate`. Linux: `$TERMINAL` ou `x-terminal-emulator`, com `-e tmux -L hive attach -d -t <slug>` em argv | Zero config: quem tem iTerm2 (o caso do repo) ganha uma tab, quem não tem ganha o Terminal.app que todo Mac tem; `attach -d` faz a tab mais nova ganhar em vez de duas tabs disputarem tamanho. Linux é best effort sem teste local: a convenção `-e cmd args…` cobre xterm, urxvt, konsole, xfce4-terminal |
| Onde fica o botão | No card (`terminal`, ao lado de `kill`) e no painel (`ir pro terminal`, já existente, agora visível nos dois modos) | A issue pede um ícone dedicado no card ou no painel; o card é onde o usuário olha quando ele pisca `esperando você`. Um botão de texto segue o estilo do `kill` |
| Painel de detalhe | Só detalhe: título, PR, pergunta pendente, worktree, branch, link da issue e o trecho do transcript (`#output`). Some a linha de input e o `POST /slots/:id/input` | "Nothing else" na issue. Perguntas, permissões e follow-ups são respondidos no terminal, que é a sessão real. Sem input no painel, `send`/`end` no handle e no pool viram código morto e saem |
| Fonte do trecho do transcript | O `transcript_path` que todo hook manda; guardado em `Slot.transcriptPath` no `SessionStart` (só se for o transcript do próprio worker: um `.jsonl` direto em `<config do Claude>/projects/<cwd da worktree codificado>`, `isWorkerTranscript`; o server descarta o campo de qualquer hook que aponte pra outro lugar, já que qualquer processo local pode postar em `/hooks/event`), lido por `GET /slots/:id/output` como cauda do `.jsonl` e formatado por `formatOutput` (linhas `assistant`: texto, `▶ tool`, diff do `Edit`) | Não existe mais stdout: o worker é interativo. O transcript é o mesmo formato de linha do stream-json (`type: 'assistant'`, `message.content[]`), então o formatador e o realce do #8 continuam valendo sem mudar. Vale pros dois modos: o iTerm passa a ter trecho no painel também. Cauda de 256 KiB por leitura, sem estado no pool, sem persistir saída |
| `formatOutput` | Muda de `workers.ts` pra `src/transcript.ts`; some o caso `result` (não existe em `.jsonl`); linha que não é JSON some em vez de passar | O anel de saída do pool morre com o stdout. `stderr:` não existe mais |
| Erros do spawner | `WorkerHandlers.onLine` vira `onError(message)`; o pool encaminha pra `StartWorker.onError`; o server chama `fail('worker <slug>', …)` → `State.error` (barra de erro do dashboard) | Sem anel de saída, a única mensagem que um spawner produz é um erro (tmux/iTerm ausente). A barra de erro já existe e é onde o usuário olha |
| Fim da sessão com PR | No hook `Stop` de um slot em `aguardando_review`, o server chama `pool.kill(workerId)` (depois de responder 200). Vale pros dois modos | Paridade com o #7 ("após o `gh pr create` e o fim do turno, o slot esvazia sozinho"): fechar o stdin era isso em modo print. No iTerm isso remove a limitação documentada de o slot não liberar sozinho. O `exit` chega pelo trailer `curl` ou pelo `onExit` do handle (o `kill` do tmux chama os dois; o reducer ignora o segundo) |
| Detecção de "esperando você" | Só pelos hooks `Notification` (`permission_prompt`, `idle_prompt`, …), como na v1. Some o evento `idle` (vinha da linha `result` do modo print) | Interativo, o `claude` avisa pelo hook; não há `result` |
| Kill | `tmux -L hive kill-session -t <slug>` e `handlers.onExit()` em seguida (uma vez) | O `kill-session` manda SIGHUP; o trailer não roda, então o handle reporta o exit ele mesmo. iTerm continua com `pkill` pelo slug |
| Fechar o Hive / boot | Inalterados: `close()` → `pool.killAll()` (cada handle mata sua sessão); boot → `killStray` por slug + todo slot ocupado dado como morto | Regra "sem `claude` órfão" continua; readoção de sessões que sobreviveram fica fora |
| `WorkerLaunch.prompt` | Removido | Nenhum modo lê o prompt do launch: os dois usam `promptPath` via `$(cat …)` |
| Nome do modo | `workers: "embedded"` continua sendo o nome e o default | Compatível com os `hive.config.json` existentes; o significado (roda dentro do Hive, terminal sob demanda) é o mesmo pro usuário |

## Config

Sem campo novo. `workers: "embedded" | "iterm"` (default `embedded`). `claudeArgs` continua passando pro `claude`; o hint do formulário deixa de falar em modo print e passa a dizer que permissões e perguntas são respondidas no terminal do worker (botão `terminal` no card) e que o modo embutido precisa do `tmux`. `hive.config.json` continua sem tokens.

## Tipos (`src/types.ts`)

```ts
interface Slot { /* como hoje */ transcriptPath?: string } // from SessionStart; where GET /slots/:id/output reads the excerpt

type HiveEvent = /* como hoje, sem `idle` */;

interface WorkerHandlers {
  onExit(): void;              // once, on session end, kill or spawn failure
  onError(message: string): void; // spawner failures (tmux / iTerm missing or refused): shown in the dashboard error bar
}

interface WorkerHandle {
  kill(): void;              // tmux kill-session, or pkill by slug for a tab
  focus(): Promise<void>;    // opens (or brings to the front) the worker's terminal
}

interface WorkerLaunch { mode; workerId; slug; repo; port; hooksPath; promptPath; claudeArgs } // `prompt` removed
```

`WorkersMode` ganha o comentário: `embedded` = sessão `tmux` do Hive, terminal aberto sob demanda; `iterm` = tab do iTerm2.

## `src/spawn-tmux.ts` (novo)

- `TMUX_SOCKET = 'hive'`, `SESSION_COLS = 200`, `SESSION_ROWS = 50`.
- `tmuxArgs(...args)` = `['-L', TMUX_SOCKET, ...args]`.
- `attachArgv(slug)` = `['tmux', ...tmuxArgs('attach', '-d', '-t', slug)]`: o argv que o terminal roda; `terminal.ts` monta a shell string (com `shellQuote`) só onde um AppleScript digita o comando.
- `spawnTmuxWorker(launch, handlers, deps = { exec: execFileAsync, openTerminal })`: `exec('tmux', tmuxArgs('new-session', '-d', '-s', slug, '-c', repo, '-x', '200', '-y', '50', workerCommand(launch)), { env: workerEnv(process.env, workerId, port) })`. Falha → `onError('tmux: <mensagem>')` + `onExit()`. Handle: `kill` = `exec('tmux', tmuxArgs('kill-session', '-t', slug))` (falha reportada por `onError`, nunca lançada) e depois `onExit()`; `focus` = `deps.openTerminal(attachArgv(slug))`.
- `exec` é injetável (assinatura de `execFile` promisificado: `(file, args, opts) => Promise<{ stdout }>`), nunca uma shell string: o comando do worker é um argumento do argv do `tmux`.

## `src/terminal.ts` (novo)

- `openTerminal(argv: string[], deps = { exec: execFileAsync, platform: process.platform, env: process.env }): Promise<void>`.
- `darwin`: o argv vira uma shell string (`argv.map(shellQuote).join(' ')`) digitada por AppleScript: `osascript -e <OPEN_TAB_SCRIPT do iTerm2> <command>` (exportado de `spawn-iterm.ts` como `openItermTab(text, exec)`); se rejeitar, `osascript -e 'tell application "Terminal" to do script (item 1 of argv)' -e 'tell application "Terminal" to activate' <command>` (script com `on run argv`, como os do iTerm). Falha do Terminal.app propaga (a rota responde 500 com a mensagem).
- `linux`: `exec(env.TERMINAL ?? 'x-terminal-emulator', ['-e', ...argv])`: o argv vai direto, sem shell.
- Outra plataforma: rejeita com `terminal não suportado em <platform>`.

## `src/spawn-iterm.ts`

- Exporta `openItermTab(text, exec = execFileAsync): Promise<string>` (o `osascript(OPEN_TAB_SCRIPT, text)` de hoje) e continua usando internamente.
- `spawnItermWorker`: `report` vira `handlers.onError(\`iTerm: ${err.message}\`)`; handle sem `send`/`end`; `focus` obrigatório.

## `src/spawn.ts`

Mantém `renderPrompt`, `writePrompt`, `workerEnv`, `killStray`, `spawnWorker` (escolhe `spawnTmuxWorker` para `embedded`, `spawnItermWorker` para `iterm`). Some `workerArgv`, `userMessage`, `spawnEmbeddedWorker` e os imports de `spawn`/`readline`.

## `src/transcript.ts` (novo)

- `formatOutput(line): string[]` (movido de `workers.ts`, com `DIFF_MAX`, `DIFF_LINE_MAX`, `describeEdit`…): JSON inválido ou `type !== 'assistant'` → `[]`.
- `OUTPUT_LINES = 200`, `TAIL_BYTES = 256 * 1024`.
- `tailTranscript(path, max = OUTPUT_LINES): Promise<string[]>`: `stat` (rejeita se não é arquivo regular), lê os últimos `TAIL_BYTES` bytes com `open` + `read` no offset, divide em linhas, descarta a primeira quando a leitura começou depois do byte 0 (linha parcial), `flatMap(formatOutput)`, `slice(-max)`.

## `src/workers.ts`

Só o registro: `createWorkerPool(spawn)` → `{ start, kill, exit, focus, killAll, has }`. `StartWorker = { workerId, launch, onExit, onError }`. Some `lines`, `ended`, `send`, `end`, `output`, `onResult`, `formatOutput`. `focus(workerId)` → `false` quando desconhecido, senão aguarda `handle.focus()` e devolve `true`.

## `src/orchestrator.ts`

- Some `idle` e `QUESTION_MAX`.
- `SessionStart`: `patch(state, workerId, { worktree: p.cwd, branch, transcriptPath: isTranscriptPath(p.transcript_path) ? p.transcript_path : undefined })`.

## `src/server.ts`

- `spawn`: `pool.start({ workerId, launch: { …sem prompt }, onExit, onError: (message) => void fail(\`worker ${slot.slug}\`, new Error(message)) })`.
- Some `onTurnEnd`, `INPUT_MESSAGE`, `NO_TAB_MESSAGE`, `POST /slots/:id/input`.
- `POST /hooks/event`: depois do `dispatch` e do `res.sendStatus(200)`, se `payload.hook_event_name === 'Stop'` e o slot desse `workerId` está em `aguardando_review`, `pool.kill(workerId)` (falso quando desconhecido: nada a fazer, o slot é de um Hive anterior).
- `GET /slots/:id/output`: 404 se o slot não existe ou está `vazio`; senão `{ lines: slot.transcriptPath ? await tailTranscript(slot.transcriptPath).catch(() => []) : [] }`.
- `POST /slots/:id/focus`: 404 (`NO_WORKER_MESSAGE`) quando o slot não tem worker vivo no pool; 500 com a mensagem quando abrir o terminal falha.

## UI

- `index.html`: some a `.row` com `#input`/`#send`; somem as regras `body[data-workers=iterm] #output` e `body:not([data-workers=iterm]) #focus`; o card ganha `<button data-focus="<id>">terminal</button>` antes do `kill`; o select de `workers` diz `embutidos (sessão tmux; terminal pelo botão do card)` e `tabs do iTerm2 (macOS)`; o hint do prompt troca o trecho sobre modo print por: "Permissões e perguntas são respondidas no terminal do worker (botão `terminal` no card). O modo embutido precisa do `tmux` (`brew install tmux` / `apt install tmux`)".
- `app.ts`: somem `sendInput`, `INPUT_PLACEHOLDER`, `ANSWER_PLACEHOLDER`, `applyWorkersMode`, os listeners de `#send`/`#input`; `syncOutputPolling` não pula mais o modo `iterm`; o clique em `[data-focus]` faz `post('/slots/<id>/focus')` sem abrir o painel (`stopPropagation`, como o `kill`).

## README

Parágrafo dos modos, diagrama (`claude --worktree=<slug>` interativo numa sessão `tmux` do Hive), passo 2, requisitos (`tmux` para o modo embutido), uso ("clique em `terminal` para abrir a sessão e responder"), tabela de config (`claudeArgs` sem a nota de modo print) e limitações conhecidas (somem as duas primeiras; entra: "o painel mostra um trecho do transcript; a sessão é o terminal").

## Testes

- `test/spawn-tmux.test.ts` (novo, `exec` falso): `new-session` com o argv esperado (socket, `-d`, `-s slug`, `-c repo`, `-x/-y`, `workerCommand` como último argumento) e `env` sem `CLAUDECODE`; `new-session` rejeitado → `onError` com `tmux:` e `onExit` uma vez; `kill` → `kill-session` e `onExit` uma vez (também quando o `kill-session` rejeita); `focus` → `openTerminal(attachArgv(slug))`; `attachArgv`.
- `test/terminal.test.ts` (novo, `exec` falso): darwin tenta o iTerm com a shell string (argv com `shellQuote`) e para se der certo; iTerm rejeitado → Terminal.app com a mesma string como argumento do `osascript`; linux usa `$TERMINAL` ou `x-terminal-emulator` com `-e` e o argv direto; plataforma desconhecida rejeita.
- `test/transcript.test.ts` (novo): os testes de `formatOutput` que hoje estão em `test/workers.test.ts` (sem o caso `result`; não-JSON → `[]`); `tailTranscript` num arquivo temporário devolve as últimas `max` linhas formatadas, descarta a linha parcial quando o arquivo passa de `TAIL_BYTES`, rejeita num caminho inexistente.
- `test/workers.test.ts`: `start` registra e `has`; `kill`/`exit`/`focus`/`killAll`; `onError` chega ao `StartWorker.onError`; spawner que reporta `exit` antes de devolver o handle. Somem os testes de anel, `send`, `end`, `result`.
- `test/spawn.test.ts`: somem `workerArgv`, `userMessage`, `spawnEmbeddedWorker`; `workerCommand` e `shellQuote` ficam; entra `openItermTab` com `exec` falso (argv `-e <script> <text>`, devolve o `unique id`).
- `test/orchestrator.test.ts`: somem os testes de `idle`; `SessionStart` guarda `transcriptPath` válido e ignora um inválido.
- `test/server.test.ts`: `launch` sem `prompt`; `GET /slots/:id/output` devolve a cauda formatada do transcript apontado pelo `SessionStart` (arquivo temporário) e `[]` antes do hook; `Stop` com PR → `kill` no handle e o `exit` libera sem reenfileirar; `Stop` sem PR não mata; `focus` chega ao handle nos dois modos; `onError` do fake → `State.error`; somem os testes de `input` e de `result`.
- `test/fakes.ts`: `FakeWorker` sem `sent`/`ended`; `fakeSpawn()` sempre com `focus`; `LAUNCH` sem `prompt`.

## Critério de pronto

1. `pnpm start` num repo com `maxConcurrent = 1` e uma task em `Ready`, `tmux` instalado: o card fica verde sem nada abrir; `tmux -L hive ls` lista a sessão; clicar em `terminal` abre uma tab do iTerm2 (ou do Terminal.app) com o `claude` interativo; uma permissão pedida aparece no card como `esperando você` e é aprovada na tab; o painel mostra o trecho do transcript e nenhuma linha de input.
2. Após o `gh pr create` e o fim do turno, o slot esvazia sozinho e a sessão `tmux` some.
3. `kill` no card mata a sessão e devolve a task pra fila; fechar o Hive mata todas.
4. `pnpm test` verde com os testes acima.

## Fora

Terminal dentro do app (PTY + xterm.js); aprovação de permissão pelo dashboard; readoção de sessões `tmux` que sobreviveram a um restart do Hive; backoff quando o spawn falha repetidamente (`claude`/`tmux` ausentes reenfileiram e tentam de novo, como hoje); escolha do app de terminal por config.
