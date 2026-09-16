# Agent Hive

Dashboard desktop (Electron) que mantém até N sessões interativas do Claude Code rodando em paralelo, cada uma em sua própria git worktree numa aba do iTerm2, puxando tasks de um board: GitHub Projects v2 ou uma tabela num arquivo markdown.

## Uso

```sh
pnpm install && pnpm build && pnpm link --global   # uma vez
cd /seu/repo && hive                                # abre o dashboard pra esse repo
```

Sem `hive.config.json` no repo, a janela abre num formulário: escolha o tipo de board (GitHub project ou arquivo markdown), as colunas (fila / em andamento / em review), o máximo de workers e o prompt do worker. O arquivo é gravado e o dashboard aparece. "configurar" reabre o mesmo formulário.

## Prompt do worker

Cada worker recebe `promptTemplate` como prompt inicial da sessão `claude`. Placeholders: `{id}`, `{title}`, `{body}`, `{url}` (`{number}` é sinônimo de `{id}`). Um slash command funciona como entrypoint:

```json
"promptTemplate": "/ship #{id}"
```

Default: `Task #{number}: {title}` seguido do body e da instrução de abrir PR com `gh pr create`.

## Config (`hive.config.json`)

| campo | default | onde editar |
|---|---|---|
| `board` | — | formulário: `{ "type": "github", "owner", "number" }` ou `{ "type": "markdown", "path" }` |
| `status.queue` / `working` / `review` | `Ready` / `In progress` / `In review` | formulário |
| `maxConcurrent` | `2` | formulário / dashboard |
| `promptTemplate` | ver acima | formulário |
| `port` | `47821` | arquivo (exige restart) |
| `claudeArgs` | `[]` | arquivo (ex.: `["--model", "sonnet"]`) |

Arquivos antigos com `project: { owner, number }` em vez de `board` continuam aceitos (viram um board `github`).

### Board markdown

`board.path` é relativo ao repo ou absoluto. O arquivo precisa ter uma tabela com o cabeçalho `| id | título | status |` (colunas em qualquer ordem, outras colunas extras permitidas); o resto do arquivo é livre e nunca é tocado. Cada linha é uma task: `id`, `título` e `status`, e `status.queue` / `working` / `review` são os valores escritos nessa coluna (não podem conter `|` nem quebra de linha). Se o arquivo não existe, o setup cria ele com o cabeçalho e uma linha de exemplo `| T-1 | Exemplo | Done |` — fora da fila, então nenhum worker abre sobre ela. No prompt, `{body}` fica vazio e `{url}` é o caminho do arquivo.

Estado de runtime fica em `<repo>/.hive/` (ignorado pelo git via `.git/info/exclude`).

## Desenvolvimento

`pnpm test` (tsc + `node --test`), `pnpm start -- <repo>` (Electron), `node dist/src/run.js <repo>` (servidor sem janela, em `http://127.0.0.1:47821`).

Specs e planos em `docs/superpowers/`; próximos passos em `docs/roadmap.md`.
