# Agent Hive — colunas do Hive: o pipeline configurável do card

Extensão dos boards plugáveis (`docs/superpowers/specs/2026-09-16-pluggable-boards-design.md`), do sinal (`2026-09-16-signal-design.md`) e dos workers interativos (`2026-09-17-interactive-workers-design.md`) sobre a v1 (`2026-09-15-agent-hive-design.md`), que é autoritativa pra tudo que não está aqui. **Substitui** `2026-09-17-board-moves-design.md` (o `moves: hive | agent | human` da PR #74): o problema era o mesmo e a resposta muda de forma. Issue: <https://github.com/dennys-bd/agent-hive/issues/42>.

Hoje o ciclo do card é fixo e escondido no slot: item em `status.queue` → spawn (`status.working`) → `gh pr create` visto num `PostToolUse` (`status.review`) → saída sem PR volta pra `status.queue`. O GitHub é a verdade, o Hive só reflete três transições, e um command que já move o card (o `/hive-flow` deste repo) disputa o board com ele. Passa a existir um board do Hive: colunas nomeadas pelo usuário, cada uma com o comando que roda, se reusa a sessão da coluna anterior ou abre uma nova, o modelo, um peso pra disputa de slot e o mapeamento nos dois sentidos com as colunas do board externo. O Hive é como o desenvolvedor trabalha, então parte do fluxo que hoje vive no `/hive-flow` passa a viver nessa config: `/hive-spec`, `/hive-plan` e `/hive-build` são comandos naturais de coluna. Seis colunas no Hive sobre três no GitHub, ou uma sobre três, são configs válidas. Só o delta está descrito aqui.

## Decisões fechadas

| Decisão | Escolha | Motivo |
|---|---|---|
| Modelo | O card vira entidade (`State.cards[]`) com coluna, worktree, branch, id de sessão e PR; o slot continua sendo o grid de `maxConcurrent` posições, e um card rodando ocupa um slot (`Card.slotId` ↔ `Slot.cardId`) | Card parado precisa existir e ser visível; o grid de slots já é o que o dashboard mostra e o que `draining` e o teto governam. A abordagem "card é a entidade, slot some" foi rejeitada pra manter o grid |
| Config | `columns[]` substitui `status` e `promptTemplate` (e o `moves` proposto na PR #74); ordem do array = ordem do pipeline | Uma coluna carrega tudo que hoje está espalhado em três campos; o `moves` da PR #74 vira caso particular de `onStart`/`onFinish` |
| Coluna | `name`, `prompt?`, `session?: 'new' \| 'continue'`, `model?`, `weight`, `from: string[]`, `onStart?`, `onFinish?` | `prompt` ausente = coluna sem ação (o card só fica, um "done"); `from` é a entrada (card novo ou movido à mão no GitHub); `onStart`/`onFinish` são as escritas no GitHub, cada uma opcional, porque "ao começar" reproduz o `In progress` de hoje e "ao finalizar" é o pedido da issue |
| Peso | Maior peso ganha o slot livre; desempate pela ordem do board dentro da coluna | `backlog 5, ready 1, doing 2, review 3` diz "tirar coisa do backlog vem antes de tudo; começar card novo é a última prioridade; card em andamento vai até o fim". O sinal (green/yellow/red), o budget e as usage rules continuam globais e por cima |
| Gatilho de avanço | O `Stop` de um card rodando: o Hive mata a sessão, libera o slot, escreve `onFinish` e avança o card pra coluna seguinte do array. Sem gatilho manual | O fim do turno é o fim do comando. A sessão nunca fica viva entre colunas: `continue` é continuidade de contexto (`--resume`), não de processo. Consequência: `paused`/`releasePaused` (e o `SlotEventKind` `paused`) somem, porque não existe mais "turno acabou, sessão espera". O filtro do #24 (`isChildSession`: Stop de subagente ou teammate ignorado) continua valendo e é o que torna o gatilho confiável |
| Fim do pipeline | Sem coluna seguinte, o card sai do Hive; a sessão já morreu no `Stop`; a worktree fica (#58 cuida) | Quem quer o card visível depois configura uma última coluna sem `prompt` |
| Saída sem `Stop` | Kill pelo card, tab fechado, crash ou boot dando o worker como morto: slot libera, nada é escrito no GitHub, o card fica na mesma coluna esperando slot; quando rodar de novo segue a política de sessão da coluna contra o `sessionId` que já tem | O comando não terminou; repetir a coluna é o comportamento seguro, e "volta pra fila" deixa de existir como regra |
| Sessão e worktree | Toda rodada é `cd <repo> && claude --worktree=<slug>`; `new` acrescenta `--session-id <uuid novo>` (gerado pelo Hive e gravado em `Card.sessionId` no spawn), `continue` acrescenta `--resume <card.sessionId>` (id não muda); `continue` sem `sessionId` cai em `new` | A worktree é do card e o `--worktree` reabre a existente; o kill e o `killStray` continuam casando `--worktree=<slug>`. Gerar o id no Hive dispensa esperar o hook. `Slot.sessionId` (#29) continua vindo do `SessionStart` e servindo ao `isChildSession` (#24); os dois devem coincidir |
| Modelo | `model` da coluna vira `--model <model>` depois do `claudeArgs` global | É o único ajuste por coluna que a issue pede; `claudeArgs` continua global |
| PR | `gh pr create` no `PostToolUse` só grava `Card.prUrl` (cor azul, link) | Deixa de ser transição; a coluna decide o que acontece |
| Verdade sobre a coluna | O Hive. `Card.boardColumn` guarda a coluna do GitHub onde o Hive viu ou deixou o card por último; o poll só reage quando a coluna atual difere dela | Sem isso a escrita do próprio Hive (`onStart` → `In progress`) voltaria no poll seguinte parecendo novidade |
| Movimento humano no GitHub | Card parado e a coluna nova está em algum `from`: vai pra primeira coluna do Hive cujo `from` a contém, `boardColumn` atualiza. Card rodando: nada muda até terminar (o `onFinish` sobrescreve, o movimento se perde). Coluna nova fora de qualquer `from`: só `boardColumn` atualiza | O usuário pode reposicionar um card parado pelo GitHub; um card rodando não é interrompido por isso |
| Card some do GitHub | `missing: true`: sai da disputa por slot, termina o comando se estiver rodando, e o dashboard oferece **fechar** (remove o card, mata a sessão se viva; worktree fica) ou **manter** (`orphan: true`: segue o pipeline sem escrever no GitHub, o poll o ignora) | Fechado, tirado do projeto ou movido pra coluna que a config não cita (`Done`) são o mesmo caso; a decisão é do usuário, não do Hive |
| Entrada | Card desconhecido só entra por uma coluna citada em algum `from`; em coluna que aparece só em `onStart`/`onFinish` é ignorado | `from` é a única porta; o resto é destino de escrita |
| Config antiga | Sem `columns`, o boot cai em modo setup com o editor pré-preenchido com o equivalente de hoje (`fila`: `from` = `status.queue`, `onStart` = `status.working`, `onFinish` = `status.review`, prompt = `promptTemplate`, sessão nova, peso 1) e a mensagem de que a config precisa de colunas | Nada migra em silêncio: "saída sem PR volta pra fila" deixa de existir e o usuário deve ver isso |
| `state.json` antigo | `normalize` descarta `queue` e os campos de task dos slots; `cards` começa vazio e o primeiro poll reingere | Ainda não existe card só do Hive; nada se perde |
| Interface `Board` | `listQueue` → `listCards()` (itens em qualquer coluna citada na config, com nome da coluna e ordem); `setStatus(itemId, key)` → `setColumn(itemId, name)`; `resolveFields` valida os nomes citados | O adapter deixa de conhecer `StatusKey`; o Hive fala em nomes de coluna |
| UI | Board do Hive em cima (uma coluna por `columns[]`), grid de slots embaixo como hoje; o painel de fila some e o `iniciar` à mão (#47) passa pro card parado; setup ganha o editor de colunas no lugar de `status` e `promptTemplate`; textos em `i18n.ts` (pt e en, #70) | A fila é o board |
| Épicos | Intocados (#31) | Fora do contrato, como já estava |

## Config

```json
"columns": [
  { "name": "spec", "weight": 5, "from": ["Backlog"], "onFinish": "Ready",
    "prompt": "/hive-spec {url}", "session": "new", "model": "opus" },
  { "name": "dev", "weight": 1, "from": ["Ready"], "onStart": "In progress", "onFinish": "In review",
    "prompt": "/hive-build {url}", "session": "continue" },
  { "name": "review", "weight": 0, "from": ["In review"] }
]
```

`parseConfig`: `columns` obrigatório, array não vazio, senão `hive.config.json: "columns" must be a non-empty array`. Por coluna: `name` string não vazia e única (`"columns[1].name" must be unique`); `weight` inteiro ≥ 0; `from` array de strings (pode ser vazio); `prompt`, `onStart`, `onFinish`, `model` strings opcionais; `session` ∈ `['new', 'continue']`, default `'new'`. Pelo menos uma coluna com `from` não vazio (`"columns" must have at least one column with "from"`). `status` e `promptTemplate` deixam de existir; uma config sem `columns` faz `loadConfig` falhar com `hive.config.json: "columns" is required` e o boot cai em setup (`SetupInfo.error`) com a proposta derivada (`legacyColumns(raw)`). `hive.config.json` continua sem tokens.

## Tipos (`src/types.ts`)

```ts
export type SessionPolicy = 'new' | 'continue';

/** One stage of the Hive's own board; the array order is the pipeline order. */
export interface Column {
  name: string;
  prompt?: string;         // template ({id} {number} {title} {body} {url}); absent = no action, the card just sits here
  session?: SessionPolicy; // continue = --resume the card's session; default new
  model?: string;          // --model
  weight: number;          // higher wins a free slot; ties by board order
  from: string[];          // board columns whose cards enter here (new cards, or a human move)
  onStart?: string;        // board column the card is moved to when the command starts
  onFinish?: string;       // idem when the command ends
}

/** A board task inside the Hive: it exists while it sits in a column, running or not. */
export interface Card {
  task: Task;
  column: string;
  boardColumn: string;     // where the Hive last saw or left it on the board; the poll compares against it
  slug: string;
  worktree?: string; branch?: string; sessionId?: string; prUrl?: string;
  slotId?: string;         // present while the command runs
  missing?: true;          // gone from the board; waits for close or keep
  orphan?: true;           // kept after going missing: runs to the end, no board writes, ignored by the poll
}

/** A task as the adapter lists it: which board column it is in, in board order. */
export interface BoardCard { task: Task; column: string; }

interface Slot {
  id: string; workerId?: string; cardId?: string; status: Status; draining?: boolean;
  tokens?: number; startedAt?: string; lastEvent?: SlotEvent; question?: string; transcriptPath?: string; sessionId?: string;
} // task, slug, worktree, branch, prUrl, paused: removed (the card carries them; paused no longer exists)

interface State { /* como hoje, menos queue */ columns: Column[]; cards: Card[]; }
interface Config { /* como hoje, menos status e promptTemplate */ columns: Column[]; }

type HiveEvent =
  | /* como hoje */
  | { type: 'poll'; cards: BoardCard[] }          // replaces tasks: Task[]
  | { type: 'start'; itemId: string; raiseMax?: boolean } // as today (#47): the card's own column, past the signal, the cap and the budget
  | { type: 'closeCard'; cardId: string }         // fechar on a missing card
  | { type: 'keepCard'; cardId: string };         // manter on a missing card

type Effect =
  | { type: 'spawn'; slot: Slot; card: Card; column: Column }
  | { type: 'setColumn'; itemId: string; column: string }   // replaces setStatus
  | { type: 'kill'; slug: string; workerId: string };

interface Board {
  resolveFields(): Promise<void>;          // every column name cited in the config exists on the board
  listCards(): Promise<BoardCard[]>;       // tasks in any cited column, in board order
  setColumn(itemId: string, column: string): Promise<void>;
  setupOptions(): Promise<string[]>;
  quota?(): Promise<BoardQuota | undefined>;
}

interface SetupBody { board; columns?: Column[]; maxConcurrent?; budget?; usageRules?; workers?; epics?; }
```

`cardId` é o `task.itemId`. `StatusKey` só sobrevive em `legacyColumns`; `Status` `review` continua como cor do slot quando o card tem `prUrl`; `SlotEventKind` perde `paused`.

## `src/orchestrator.ts`

- `columnOf(state, name)`, `nextColumn(state, name)`: lookup em `state.columns` (copiado da config em `bootHive`, `configure` e `reconfigure`, como `budget`); o reducer não importa a config.
- `poll(state, cards)`: pra cada `BoardCard`: card conhecido → regras da tabela (`boardColumn` igual: nada; diferente e em algum `from`: move se parado, `boardColumn` atualiza; diferente e fora de `from`: só `boardColumn`); desconhecido → `Card` novo na primeira coluna cujo `from` contém `column`, se houver. Card conhecido que não veio e não é `orphan` → `missing: true`; card `missing` que volta a aparecer perde a marca. Atualiza `task` (título, corpo, url, `blockedBy`) e reordena `cards` pela ordem da listagem dentro de cada coluna (ausentes mantêm a posição). Depois `fill`.
- `fill`: candidatos = cards sem `slotId`, sem `missing`, não bloqueados (`isBlocked`), cuja coluna tem `prompt`; ordenados por `weight` desc e posição no array. Pra cada slot `vazio` não `draining` enquanto `canStart`: ocupa (`workerId` novo, `cardId`, `working`, `lastEvent: { kind: 'starting' }`), `card.slotId`; `session` `new` (ou `continue` sem id) → `card.sessionId = randomUUID()`; `onStart` presente, ≠ `boardColumn` e card não `orphan` → efeito `setColumn` e `boardColumn` atualiza; efeito `spawn`. `occupy` continua compartilhado com `start` (#47), que agora recebe o `itemId` de um card parado com `prompt` e o roda na coluna em que está, `lastEvent: { kind: 'manualStart' }`.
- `applyHook`: `SessionStart` grava `worktree`/`branch` no card e `transcriptPath` no slot; `PostToolUse` com PR grava `card.prUrl` e `lastEvent: { kind: 'pr' }`, sem efeito; `Stop` → `finish(state, workerId)`: efeito `kill`; `onFinish` presente, ≠ `boardColumn` e não `orphan` → `setColumn` e `boardColumn` atualiza; card vai pra `nextColumn` (sem `slotId`) ou sai de `cards` se não há próxima; slot volta a `empty` (ou é removido se `draining`). O caso "Stop sob red" e a marca `paused` somem: o `Stop` sempre encerra a rodada. `SessionEnd` continua sendo `exit`; o filtro `isChildSession` vem antes dos dois, como hoje.
- `exit`: slot libera como hoje, `card.slotId` some, card fica na coluna; sem efeito de board. `boot` passa por `exit`.
- `closeCard`: remove o card; se tem `slotId`, efeito `kill` e o slot libera. `keepCard`: `missing` → `orphan: true`. Ambos passam por `fill`.
- `kill` (evento), `setMax`, `setSignal`, `setBudget`, `setUsageRules`: como hoje, sem `releasePaused`.

## `src/spawn.ts`

- `workerArgs(card, column, claudeArgs): string[]` = `['--worktree=<slug>', ...claudeArgs, ...(column.model ? ['--model', column.model] : []), ...(column.session === 'continue' && card.sessionId ? ['--resume', card.sessionId] : ['--session-id', card.sessionId])]`. `spawn-iterm.ts`/`spawn-tmux.ts` recebem a lista pronta em `WorkerLaunch.args` em vez de montar `--worktree` e `claudeArgs` separados; a shell string continua uma só.
- `renderPrompt(column.prompt, task)` como hoje. Prompt gravado em `prompts/<slug>.md`, sobrescrito a cada rodada.
- `killStray` inalterado.

## `src/boards/github.ts` e `src/boards/markdown.ts`

- `resolveFields`: valida cada nome citado (`from`, `onStart`, `onFinish` de todas as colunas) contra as opções do campo Status (GitHub) ou os valores da coluna de status (markdown); o erro nomeia o valor e a coluna do Hive.
- `listCards`: itens cujo status está entre os nomes citados, na ordem do board, com `column` = o nome. Filtro de épicos (#31) e `blockedBy` como hoje.
- `setColumn(itemId, name)`: o `setStatus` de hoje com o nome direto.

## `src/server.ts`

- `poll()` chama `listCards` e despacha `{ type: 'poll', cards }`.
- Efeito `setColumn` → `board.setColumn`; `spawn` monta `WorkerLaunch` com `workerArgs` e o prompt da coluna.
- `configure`/`reconfigure`: `columns: config.columns` no estado antes do `boot`; `queue` some.
- `POST /cards/:id/close` → `closeCard`; `POST /cards/:id/keep` → `keepCard`; `:id` é o `itemId`; 404 quando desconhecido.
- `POST /setup`: `columns: body.columns ?? current?.columns`; `parseConfig` e `resolveFields` antes de gravar.
- `GET /setup`: quando a config salva não tem `columns`, `SetupInfo.config.columns = legacyColumns(saved)` e `error` explica.
- Log de config: `columns=spec(5)>dev(1)>review(0)`.
- O `Stop` deixa de ter o caso "`review` → `pool.kill`" no server: o `kill` vem como efeito do reducer.

## `src/hive.ts`

- `bootHive`: `columns: config.columns` no estado montado, na linha que copia `budget` e `usageRules`. `normalize` (`state-store.ts`) descarta `queue` e os campos de task dos slots; `cards` default `[]`.

## UI

- `index.html`: acima do grid, `<section id="board">` com uma `<div class="column">` por coluna: cabeçalho `nome · peso`, lista de cards. Card: `#id título`, branch, link do PR, badge `bloqueada`, botão `iniciar` (#47, com a confirmação de subir o teto) quando parado numa coluna com `prompt`, faixa `sumiu do GitHub` com botões `fechar` / `manter` quando `missing`, marcador `sem board` quando `orphan`; card rodando com a cor do slot e o botão `terminal`. Grid de slots como hoje, mostrando `#id título`, a coluna, `lastEvent`, tempo, `kill`, `terminal`. `#queue` e as chaves `queue.*` do `i18n.ts` somem; as chaves novas (`board.*`, `card.*`, `setup.columns.*`) entram em pt e en.
- Setup, painel `board`: `#status-fields` e `#prompt-template` saem; entra `<fieldset id="columns-fields">` (`colunas do Hive`) com uma linha por coluna: nome, peso, `from` (multi-select das opções de `GET /setup/columns`), `onStart` e `onFinish` (select com `nenhum`), sessão (`nova` / `continua a anterior`), modelo (texto, vazio = default), prompt (textarea, vazio = sem ação); botões `+ coluna`, `remover`, `↑`, `↓`. Hint: `o card avança quando o comando termina; peso maior pega o slot primeiro; coluna sem prompt só mostra o card.`
- `app.ts`: `openSetup` preenche pelas `config.columns` (ou `legacyColumns`); `saveSetup` manda `columns` sempre. Render do board a partir de `state.cards` e `state.columns`.

## Testes

- `test/config.test.ts`: parse das colunas (defaults, `session` inválido, nome duplicado, peso negativo, sem `from` em nenhuma, `columns` ausente → erro nomeado); `legacyColumns` de uma config antiga.
- `test/orchestrator.test.ts`: entrada pelo `from` (primeira coluna que o contém; coluna só em `onFinish` ignora); `fill` por peso e desempate por ordem, respeitando `canStart`, bloqueio e coluna sem prompt; `onStart` só quando difere de `boardColumn`; `sessionId` gerado em `new`, mantido em `continue`; `Stop` → `kill` + `onFinish` + avanço; última coluna → card sai; coluna sem prompt estaciona; `exit` sem `Stop` mantém o card e não escreve; poll: as quatro regras, reordenação, `blockedBy`, `missing` que reaparece; `closeCard` (com e sem slot) / `keepCard` → `orphan` sem efeitos; `boot` dá rodadas como mortas; `start` num card parado; Stop de subagente ignorado; sem `paused`.
- `test/spawn.test.ts`: `workerArgs` com `--worktree` sempre, `--session-id` / `--resume` / `--model`; `continue` sem id cai em `--session-id`.
- `test/boards/github.test.ts`, `test/boards/markdown.test.ts`: `listCards` filtra pelas colunas citadas e traz o nome; `setColumn`; `resolveFields` rejeita nome inexistente citando a coluna do Hive.
- `test/server.test.ts`: `POST /setup` com colunas grava e `GET /setup` devolve; config antiga → `GET /setup` com `legacyColumns` e `error`; `POST /cards/:id/close|keep`; efeito `spawn` monta o argv certo; `Stop` mata via efeito.
- `test/hive.test.ts`: `bootHive` copia `columns`; `state.json` antigo normaliza sem `queue`.
- `test/i18n.test.ts`: as chaves novas existem em pt e en.
- Manual (`pnpm start`): board com cards parados e rodando, grid embaixo, editor de colunas salvando e o boot em setup com uma config antiga.

## Critério de pronto

1. Com a config de exemplo acima e três cards em `Backlog`: os três nascem em `spec`; com `maxConcurrent = 2` dois rodam; no `Stop` de cada um o card vai pra `Ready` no GitHub e pra `dev` no Hive; `dev` roda com `--resume` do mesmo id, move pra `In progress` ao começar e pra `In review` ao terminar; o card fica parado em `review` até sumir do GitHub, quando o dashboard pergunta fechar ou manter.
2. Config sem `columns` abre em setup com a coluna `fila` proposta; salvar reproduz o fluxo de hoje menos "volta pra fila".
3. `pnpm test` verde com os testes acima.

## Fora

Gatilho manual de avanço; arrastar card entre colunas do Hive (#48); limite de rodadas por coluna; sessão viva depois do PR (#67); limpeza de worktree (#58); vigiar o board pra detectar PR; épicos.
