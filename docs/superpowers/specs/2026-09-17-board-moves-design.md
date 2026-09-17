# Agent Hive — quem move o card: Hive, agente ou humano

Extensão dos boards plugáveis (`docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`) e dos épicos (`docs/superpowers/specs/2026-09-16-ignore-epics-design.md`) sobre a v1 (`docs/superpowers/specs/2026-09-15-agent-hive-design.md`), que é autoritativa pra tudo que não está aqui. Issue: <https://github.com/dennys-bd/agent-hive/issues/42>.

Hoje o Hive move o card em três momentos fixos: pra `status.working` ao abrir o worker, pra `status.review` quando um `gh pr create` aparece num `PostToolUse`, e de volta pra `status.queue` quando o worker sai sem PR. O agente não sabe que isso acontece, e um command que já move o card por conta própria (o `/roadmap-flow` deste repo, por exemplo) disputa o board com o Hive: a volta pro `Backlog` na saída sem PR desfaz o que o agente fez. Passa a existir uma config por transição dizendo quem faz o movimento: o Hive (como hoje), o agente (de dentro da sessão) ou um humano (ninguém automatiza). Só o delta está descrito aqui.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Quais transições | As três de hoje, chaveadas pela coluna de destino: `working` (abrir o worker → `status.working`), `review` (PR aberto → `status.review`), `queue` (saída sem PR → `status.queue`) | Só existe no código o que o Hive já faz; a chave pela coluna de destino é a mesma `StatusKey` do resto. `Done` no merge (#23) e `Blocked` não existem como transição do Hive e ficam de fora; o objeto aceita chaves novas quando elas existirem |
| Config | `moves: { working, review, queue }`, cada valor ∈ `hive` \| `agent` \| `human`, default `hive` em todas | `hive` = comportamento de hoje, então um `hive.config.json` antigo não muda nada. Objeto parcial aceito: chave ausente é `hive` |
| O que `agent` faz | O Hive **não** escreve no board naquela transição e acrescenta ao final do prompt do worker um parágrafo com os movimentos que são dele, com os nomes das colunas de `status` | O agente já sabe mexer no board com `gh` (é assim que o `/roadmap-flow` faz, lendo o `hive.config.json`); o Hive só precisa dizer o que não vai fazer. Sem placeholder novo: o parágrafo vai anexado ao template renderizado, então templates já salvos funcionam sem edição |
| O que `human` faz | O Hive não escreve no board e o prompt não diz nada | Movimento à mão, no GitHub ou no arquivo; o Hive só observa pelo poll |
| Estado interno do slot | **Não muda** com `moves`: `trabalhando` → `aguardando_review` continua vindo do `gh pr create` no `PostToolUse`, e o Stop com PR continua encerrando a sessão | `moves` governa só a escrita no board. O Hive não passa a vigiar o board pra saber do PR: a detecção frágil do `gh pr create` (push + PR pela web é invisível) é outra issue e não piora nem melhora aqui |
| Saída sem PR com `queue` ≠ `hive` | O slot é liberado e a task **não** volta pra fila em memória nem gera efeito | Quem decide se a task volta é o agente ou o humano, movendo o card; o poll seguinte a vê na coluna da fila. Com `hive` tudo segue como hoje (fila em memória + `setStatus(queue)`) |
| `working` ≠ `hive` | O card fica na coluna da fila enquanto o worker roda; `poll` já exclui tasks em slot pelo `itemId`, então não é reaberta | Consequência declarada: se ninguém mover o card pra `In progress`, ele volta a ser elegível assim que o worker sair. É o que "o board é a verdade" significa |
| Onde a regra vive | `State.moves?: Moves` (copiado da config em `bootHive`, `configure` e `reconfigure`, como `budget`); o reducer consulta `hiveMoves(state, key)` em `fill`, no `PostToolUse` e em `exit` | O reducer é quem emite `setStatus` e quem decide a fila em memória; precisa saber. Opcional e lido com default `hive` pra `state.json` antigos não precisarem de migração; a config sobrescreve no boot antes de qualquer evento |
| Ordem no boot | `moves` entra no estado **antes** do evento `boot`, nos dois caminhos de boot: `bootHive` (app com `hive.config.json`, que monta o estado sozinho e nunca chama `configure`) e `configure` (`POST /setup`) | O `boot` dá todo slot ocupado como morto e passa por `exit`; a regra de requeue tem de ser a da config atual, não a do `state.json` |
| Sem evento novo | `bootHive`, `configure` e `reconfigure` gravam `moves` direto no estado que montam (a mesma linha onde `bootHive` já copia `budget` e `usageRules`, e onde `configure` já zera `queue`); não há `setMoves` | Nada reage à mudança (sem `fill`, sem `releasePaused`); um evento só pra copiar um valor é cerimônia |
| Interface `Board` e adapters | Inalterados | O adapter só recebe menos chamadas |
| Setup | Bloco "quem move o card" no painel `board`, abaixo dos dois fieldsets, com um `<select>` por transição (`Hive` / `agente` / `à mão`); `SetupBody.moves?` opcional, ausente mantém o atual (ou tudo `hive` no primeiro setup) | Mesmo padrão de `workers` e `epics`; vale pros dois tipos de board |
| Dashboard mover card à mão | Fora | Não existe hoje; `human` é "ninguém automatiza", não "botão no dashboard" |
| Vigiar o board no lugar do hook | Fora | Cabe em #23 (PR-watching) e passa pelo `shouldPoll` de #25; aqui o hook continua sendo o gatilho do estado interno |
| Épicos | Intocados (#31): o Hive não os move hoje e continua não movendo | Fora do contrato, como já estava |

## Config

```json
"moves": { "working": "hive", "review": "agent", "queue": "human" }
```

`parseConfig`: `moves` opcional; deve ser objeto, senão `hive.config.json: "moves" must be an object`. Cada chave de `MOVE_KEYS = ['working', 'review', 'queue']` é opcional, ∈ `MOVERS = ['hive', 'agent', 'human']`, default `'hive'`; valor fora → `hive.config.json: "moves.review" must be one of: hive, agent, human`. `DEFAULT_CONFIG.moves = { working: 'hive', review: 'hive', queue: 'hive' }`. Salvar pela UI grava o objeto completo.

## Types

```ts
/** Who performs one board move: the Hive (today's behaviour), the worker from inside its session, or nobody automated. */
export type Mover = 'hive' | 'agent' | 'human';
/** One entry per transition, keyed by the column it lands on: working (spawn), review (PR seen), queue (exit without a PR). */
export type Moves = Record<StatusKey, Mover>;

interface Config { /* … */ moves: Moves; }
interface State { /* … */ moves?: Moves; } // set from Config on configure / reconfigure; absent (legacy state.json) reads as all hive
interface SetupBody { /* … */ moves?: Moves; } // optional; missing keeps the current value (or all hive on first setup)
```

`Task`, `Slot`, `HiveEvent`, `Effect`, `Board` não mudam.

## `src/orchestrator.ts`

- `hiveMoves(state, key): boolean` = `(state.moves?.[key] ?? 'hive') === 'hive'`.
- `fill`: o par de efeitos por spawn vira `[...(hiveMoves(state, 'working') ? [setStatus working] : []), spawn]`.
- `applyHook` / `PostToolUse` com PR: o slot vai pra `aguardando_review` e guarda `prUrl` como hoje; o efeito `setStatus review` só sai com `hiveMoves(state, 'review')`.
- `exit`: `requeue` só quando `slot.task && !slot.prUrl && hiveMoves(state, 'queue')`; sem requeue não há efeito nem entrada na fila. `boot` passa por `exit` e herda a regra.

## `src/spawn.ts`

- `movesNote(moves, status): string` — `''` quando nenhuma transição é `agent`; senão `\n\nBoard moves you own (the Hive will not make them): ` seguido das partes, na ordem `working`, `review`, `queue`, separadas por `; ` e com `.` no fim:
  - `working`: `move this task's card to "<status.working>" now, at the start`
  - `review`: `move it to "<status.review>" when you open the PR`
  - `queue`: `move it back to "<status.queue>" if you stop without a PR`
- Em inglês, como o template default. `renderPrompt` não muda; o servidor concatena `renderPrompt(...) + movesNote(...)` ao escrever o arquivo do prompt.

## `src/server.ts`

- `configure`: `live = { runtime, state: { ...saved, queue: [], moves: config.moves } }` antes do `dispatch({ type: 'boot' })`.
- `reconfigure`: `live = { runtime, state: { ...live.state, moves: config.moves } }`; o `poll()` que já vem em seguida persiste e transmite.
- `spawn`: o texto gravado por `writePrompt` é `renderPrompt(config.promptTemplate, task) + movesNote(config.moves, config.status)`.
- `saveSetup`: `moves: body.moves ?? current?.moves`.
- `activate` loga `moves=working:hive,review:agent,queue:human` na linha de config.

## `src/hive.ts`

- `bootHive`: o estado montado a partir do `state.json` ganha `moves: config.moves` na mesma linha que já copia `budget` e `usageRules`, antes do `dispatch({ type: 'boot' })`.

`src/state-store.ts` não muda: `normalize` deixa `moves` passar pelo `...rest` e os dois caminhos de boot sobrescrevem antes de qualquer evento.

## UI

- `index.html`, painel `board`, depois de `#markdown-fields`: `<fieldset id="moves-fields">` com legenda `quem move o card` e três `<label>`: `pra "em andamento", ao abrir o worker` (`#move-working`), `pra "em review", quando o PR abre` (`#move-review`), `de volta pra fila, se o worker sai sem PR` (`#move-queue`). Cada `<select>` com `hive` → `Hive`, `agent` → `o agente (recebe a instrução no prompt)`, `human` → `à mão (ninguém automatiza)`. Hint: `com "o agente", o prompt do worker ganha um parágrafo dizendo quais movimentos são dele; com "à mão", o Hive só observa o board pelo poll.`
- `app.ts`: `openSetup` preenche os três selects com `config?.moves[key] ?? 'hive'`; `saveSetup` manda `moves` sempre (os três valores do form).

## Testes

- `test/config.test.ts`: `moves` ausente → tudo `hive`; parcial (`{ review: 'agent' }`) → só `review` muda; valor inválido e `moves` não-objeto rejeitados nomeando o campo.
- `test/orchestrator.test.ts`: `fill` com `moves.working = 'agent'` emite só `spawn` (sem `setStatus`); `PostToolUse` com `gh pr create` e `moves.review = 'human'` deixa o slot `aguardando_review` com `prUrl` e sem efeito; `exit` sem PR com `moves.queue = 'agent'` libera o slot, não reenfileira e não emite efeito; estado sem `moves` (legado) se comporta como hoje.
- `test/spawn.test.ts`: `movesNote` vazio sem `agent`; com `review` e `queue` em `agent` lista as duas partes na ordem com os nomes das colunas; só `working` → uma parte.
- `test/setup.test.ts`: `POST /setup` com `moves` grava no `hive.config.json` e o `GET /setup` devolve; corpo sem `moves` mantém o atual.
- `test/server.test.ts`: com `moves.review = 'agent'` o arquivo do prompt termina com o parágrafo e o PR não gera `setStatus review`; com tudo `hive` não tem o parágrafo.
- `test/hive.test.ts`: `bootHive` com `moves.queue = 'agent'` e um `state.json` sem `moves` e um slot morto sem PR: o slot é liberado e o board não é escrito; sem `moves` na config a task volta pra coluna da fila como hoje.
- Manual (`pnpm start`): o painel `board` mostra os três selects e salva; com `review = agent`, o worker recebe o parágrafo e o Hive não move o card quando o PR abre.

## Critério de pronto

1. `hive.config.json` sem `moves` → comportamento idêntico ao de hoje (`pnpm test` verde com os testes existentes intactos).
2. Com `{ "moves": { "review": "agent", "queue": "agent" } }` e o `/roadmap-flow` como template, o card vai pra `In review` uma vez só (pelo agente) e não volta pro `Backlog` quando a sessão fecha.
3. `pnpm test` verde com os testes acima.

## Fora

Transições novas (`Done` no merge, `Blocked`); vigiar o board pra detectar PR; mover card pelo dashboard; épicos; detecção de PR além do `gh pr create`.
