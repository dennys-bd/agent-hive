# Handoff: monitor e saúde

Os `.dc.html` são referências de design em HTML, não código de produção. Recrie a feature no `agent-hive` usando os componentes de `src/ui/components/ui` e os tokens de `src/ui/theme.css`, sempre tokens e nunca hex. As regras gerais continuam as de `00-LEIA-ANTES.md`. Header e footer não mudam, exceto o switch ganhar **monitor ⌘3** e o pill do console mostrar loading (atividade 6).

**Onde ver:** abra `Monitor Redesign.dc.html` no navegador. Cada tela é `Monitor.dc.html` com a prop `variant`; os ids (4a…4k) estão abaixo em cada atividade.

O trabalho está cortado em **8 atividades**, cada uma um PR que funciona sozinho.

```
1 → 2 → 3 → 4
1 → 5, 6, 7
8 (independente, pode começar junto com 1)
```

## Medidas comuns
- Barra do monitor: 44px, padding `0 16px`, 12px `muted-foreground`. "monitor" 13/600 `foreground`, seguido do resumo (ex. "6 atividades · 1 aguardando você · 1 aguardando aprovação").
- Grid: padding `0 16px 14px`, gap 10px, linhas `minmax(0,1fr)`. Colunas: 3 por padrão, 2 com a lateral direita aberta.
- Painel: fundo `card`, borda `border`, radius-lg (8px).
  - Status diferente de trabalhando/parada: borda na cor do status.
  - Painel em foco: anel `0 0 0 2px` em `foreground` a 35%.
- Cabeçalho do painel, 34px com borda inferior: quadrado do workspace, título 13/500 com ellipsis, etapa, status (ponto 6px + palavra), alfinete (lucide `pin`, 13px) e `⋯`.
- Linha de sessões, 26px: chip por sessão (ícone do agente 12px, nome, id em mono `muted-foreground`). A sessão exibida tem fundo `muted`. À direita, meta (tempo · tokens ou ±N · ↑N).
- Corpo: mono 12/18, alinhado embaixo, só as últimas linhas da sessão exibida.
- Ícone do agente: `ClaudeIcon` para claude. Codex e outros aparecem só como texto até a marca existir.

---

## 1 · Seção monitor e grid padrão (4a, 4k)
**Escopo**
- Entrada **monitor ⌘3** no switch do header.
- Grid 3×2 só de leitura, com os painéis descritos em "Medidas comuns".
- Clique no título foca o painel; ⌘1–9 foca o painel N; ↵ abre o painel em foco em atividades.
- Como fixar ainda não existe, mostra as atividades ativas.
- Estado vazio (4k): borda tracejada `empty`, título "Nenhuma atividade fixada" (14/500), texto 12px `muted-foreground` e os botões "+ fixar atividade" (primário) e "ver todas ativas" (outline).
- Dica no footer: "clique para focar · ↵ abre em atividades · ⌘1–9 foca o painel".

**Aceite**
- O painel atualiza ao vivo com a sessão.
- A ordem e as cores de status seguem o StatusWord (mais urgente: waiting › approval › review › working).

## 2 · Fixar e filtros (4j)
**Escopo**
- Alfinete no painel e na lateral de atividades.
  - Fixada: preenchido, `muted-foreground`.
  - Não fixada: contorno, `empty`.
  - Tooltip "fixar" / "desafixar".
- A lista de fixadas é persistida no view-state.
- ToggleGroup na barra: **fixadas ⌥1 · todas ativas ⌥2 · precisam de você ⌥3**, atalho 11px `muted-foreground` tracking .1em.
- **Mais fixadas do que cabem (4j):** a linha tem altura fixa e o grid rola na vertical (scrollbar fina, polegar `empty`). A terceira linha aparece cortada para indicar que há mais. O resumo diz "8 fixadas · 2 abaixo · …" e a dica no footer, "role para ver as outras 2".

**Aceite**
- Fixar e desafixar sobrevivem a reiniciar o app.
- "precisam de você" mostra aguardando você e aguardando aprovação.

## 3 · Ações no painel (4a, 4b, 4j)
Barras no rodapé do painel: fundo `background`, borda superior `border`, padding `8px 10px`.
- **Aguardando você:** campo "responder ao agente…" com ↵ (envia para a sessão exibida).
- **Aguardando aprovação:** "aprovar" (primário), "enviar feedback…" (outline) e "ver diff" (12px `review`).
- **Parada (4j):** "parada por você · a sessão continua no histórico" (12px `muted-foreground`) e "retomar" (outline).
  - O status é "parada": ponto `empty`, palavra `muted-foreground`, borda `border`. As linhas do corpo ficam em `muted-foreground`. A meta mostra "parada há 2h".
- **Menu ⋯** (240px):
  - abrir em atividades ↵
  - expandir ⌘⇧↵
  - separador
  - sessão exibida ›
  - executar › (atividade 6)
  - tamanho › (atividade 4)
  - separador
  - desafixar
  - parar ⌘. (`destructive`)

**Aceite**
- Responder, aprovar, feedback e retomar agem na mesma sessão que atividades usaria.
- Não há comandos `/` do agente no monitor.

## 4 · Organizar (4d)
**Escopo**
- Botão **organizar ⌘⇧O** na barra. No modo organizar, a barra mostra:
  - "arraste para mover · escolha o tamanho em cada painel"
  - colunas 2 · 3 · 4
  - restaurar (outline) e concluir (primário)
- Os painéis ficam com borda tracejada `empty` e o corpo a 45%. O cabeçalho troca para alça ⋮⋮, seletor de tamanho 1×1 · 2×1 · 1×2 · 2×2 (11px/500) e ×, que desafixa.
- Uma célula vazia mostra "+ fixar atividade" e abre a busca (300px):
  - campo "buscar atividade"
  - linhas com quadrado do workspace, título e status
  - switch "fixar sozinho o que precisa de você"
- Dica no footer: "esc sai sem salvar".

**Aceite**
- Tamanho, posição e colunas persistem.
- esc descarta as mudanças; concluir salva.

## 5 · Laterais e aba detalhes (4e)
**Escopo**
- ⌘B abre a lateral esquerda (248px): a lista de atividades por workspace, com o alfinete e a nota "o alfinete fixa no monitor. clique no título para focar o painel."
- ⌘⇧B abre a lateral direita (340px) com as abas **arquivos · detalhes · saúde**.
- As duas começam fechadas. Com a direita aberta, o grid passa para 2 colunas.
- Aba detalhes: "do painel em foco", seguida dos detalhes da atividade como em atividades (título, caixa de status, início, PR, branch, worktree, sessões com exibida/exibir) e do rodapé "abrir em atividades" e `⋯`.

**Aceite**
- Trocar o foco do painel atualiza detalhes.
- "exibir" troca a sessão mostrada no painel.

## 6 · Comandos do hive (4b, 4c, 4c2)
**Entrada.** Só por **⋯ › executar** e **⌘R** no painel em foco. Os comandos sempre executam **na worktree do painel**.
- **Submenu executar** (210px): "na worktree de {atividade}", os comandos nomeados do workspace (`run-commands.ts`), separador e "outro comando… ⌘R".
- **⌘R (4c2):** popover de 400px ancorado no painel.
  - topo: "executar na worktree de {atividade}"
  - campo mono com foco (anel `ring`)
  - primeira linha: "executar {texto digitado}" com ↵
  - grupos "comandos do workspace" e "recentes" (com "há 20 min")
  - rodapé: "a saída vai para o console" e "esc fecha"

**Estados no cabeçalho do painel (4c).** Chip ao lado do status, 12px, radius-sm, padding `1px 6px`:
- **executando:** spinner (lucide `loader-circle`, 12px, girando), nome em mono, tempo `muted-foreground` (`0:12`) e × para cancelar.
- **vários ao mesmo tempo:** "2 comandos · 1:05" (o maior tempo). O clique abre um popover (280px):
  - "executando na worktree de {atividade}"
  - uma linha por comando, com spinner, nome, tempo e "cancelar"
  - separador, "ver no console" e "executar outro… ⌘R"
- **concluído:** ✓ em `working`, nome e tempo (`build 0:41`). Some depois de alguns segundos.
- **falhou:** borda `destructive` com tint de 12%, nome e "falhou · exit 1" em `destructive`. Fica até o próximo comando ou até abrir o console.

**Console.** Toda saída vai para o console da atividade. O pill do footer mostra spinner e "console · {comando} · 0:12", ou "console · 3 executando" com vários; sem comando, volta ao ponto verde.

**Aceite**
- Cancelar mata o processo e os filhos.
- Dois comandos na mesma worktree executam juntos e cada um tem o próprio log.
- Sem worktree (atividade no local), executa no checkout do workspace e o texto diz "no checkout de {workspace}".

## 7 · Aba arquivos (4i)
**Escopo**
- A árvore de `07-sidebar-arquivos.md`, com raiz na worktree do painel em foco.
- Topo: "do painel em foco · {atividade}" (12px `muted-foreground`), depois a branch em mono.
- Mesmas linhas de 24px, indent de 12px, marcas `M` (`waiting`) e `A` (`working`).
- Como o monitor não abre arquivos no grid, o clique abre no editor externo.

**Aceite**
- Trocar o foco troca a raiz.
- O status git atualiza por watch.

## 8 · Aba saúde (4f, 4g, 4h)
**Entrada.** Botão **saúde ⌘⇧M** na barra; ⌘⇧M abre a lateral direita direto nesta aba. Com a aba aberta, o botão fica com borda `foreground` e fundo `muted`.

Três seções separadas por linha `border`, gap 18px. Linhas de 12px, rótulo de 64px em `muted-foreground`, valor em `foreground` e nota à direita em `muted-foreground`.

- **máquina** · "macOS · 10 núcleos · 32 GB"
  - cpu: valor, barra de 4px e "média 5 min"
  - memória: palavra (normal / pressão alta), barra de 4px e "usado / total"
  - swap: valor e estável / subindo
  - disco: livre e "worktrees {N} GB"
- **daemon** · "pid {N}"
  - event loop (e p99), rss, uptime
  - sync: uma linha por source, com nome, tipo e "há {tempo}"
- **atividades · 7** · "23 processos vivos"
  - cabeçalho 11px: "ordenado por ram ⌄", cpu, ram, proc
  - uma linha por atividade: quadrado do workspace, título, cpu, ram e número de processos
  - **a cpu de uma atividade que não está executando aparece como —** (cor `empty`), incluindo aguardando você, aguardando aprovação e parada
  - nota: "proc inclui agente, terminais e comandos executando na worktree. clique para ver os processos."

**Processos (4g).** O clique numa atividade expande a lista abaixo dela, com a linha em fundo `muted`. Cada processo mostra nome, papel ("agente · {sessão}", "{comando} · 0:12", "vitest · de hive test", "terminal"), pid em mono 11px, cpu e ram. As somas batem com a linha da atividade.

**Alerta (4h).**
- Caixa no topo com borda `waiting` e tint de 12%: "memória em pressão alta" (500, `waiting`), "swap subindo" à direita e, embaixo, quais atividades não estão executando e quanto seguram ("#542, #543 e SITE-4 não estão executando e seguram 4.6 GB").
- Memória, swap e sync atrasado ("há 6 min · atrasado") ficam em `waiting`.
- O botão saúde ganha um ponto `waiting` de 6px.

**Aceite**
- A coleta não pesa no event loop (amostragem espaçada, fora do loop principal).
- A pressão de memória vem do sistema, não de um limite fixo.
- Os processos são agrupados pela worktree da atividade.

---

## Files
- `Monitor.dc.html`: todas as telas, com a prop `variant` (padrao, menu, comandos, executar, layout, laterais, arquivos, maquina, processos, alerta, muitas, vazio)
- `Monitor Redesign.dc.html`: o canvas com as 12 telas (4a–4k)
- `support.js`: dependência dos `.dc.html`
- `png/`: cada tela em 2x (2880×1800), com o mesmo id e nome da variant (ex. `4c-comandos.png`)
