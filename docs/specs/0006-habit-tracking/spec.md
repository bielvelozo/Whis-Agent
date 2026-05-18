---
status: draft
feature: habit-tracking
created: 2026-05-17
shipped: null
---
# Skill `habits` — Whis com tracking de hábitos conversacional

**Status:** Draft
**Scope:** Adicionar a terceira skill funcional do Whis: tracking de hábitos por conversa. Cobre (1) **criação conversacional** de hábitos (*"quero meditar 10min todo dia de manhã"*), (2) **log natural por menção** (*"fui pra academia agora"* sem o user dizer "registra"), (3) **três tipos de medição** — binário (fiz/não fiz), quantidade (30 flexões, 2L água), duração (45min academia), (4) **cobrança proativa** via integração com `scheduled-messages` (skill 0004) — Whis cria automaticamente um check-in noturno que detecta hábitos faltando e pergunta, e (5) **dupla visualização** — resumo MarkdownV2 no Telegram on-demand + snapshot em `context/habits/dashboard.md` (vault Obsidian) com heatmap, streaks e estatísticas. Storage SQLite próprio (tabelas `habits` + `habit_logs`, separado de `scheduled_messages`). Tools via in-process MCP server (mesmo padrão da 0004). Writes destrutivos (`habit_create`/`habit_edit`/`habit_archive`) seguem o protocolo absoluto de confirmação humana; logs (`habit_log`) executam direto com summary pós-fato — fricção de confirmação no log mataria o caso de uso de "registro intuitivo".

## Context

A spec 0001 entregou o pipeline base. A 0002 entregou Telegram. A 0003 entregou `google-calendar`. A 0004 entregou `scheduled-messages` — Whis virou capaz de iniciar conversa em horários combinados. Agora o gap é diferente: **memória estruturada de comportamento ao longo do tempo**. Whis sabe da agenda formal (eventos), sabe lembrar de tarefas (scheduled), mas não tem como **acumular evidência de progresso** em rotinas pessoais (meditação, exercício, hidratação, leitura, sono).

A escolha por skill dedicada (em vez de armazenar como notas livres no vault Obsidian) é deliberada: (1) hábitos têm estrutura — nome, tipo, frequência alvo, logs com timestamp e valor — que se beneficia de schema; (2) streaks, taxas de conclusão e heatmaps precisam de query estruturada, não de grep em markdown; (3) cobrança proativa exige saber "hoje faltou X" sem o Whis ter que parsear vault inteiro toda noite.

A escolha por **três tipos de hábito** (binário, quantidade, duração) cobre o espaço prático sem inflar schema: o mesmo campo `value` no log armazena `1` (binário), `30` (quantidade) ou `45` (minutos), interpretado pelo `unit` do hábito. Stats agregam diferente por tipo (binário = % de dias feitos; quantidade/duração = soma + média).

A escolha por **criação puramente conversacional** (sem YAML em `profile/`) é coerente com o caso de uso: hábitos entram e saem da vida do Gabriel; gerenciar via arquivo de config é pior UX que falar com o Whis. YAML é melhor pra coisas estáticas (skills sempre ativas, credentials); hábitos são dados de produto, vão no DB.

A escolha por **integração com `scheduled-messages` em vez de engine própria de lembrete** elimina duplicação: já temos dispatcher em SQLite com tick de 60s funcionando. Quando user cria hábito com `reminder_at: "21:00"`, Whis oferece criar um scheduled-message `kind: 'agent'` que dispara 21h e chama uma nova tool `habit_today_pending` pra ver o que falta — sem duplicar engine de cron.

A escolha por **dupla visualização (Telegram + Obsidian)** atende dois consumos diferentes: Telegram é para resposta rápida ("como tô na semana?"); Obsidian é o "segundo cérebro" do Gabriel — heatmap visual de 30 dias por hábito + estatísticas + insights é leitura reflexiva, casa com o vault. Ambas são derivadas do mesmo DB, sem duplicação de fonte da verdade.

A escolha por **log sem confirmação** quebra o protocolo absoluto vigente (Calendar/Scheduled exigem "confirma?" em toda write). Justificativa: log é o caminho quente — *"fui pra academia"* → "Anotado, 45min hoje" é o flow inteiro; pedir confirmação aqui mataria a skill. Mitigações: (a) Whis sempre confirma o que registrou ("Anotado: **academia** 45min hoje. Streak: 5 dias."), (b) tool `habit_log_undo` permite reverter o último log dentro de janela curta, (c) qualquer write destrutivo (`habit_archive`, `habit_edit`) volta a exigir 3 passos. A regra absoluta no SOUL.md ganha exceção explícita pra logs.

**Decisões fundantes (a confirmar com Gabriel antes de partir pro plan):**

- **Storage SQLite próprio** em duas tabelas novas: `habits` (definição) e `habit_logs` (eventos). Migration `003_habits`. Sem touch em tabelas existentes.
- **Tipos:** `binary | quantity | duration`. Campo `unit` no hábito (`flexões`, `min`, `páginas`, `ml`...). Logs guardam `value` numérico — `1` pra binário, número pra quantidade/duração.
- **Frequência alvo:** combinação de `cadence` (`daily` | `weekly` | `custom_days`) + `target_per_period` (ex: 3x/semana) + `days_of_week` opcional (ex: seg/qua/sex). Suficiente pra ~90% dos casos pessoais.
- **Criação conversacional only.** Sem YAML em `profile/config.yaml`.
- **Log sem confirmação 3-passos.** Whis confirma pós-fato. Tool `habit_log_undo` cobre erro.
- **Writes destrutivos com confirmação:** `habit_create`, `habit_edit`, `habit_archive`, `habit_unarchive`. Protocolo idêntico ao de `scheduled-messages`.
- **Detecção de log por menção natural.** SKILL.md ensina padrões ("fui na X", "fiz Y", "X feito") + Whis faz match contra hábitos ativos do Gabriel (`habit_list` no contexto da turn) antes de chamar `habit_log`. Match ambíguo → pergunta antes.
- **Cobrança proativa via skill `scheduled-messages`.** Whis oferece ao criar hábito: *"Crio também um check-in pras 21h?"* — se sim, cria scheduled-message agent que chama `habit_today_pending` no horário.
- **Visualização Telegram:** tool `habit_status` retorna MarkdownV2 com agrupamento por estado (feito hoje / pendente hoje / fora do dia hoje) + streak por hábito.
- **Visualização Obsidian:** tool `habit_render_dashboard` escreve `context/habits/dashboard.md` (idempotente, overwrite). Conteúdo: tabela heatmap 30 dias + streaks + estatísticas mensais. Chamada on-demand pelo Whis (*"atualiza o dashboard"*) ou agendada via scheduled-messages.
- **Streak e stats calculados em runtime** via queries no `habit_logs`. Sem cache. Pra <1000 logs/hábito (centenas de dias), perf irrelevante. Cache vira preocupação v2.

## Problem Statement

Hoje, hábitos pessoais do Gabriel ou (a) vivem na cabeça e somem na primeira semana de stress, (b) ficam em apps de tracker (Streaks, Habitify, Notion templates) que exigem abrir o app e tocar um checkbox toda vez, ou (c) viram nota perdida no vault Obsidian sem agregação. Nenhuma das três fricções casa com como o Gabriel já usa o Whis — pelo Telegram, em texto livre, no fluxo da rotina.

A spec resolve isso entregando:

- **Registro intuitivo no canal já usado.** *"fui pra academia"* / *"bebi 1.5L de água hoje"* / *"meditei 10min agora"* — Whis identifica qual hábito é, registra, confirma. Zero cliques, zero "abrir o app".
- **Memória estruturada.** Pergunta *"quantos dias eu meditei em maio?"* responde com número correto, não estimativa.
- **Cobrança gentil quando falta.** Check-in noturno automático (se Gabriel optou): *"Hoje falta meditação e academia. Tem ainda tempo. Bora?"* — não punitivo, conversacional.
- **Visão geral acionável.** Resposta no Telegram pra status rápido ("3 de 5 hábitos hoje, streak da meditação: 12 dias"); dashboard no vault pra reflexão semanal/mensal com heatmap e insights.

A skill **não substitui** decisão humana — Whis não decide hábitos novos, não muda metas, não arquiva por inatividade. Tudo passa pelo Gabriel; o sistema só guarda evidência e mostra padrões.

## Non-Goals

Explicitamente **fora do escopo** desta spec:

1. **Análise preditiva / sugestão de hábitos baseada em dados** (*"você anda mal na meditação, tente reduzir pra 5min"*). v2+ — espaço de produto inteiro próprio.
2. **Hábitos negativos / vícios** ("dias sem fumar", "dias sem rede social"). Storage suportaria, mas SKILL.md v1 instrui só hábitos positivos pra evitar protocolo psicológico delicado.
3. **Integração com wearables / Apple Health / Strava** pra log automático. Tudo é log manual via chat na v1. v2 abre integrações.
4. **Compartilhamento social / accountability** com outras pessoas. Single-user (Gabriel), igual o resto do Whis.
5. **Múltiplos logs por dia agregados como série temporal intra-dia.** Ex: 3 copos de água registrados às 9h, 12h e 15h são 3 logs separados — agregação vira `sum` no dia, mas não há "timeline" intra-dia visual. v2 se virar dor real.
6. **Edição de log retroativo via UI rica.** v1 permite via tool `habit_log` com flag `at: 'YYYY-MM-DD'` ou `at: 'ontem'`; correção exige `habit_log_undo` + novo log. v2: edit direto por id de log.
7. **Backup / export para CSV / sync com outros apps.** Volume Docker `whis_data` já persiste `whis.db`; export é dump manual via tool ad-hoc no SQLite se precisar.
8. **Visualização web (dashboard HTTP).** Decisão fechada: Obsidian + Telegram cobrem. Sem app Next.js/Vite pra isso.
9. **Hábitos com sub-tarefas / checklists.** "Rotina matinal = 1) escovar 2) treinar 3) café" não é 1 hábito — são 3 hábitos separados. SKILL.md instrui a desnormalizar.
10. **Pausas temporárias de hábito** ("pausar a meditação na semana que viajo"). v1: usuário simplesmente não loga; streak quebra. v2: campo `paused_until` + ajuste de cálculo de streak.
11. **Notificação fora do Telegram.** Mesma decisão das outras specs — Whis fala pelos canais ativos.
12. **WhatsApp na v1.** Skill funciona em qualquer canal ativo (igual `scheduled-messages`); validação é via Telegram.
13. **Calendário visual interativo** (clicar num dia pra ver/editar). Heatmap em Obsidian é leitura-only.
14. **Goals com prazo** ("correr 100km em junho"). Hábitos são recorrência sem alvo cumulativo. Metas com prazo são outro domínio (v2+).

## Constraints

**Técnicas:**

- Node ≥18 (já é Node 24).
- TypeScript strict + Vitest. Quality gate (`pnpm run quality-gate`) precisa continuar verde.
- SQLite via `better-sqlite3`. Single-process, single-connection.
- In-process MCP server registrado via `createSdkMcpServer` (mesmo slot `inProcessMcpServers` já usado por `scheduled-messages`). Sem subprocess.
- Migration `003_habits` é **additive only** — duas tabelas novas, zero touch em `messages`/`sessions`/`scheduled_messages`/`schema_version`.
- Renderização do dashboard Obsidian usa **markdown puro** (tabela + emojis ASCII-safe `✅ ⬜ 🟧`). Sem dependência externa (Mermaid, plugins).
- Path do dashboard: `context/habits/dashboard.md`. Tool `habit_render_dashboard` cria diretório `context/habits/` se não existir. `context/` já é volume montado read-write no container.
- Reuso de tabela/engine de `scheduled_messages` pra cobrança proativa — esta spec **não** adiciona novo loop de timer. Apenas instrui Whis no SKILL.md a oferecer criação de scheduled-message no fluxo de `habit_create`.

**Organizacionais:**

- Single user (Gabriel). Sem multi-tenancy.
- Sem SLA — ferramenta pessoal.

**De arquitetura (pra evitar débito imediato):**

- **Duas tabelas próprias:** `habits` (definição) e `habit_logs` (eventos). Storage físico isolado de `scheduled_messages` e `messages`.
- **`HabitRepo` e `HabitLogRepo`** novos em `@whis/storage`, exportados via `index.ts`. Mesmo pattern de `ScheduledMessageRepo`.
- **In-process MCP server `habits`** em `apps/worker/src/skills/habits-mcp.ts`. Registrado no `ClaudeCodeBackend` lado-a-lado com o de `scheduled-messages`.
- **Detecção de hábito por menção natural acontece no LLM**, não no worker. SKILL.md ensina Whis a (a) ter consciência da lista atual de hábitos do Gabriel (carregada via `habit_list` se necessário no início da turn) e (b) match texto livre → hábito. Worker só recebe `habit_id` ou `habit_name` exato no `habit_log`.
- **Skill é primariamente markdown** em `agent/skills/habits/SKILL.md`. Regras de match, formato de confirmação, momentos de propor check-in vivem no markdown. Apenas dashboard render lógica (heatmap calc) e stats vivem no TS (são puras, testáveis).
- **`SOUL.md` ganha 1 regra absoluta nova** com exceção explícita pra `habit_log` (single write tool sem confirmação). Outras writes destrutivas seguem o protocolo padrão.

**De comunicação:**

- Idioma: PT-BR (herdado do SOUL).
- Tom: o mesmo do SOUL — calmo, direto, irônico leve. Cobrança não é punitiva: *"Hoje falta meditação. Bora?"* não *"Você falhou em meditar hoje"*.
- Formato Telegram: MarkdownV2. Heatmap no Obsidian: tabela markdown padrão (renderiza nativamente).
- Confirmação de log: curta, com info útil. *"Anotado: **academia** 45min. Streak: 5 dias."*

## User Stories / Scenarios

**H1 — Criar hábito conversacional (binário, daily):**

1. Gabriel: *"quero começar a meditar 10min todo dia de manhã"*
2. Whis: *"Vou criar: **meditar**, 10min/dia, daily, cadence diária. Quer também que eu te cobre se passar do horário? Posso colocar um check-in pras 21h."*
3. Gabriel: *"sim, 21h tá bom"*
4. Whis monta resumo final: *"Vou criar hábito **meditar** (duração, 10min/dia, daily). E vou agendar check-in 21h diário que pergunta se você fez. Confirma?"*
5. Gabriel: *"sim"*
6. Whis chama `habit_create` (kind=duration, target=10, unit=min, cadence=daily) → recebe `id=1`.
7. Whis chama `schedule_create` (kind=agent, recurrence=`0 21 * * *`, payload: *"é 21h, cheque hábitos pendentes do dia via habit_today_pending e cobre se faltar algum"*) → recebe `schedule_id=42`.
8. Whis confirma: *"Pronto. Hábito #1 criado, check-in agendado pra 21h diário (#42)."*

**H2 — Criar hábito quantitativo (weekly target):**

1. Gabriel: *"3x por semana, malhação"*
2. Whis: *"Vou criar: **malhação**, binário, 3x/semana (qualquer dia). Sem check-in agendado (você não pediu). Confirma?"*
3. *"sim"* → cria.

**H3 — Log natural por menção (sem dizer "registra"):**

1. Gabriel: *"acabei de meditar"*
2. Whis (sabe que `meditar` é hábito ativo): *"Anotado. Quanto tempo?"*  (porque é duração — precisa do valor)
3. Gabriel: *"12min"*
4. Whis chama `habit_log` (habit_id=1, value=12, at=now).
5. Whis: *"Anotado: **meditar** 12min hoje. Streak: 6 dias."*

**H4 — Log quantitativo direto:**

1. Gabriel: *"30 flexões agora"*
2. Whis identifica hábito `flexões` (quantity) → chama `habit_log` (value=30) direto.
3. *"Anotado: **flexões** 30 hoje. Streak: 4 dias. Total na semana: 120."*

**H5 — Log binário direto:**

1. Gabriel: *"fui pra academia"*
2. Whis: hábito `malhação` (binary). Log value=1.
3. *"Anotado: **malhação** hoje. Streak: 3 dias. Semana: 3/3 ✓"*

**H6 — Log retroativo:**

1. Gabriel: *"meditei ontem, esqueci de avisar, 8min"*
2. Whis chama `habit_log` (value=8, at='2026-05-16').
3. *"Anotado: **meditar** 8min em sex 16/05. Streak: 7 dias (ontem fechou)."*

**H7 — Status rápido (read):**

1. Gabriel: *"como tô hoje?"*
2. Whis chama `habit_status` (range=today).
3. Resposta MarkdownV2:
   ```
   *Hoje (sáb 17/05):*
   ✅ meditar — 10min (streak: 7)
   ⬜ malhação — pendente
   ⬜ ler — pendente
   
   *Semana:* 5/12 logs
   ```

**H8 — Dashboard Obsidian (write):**

1. Gabriel: *"atualiza o dashboard"*
2. Whis chama `habit_render_dashboard` (não precisa confirmar — write idempotente em arquivo, não destrutivo).
3. Tool lê `habits` ativos + `habit_logs` últimos 30 dias → renderiza `context/habits/dashboard.md` com tabela heatmap por hábito + streaks + stats mensais.
4. Whis: *"Atualizado: `context/habits/dashboard.md`."*

**H9 — Check-in noturno automático (proativo via scheduled-messages):**

1. Sábado 21:00 — dispatcher dispara scheduled-message #42 (criado em H1).
2. `dispatchSynthetic` injeta prompt sintético: "21h, cheque hábitos pendentes do dia e cobre."
3. Whis chama `habit_today_pending` → recebe `[{ id: 2, name: 'malhação' }, { id: 3, name: 'ler' }]`.
4. Whis envia: *"21h. Hoje falta **malhação** e **ler**. Tem tempo ainda. Bora?"*
5. Gabriel responde *"fui na academia agora"* → mesma sessão continua, fluxo H5 vira log.

**H10 — Editar hábito (write destrutivo, com confirmação):**

1. Gabriel: *"muda meditação pra 15min"*
2. Whis: *"Vou mudar **meditar**: target 10min → 15min. Histórico permanece. Confirma?"*
3. *"sim"* → `habit_edit` (id=1, fields={ target: 15 }).
4. Whis: *"Pronto, atualizado."*

**H11 — Arquivar hábito (write destrutivo, com confirmação):**

1. Gabriel: *"parei de fazer flexões, arquiva"*
2. Whis: *"Vou arquivar **flexões** (quantity, 30/dia). Histórico fica, mas para de aparecer no status diário e não cobra mais. Confirma?"*
3. *"sim"* → `habit_archive` (id=4). Flag `archived_at`. Logs permanecem.

**H12 — Undo log (correção de erro):**

1. Whis acabou de logar "fui na academia" → mas era piada.
2. Gabriel: *"desfaz, foi mal"*
3. Whis chama `habit_log_undo` (last only, dentro de 5min). Retorna log deletado.
4. Whis: *"Desfeito o último log: **malhação** hoje."*

## Success Criteria

A entrega tá **pronta** quando:

1. **Migration `003_habits`** rodada na boot do worker. Cria tabelas:
   - `habits`: `id`, `name`, `kind` (`binary`|`quantity`|`duration`), `unit`, `target`, `cadence` (`daily`|`weekly`|`custom_days`), `target_per_period`, `days_of_week` (CSV ou JSON array), `created_at`, `archived_at` (nullable).
   - `habit_logs`: `id`, `habit_id` (FK), `value`, `logged_at` (timestamp, default now), `for_date` (date the log counts toward — separa data lógica de timestamp técnico), `created_at`, `correlation_id`.
   - Índice em `habit_logs(habit_id, for_date)`.
2. **`HabitRepo` + `HabitLogRepo`** exportados de `@whis/storage`. Ops cobertas:
   - `HabitRepo`: `insert`, `list(filter: 'active'|'archived'|'all')`, `findById`, `findByName(query)`, `update`, `archive(id)`, `unarchive(id)`.
   - `HabitLogRepo`: `insert`, `findByHabitAndDateRange(habit_id, from, to)`, `findLast(habit_id, n)`, `deleteLast(habit_id, withinMs)`, `countByHabitForDate`, `streakDays(habit_id, asOf)`.
   - 100% cobertas em `habit-repo.test.ts` e `habit-log-repo.test.ts` (~20 cases combinados).
3. **In-process MCP server `habits`** registrado em `ClaudeCodeBackend`. 9 tools expostas com schemas Zod:
   - Reads: `habit_list`, `habit_status`, `habit_today_pending`.
   - Writes leves (sem 3-passos): `habit_log`, `habit_log_undo`, `habit_render_dashboard`.
   - Writes destrutivos (com 3-passos no SKILL.md): `habit_create`, `habit_edit`, `habit_archive`, `habit_unarchive`.
4. **Lógica de stats e streak** isolada em `apps/worker/src/skills/habits/stats.ts` (módulo puro, sem I/O). Testado em `stats.test.ts` (~12 cases — daily streak, weekly target hit, edge case de hábito recém-criado, hábito com gaps).
5. **Renderizador de dashboard** em `apps/worker/src/skills/habits/dashboard.ts` (puro: recebe habits + logs, retorna string markdown). Tool `habit_render_dashboard` no MCP só pega dados do repo, chama o renderer e escreve no FS. Testado em `dashboard.test.ts` (~8 cases — heatmap shape, streak, hábito vazio, múltiplos hábitos).
6. **`agent/skills/habits/SKILL.md`** criado com seções: descrição, when_to_use, ferramentas, protocolo de confirmação (com exceção explícita pra `habit_log`/`habit_log_undo`/`habit_render_dashboard`), padrões H1-H12 few-shot, instrução de match natural (como reconhecer "fui pra academia" → habit `malhação`), instrução de oferecer check-in noturno no fluxo de criação.
7. **`agent/SOUL.md`** ganha 1 regra absoluta nova paralela às de Calendar e Scheduled, com exceção destacada pros writes leves de `habits`.
8. **Skill `scheduled-messages` SKILL.md** ganha nota cruzada apontando pra `habits` (quando check-in noturno é melhor que lembrete genérico).
9. **`pnpm run quality-gate`** verde. ~40 tests novos, zero regressão.
10. **`SMOKE.md`** ganha seção "Smoke `habits`" com checklist H1–H12 marcáveis.
11. **H1–H12 validados manualmente** via Telegram + verificação do `context/habits/dashboard.md` no vault.
12. **`AGENTS.md`** atualizado: tabela "Locais de conhecimento" referencia spec 0006.
13. **Logs estruturados** aparecem em `pnpm run docker:logs:local`: `habit_created`, `habit_logged`, `habit_log_undone`, `habit_archived`, `habit_dashboard_rendered`.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Whis loga hábito errado por match ambíguo (ex: user diz "li 20 páginas" e tem dois hábitos `ler` ativos). | SKILL.md instrui: match ambíguo → perguntar antes de chamar `habit_log`. `habit_log_undo` cobre erro residual. |
| User reclama da fricção de confirmar `habit_create` (3 passos) toda vez que quer criar hábito novo. | Aceito. Criação acontece raramente; log (caminho quente) é livre. SKILL.md instrui confirmação curta — *"Confirma?"* só. |
| Streak quebrado por log retroativo errado e Whis "esquece" de oferecer `habit_log_undo`. | SKILL.md inclui padrão H6 com instrução: se user corrigir narrativa, sempre ofereça undo. Aceito risco residual. |
| Dashboard em Obsidian dessincronizado (DB foi atualizado mas dashboard.md velho). | Tool `habit_render_dashboard` é idempotente — qualquer rerun reflete estado atual. Whis pode ser instruído pelo SKILL.md a re-renderizar após mudança estrutural (create/archive). On-demand vence cron-based. |
| `context/habits/dashboard.md` é git-tracked acidentalmente e vira diff ruidoso em commits. | `context/` já é gitignored (vault Obsidian). Risco zero — confirmado em `.gitignore` no Task 0 do plan. |
| Cobrança noturna vira ruído (todo dia 21h, mesmo dia que Gabriel fez tudo). | Whis verifica `habit_today_pending` no disparo; se zero pendentes, manda mensagem positiva ou silencia (decisão no SKILL.md). |
| Schema bloqueia caso de uso novo (ex: hábito anti-vício "dias sem X"). | Non-goal v1. Schema flexível o suficiente pra ganhar campo `direction: 'positive'|'negative'` em v2 sem migration destrutiva. |
| Performance: queries de stats degradam com anos de log. | <10k logs/hábito em ~5 anos com hábito diário. SQLite + índice em `(habit_id, for_date)` resolve. Cache vira preocupação só depois disso. |
| User cria hábitos demais (20+) e dashboard fica monstruoso. | Heatmap renderer agrupa em seções; streaks ficam tabela compacta. Aceito. v2 pode introduzir paginação ou categorias. |
| Timezone — log "ontem" depende de tz do Gabriel. | Hábitos usam timezone `America/Sao_Paulo` por default (igual scheduled-messages). Campo `for_date` é date pura (sem time), interpretada como local-time. Resolvido na hora do log. |
| LLM chama `habit_log` sem `habit_id` válido (alucinou). | Schema Zod valida `habit_id` existe (FK check); tool retorna erro estruturado se inexistente; Whis traduz pro user. |
| `habit_log_undo` corre risco de desfazer log de outra coisa (race com novo log no meio). | Tool sempre desfaz `findLast(habit_id, withinMs=300_000)` — último 5min. Se passou disso, retorna erro "muito tarde, edita manualmente". |
| Confirmação semântica vs lógica para `habit_archive` — user pode achar que perdeu histórico. | SKILL.md instrui Whis a explicar no resumo: *"Histórico fica, só para de aparecer no status."* H11 cobre. |
| Migration `003_habits` falha em DBs sem `schema_version` antigo. | Versionamento já implementado desde 002. Migration idempotente (`CREATE TABLE IF NOT EXISTS`). |

## Open Questions

Nenhuma bloqueante depois do brainstorming inicial. Itens menores resolvíveis na implementação (Task 0 do plan):

- **Granularidade do heatmap.** Default proposto: últimos 30 dias × cada hábito ativo, com emojis `✅` (atingiu), `🟧` (parcial — pra duração/quantidade abaixo do target), `⬜` (não fez), `▫️` (fora da cadence — ex: hábito 3x/semana num dia não-alvo). Confirmar se "parcial" agrega valor ou é só ruído.
- **Janela do `habit_log_undo`.** 5min proposto. Curto demais? Longo demais? Decidir na implementação.
- **Match natural — `habit_list` cacheado por turn ou query toda mensagem?** Default: query toda mensagem onde Whis suspeita de log (custo é uma query SQLite, irrelevante). Se virar gargalo, cache por turn.
- **Comportamento quando hábito é `weekly` 3x e user pergunta status no dia 4 já tendo feito 3.** Status responde "3/3 ✓ semana fechada" e dashboard mostra dias-alvo restantes como `▫️` (fora). Confirmar na renderização.
- **Dashboard Obsidian: 1 arquivo único ou 1 arquivo por hábito?** Default: 1 arquivo `dashboard.md` agrupando todos. Mais fácil ler. Se virar denso, v2 quebra.
- **Tool `habit_today_pending` retorna lista vazia → check-in noturno manda mensagem positiva (*"hoje tá fechado, bora dormir 🌙"*) ou silencia?** SKILL.md propõe mensagem positiva curta. Validar na primeira semana de uso.
- **Hábito de "dormir N horas" cabe no schema (duration)?** Sim — value em min. Mas isso exige timestamp de "ontem à noite a hoje cedo" → for_date é o dia em que acordou. SKILL.md exemplifica.
