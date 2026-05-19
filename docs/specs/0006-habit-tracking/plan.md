---
feature: habit-tracking
spec: "[[spec]]"
created: 2026-05-18
---
# Habit Tracking Skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recomendado pra esta plan, ~12 tasks, várias camadas) ou `superpowers:executing-plans` pra rodar inline. Steps em `[[tasks]]` usam checkbox `- [ ]` pra tracking.

**Goal:** Adicionar a terceira skill funcional do Whis — `habits` — pra tracking conversacional de hábitos com 3 tipos de medição (binário, quantidade, duração), log natural por menção, dois mecanismos de proatividade opt-in (lembrete pré-emptivo por hábito com silenciamento se já feito + check-in noturno geral), dupla visualização (resumo Telegram + dashboard Obsidian com heatmap 30 dias), 10 tools expostas via `inProcessMcpServers`. Reusa engine de `scheduled-messages` (0004) — zero código novo de timer/cron.

**Architecture:** Skill markdown (`agent/skills/habits/SKILL.md`) + duas tabelas SQLite novas `habits` e `habit_logs` (`@whis/storage`) + módulos puros `stats.ts` (streak/aggregação) e `dashboard.ts` (renderização markdown) em `apps/worker/src/skills/habits/` + 10 tools criadas via `createSdkMcpServer` (mesmo pattern da skill 0004) registradas in-process no `ClaudeCodeBackend`. Proatividade é **delegada à skill 0004** — `habit_create` orquestra chamadas a `schedule_create` quando o user opta por lembrete pré-emptivo ou check-in noturno; FK `habits.reminder_schedule_id` permite cascade em `habit_archive`/`habit_edit`. Renderizador escreve `context/habits/dashboard.md` no vault (idempotente). Logs (`habit_log`) são writes leves sem 3-passos de confirmação — UX intuitivo do registro vence o protocolo absoluto; writes destrutivos (`habit_create`/`edit`/`archive`/`unarchive`) seguem o protocolo padrão.

**Tech Stack:** TS strict + Node 24 + pnpm 10 + Vitest + Docker Compose (existentes). **Zero novas dependências runtime** — `@anthropic-ai/claude-agent-sdk`, `zod` e `cron-parser` já são deps do worker (instaladas em 0004). Reuso direto.

---

## Approach

A spec garante separação dura entre os 3 domínios: Google Calendar = eventos formais, `scheduled-messages` = lembretes pessoais leves, `habits` = tracking estruturado de comportamento. A proatividade da skill nova **não** introduz engine própria — quando o user cria hábito com lembrete (ex: "todo dia 17h"), a tool `habit_create` é meramente a coordenadora; quem cria o scheduled-message recorrente é o próprio Whis chamando `schedule_create` na mesma turn, com payload sintético tipo *"17h. Cheque `habit_today_status(id=X)`. Se pending: lembre. Se done: silencie."* No horário, o dispatcher de 0004 dispara, Whis (em `dispatchSynthetic`) executa o prompt, chama a tool nova `habit_today_status` e decide entre mandar mensagem ou silenciar.

A primeira tarefa é **Task 0: Discovery**, que valida em runtime real (não assumido) duas peças:

1. **Confirmar que `context/` é montado read-write no container** (volume Docker) e que o caminho resolvido pelo worker em runtime é `/app/context/`. Validar criação de subdiretório `context/habits/` sem permission denied.
2. **Confirmar que o `dispatchSynthetic` da skill 0004 honra tools de outras skills** — o lembrete pré-emptivo executa um prompt sintético que precisa chamar `habit_today_status` (tool da skill `habits`, não da skill `scheduled-messages`). Se a SDK isola tools por server, precisamos passar ambos os in-process servers no boot. Verificar no código existente e validar com smoke.

A entrega tem **12 tasks** (1 discovery + 10 implementation + 1 smoke), agrupadas em 11 fases. Cada task termina em commit. O plan é TDD-first em tudo que toca lógica (repos, stats, dashboard renderer, tools): teste falha → impl mínima → teste passa → commit. Markdown (SKILL.md, SOUL.md, SMOKE.md) e wire-up (Tasks 9, 10) não têm test automatizado — validação é via boot real + smoke manual (Task 11).

A constraint é a mesma da 0004: quality-gate sobe de ~140 → ~190 tests. Cada task de código adiciona seu bloco de tests no mesmo commit.

## Architecture

```
                    apps/worker (single Node process)
        ┌───────────────────────────────────────────────────────────────────┐
        │                                                                   │
        │   ┌──────────────────┐         ┌──────────────────────────┐       │
        │   │ Telegram channel │◄───────►│       AgentCore          │       │
        │   │ (existente)      │         │  - bind / dispatchSynthetic    │ │
        │   └──────────────────┘         └────────────┬─────────────┘       │
        │                                              │                    │
        │                                              ▼                    │
        │                                ┌────────────────────────┐         │
        │                                │  ClaudeCodeBackend     │         │
        │                                │  inProcessMcpServers:  │         │
        │                                │   - scheduled-messages │         │
        │                                │   - habits 🆕          │         │
        │                                └─────┬──────────────┬───┘         │
        │                                      │              │             │
        │  ┌───────────────────────────────────┼──────────────┼──────────┐  │
        │  │  EXISTING: scheduler/             │              │          │  │
        │  │   - dispatcher (loop 60s)         │              │          │  │
        │  │   - tools (schedule_*)            │              │          │  │
        │  │   - cron wrapper                  │              │          │  │
        │  └───────────────────────────────────┼──────────────┼──────────┘  │
        │                                      │              │             │
        │  ┌───────────────────────────────────┼──────────────┼──────────┐  │
        │  │  NEW: skills/habits/              │              │          │  │
        │  │                                   │              ▼          │  │
        │  │   ┌────────────────────────────────────────────────────┐    │  │
        │  │   │ In-process MCP server "habits"                     │    │  │
        │  │   │ (createSdkMcpServer + 10 zod-typed tools)          │    │  │
        │  │   │   Reads (livres):                                  │    │  │
        │  │   │    habit_list / habit_status / habit_today_pending │    │  │
        │  │   │    habit_today_status                              │    │  │
        │  │   │   Writes leves (sem 3-passos):                     │    │  │
        │  │   │    habit_log / habit_log_undo                      │    │  │
        │  │   │    habit_render_dashboard                          │    │  │
        │  │   │   Writes destrutivos (3-passos via SKILL.md):      │    │  │
        │  │   │    habit_create / habit_edit                       │    │  │
        │  │   │    habit_archive / habit_unarchive                 │    │  │
        │  │   └─────────┬────────────┬─────────────────┬───────────┘    │  │
        │  │             │ closure    │ closure         │ closure        │  │
        │  │             ▼            ▼                 ▼                │  │
        │  │   ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐    │  │
        │  │   │ HabitRepo 🆕 │ │ HabitLogRepo │ │ stats / dashboard│    │  │
        │  │   │  (SQLite,    │ │     🆕       │ │   (puros, sem    │    │  │
        │  │   │  migration   │ │              │ │     I/O)         │    │  │
        │  │   │   _003)      │ │              │ │                  │    │  │
        │  │   └──────────────┘ └──────────────┘ └────────┬─────────┘    │  │
        │  │                                              │              │  │
        │  │                                              ▼              │  │
        │  │                              fs.writeFileSync(              │  │
        │  │                                context/habits/dashboard.md) │  │
        │  └─────────────────────────────────────────────────────────────┘  │
        └───────────────────────────────────────────────────────────────────┘

        agent/skills/habits/SKILL.md             ← injetado no system prompt
        agent/skills/scheduled-messages/SKILL.md ← +1 nota cruzada apontando pra habits
        agent/SOUL.md (Regras absolutas)         ← +1 linha (com exceção pra habit_log)
```

**Component responsibilities:**

- **`packages/storage/src/db.ts`** — adiciona `MIGRATION_003` (CREATE TABLE habits + habit_logs + índice). Idempotente, additive only. **Modificado.**
- **`packages/storage/src/habit-repo.ts`** — novo repo. Métodos: `insert`, `findById`, `findByName`, `list(filter)`, `update`, `setReminderScheduleId`, `archive`, `unarchive`. Prepared statements + transações. **Novo.**
- **`packages/storage/src/habit-repo.test.ts`** — Vitest cobrindo CRUD + archive cascade + reminder FK. **Novo.**
- **`packages/storage/src/habit-log-repo.ts`** — novo repo. Métodos: `insert`, `findByHabitAndDateRange`, `findLast`, `deleteLast(habitId, withinMs)`, `countByHabitForDate`, `streakDays`. **Novo.**
- **`packages/storage/src/habit-log-repo.test.ts`** — Vitest cobrindo insert + range queries + streak edge cases + deleteLast com janela. **Novo.**
- **`packages/storage/src/index.ts`** — re-exporta `HabitRepo`, `HabitRecord`, `HabitLogRepo`, `HabitLogRecord`. **Modificado.**
- **`apps/worker/src/skills/habits/stats.ts`** — módulo puro. Funções: `computeStreak(logs, asOf, cadence)`, `aggregatePeriod(logs, range, kind)`, `isPendingForDate(habit, logs, date)`, `expectsHabitOnDate(habit, date)`. Sem I/O. **Novo.**
- **`apps/worker/src/skills/habits/stats.test.ts`** — Vitest, ~14 cases (daily streak intacto, streak quebrado por gap, weekly target hit, custom_days fora-de-dia ignorado, hábito recém-criado, soma vs média por kind). **Novo.**
- **`apps/worker/src/skills/habits/dashboard.ts`** — módulo puro. Função `renderDashboard({ habits, logs, asOf }): string` → retorna markdown com tabela heatmap 30 dias + streaks + stats. Sem I/O. **Novo.**
- **`apps/worker/src/skills/habits/dashboard.test.ts`** — Vitest, ~8 cases (heatmap shape, hábito vazio, múltiplos hábitos, parcial vs done). **Novo.**
- **`apps/worker/src/skills/habits/tools.ts`** — `createHabitsMcpServer(deps)` — factory que retorna `InProcessMcpServer` com 10 tools. Cada tool: zod schema input, handler valida → chama repo/stats → retorna output JSON. **Novo.**
- **`apps/worker/src/skills/habits/tools.test.ts`** — Vitest, ~22 cases (input válido/inválido por tool, undo dentro/fora da janela, dashboard write em fs:memfs ou tmpdir). **Novo.**
- **`apps/worker/src/index.ts`** — instancia `HabitRepo`, `HabitLogRepo`, `createHabitsMcpServer`, registra MCP server no `inProcessMcpServers` ao lado de `scheduled-messages`. **Modificado.**
- **`agent/skills/habits/SKILL.md`** — skill markdown (~180 linhas). Seções: when_to_use, ferramentas (3 tiers), protocolo de confirmação com exceção pros writes leves, padrões H1-H12 few-shot, match natural de log, instrução de oferecer proatividade no flow de criação, formato de output. **Novo.**
- **`agent/SOUL.md`** — +1 regra absoluta paralela às de Calendar e Scheduled, com exceção explícita pra `habit_log`/`habit_log_undo`/`habit_render_dashboard`. **Modificado.**
- **`agent/skills/scheduled-messages/SKILL.md`** — +1 nota cruzada "quando preferir skill habits" (lembretes que silenciam se já feito → use `habits`; lembrete cego → use `scheduled-messages`). **Modificado.**
- **`SMOKE.md`** — nova seção "Smoke `habits`" com H1-H12 + verificação do dashboard. **Modificado.**
- **`AGENTS.md`** — atualizar tabela "Locais de conhecimento" pra referenciar spec 0006. **Modificado** (no commit do spec, retroativo se necessário).
- **`docs/specs/0006-habit-tracking/discovery-notes.md`** — Task 0 findings. **Novo.**
- **`docs/specs/0006-habit-tracking/smoke-results.md`** — Task 11 resultados. **Novo.**

## Tech Stack

- **Runtime:** Node.js 24 (já temos).
- **Libs novas:** **nenhuma**. `cron-parser`, `zod`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3` — todos instalados em entregas anteriores.
- **In-process MCP:** `createSdkMcpServer` (mesmo helper já usado por `scheduled-messages`). Tool schemas via `zod`.
- **DB:** SQLite via `better-sqlite3` — single-process, single-connection.
- **Tests:** Vitest com `:memory:` DB pros repos; `os.tmpdir()` pros testes do dashboard renderer (write em fs real isolado).
- **Setup user:** **zero** — feature funciona sem config adicional. Skill é always-active (igual `google-calendar` e `scheduled-messages`).

## File Structure

🆕 = novo, 🔧 = modificado, ✅ = não muda.

**`packages/storage/src/`:**
- `db.ts` 🔧 — MIGRATION_003 + entry no array MIGRATIONS
- `habit-repo.ts` 🆕
- `habit-repo.test.ts` 🆕
- `habit-log-repo.ts` 🆕
- `habit-log-repo.test.ts` 🆕
- `index.ts` 🔧 — re-exports

**`apps/worker/src/skills/habits/`:** *(diretório novo)*
- `stats.ts` 🆕
- `stats.test.ts` 🆕
- `dashboard.ts` 🆕
- `dashboard.test.ts` 🆕
- `tools.ts` 🆕
- `tools.test.ts` 🆕

**`apps/worker/src/`:**
- `index.ts` 🔧 — wire-up do MCP habits

**`agent/`:**
- `skills/habits/SKILL.md` 🆕
- `skills/scheduled-messages/SKILL.md` 🔧 — nota cruzada
- `SOUL.md` 🔧 — +1 regra absoluta

**Root:**
- `SMOKE.md` 🔧 — seção H1-H12
- `AGENTS.md` 🔧 — referência à spec 0006

**`docs/specs/0006-habit-tracking/`:**
- `spec.md` ✅ — committed em `edf1df4` + `6bf82e6`
- `plan.md` 🆕 — este arquivo
- `tasks.md` 🆕
- `discovery-notes.md` 🆕 — Task 0
- `smoke-results.md` 🆕 — Task 11

## Phase Ordering

Cada fase termina em estado verificável (quality-gate verde + commit).

1. **Phase 1: Discovery (Task 0).** Valida `context/` writable + tool routing cross-skill no `dispatchSynthetic`. Estado: `discovery-notes.md` commitado.
2. **Phase 2: Storage — habits (Task 1).** Migration_003 (parte 1: tabela `habits`) + `HabitRepo` + tests. Estado: ~12 tests novos passando.
3. **Phase 3: Storage — habit_logs (Task 2).** Migration_003 (parte 2: tabela `habit_logs` + índice) + `HabitLogRepo` + tests. Estado: ~14 tests novos.
4. **Phase 4: Stats module (Task 3).** `stats.ts` + tests. Estado: ~14 tests, módulo puro testado isolado.
5. **Phase 5: Dashboard renderer (Task 4).** `dashboard.ts` + tests. Estado: ~8 tests, output markdown determinístico verificado.
6. **Phase 6: MCP tools — reads (Task 5).** `habit_list`, `habit_status`, `habit_today_pending`, `habit_today_status` + tests. Estado: ~10 tests, tools chamam repo+stats sem precisar do SDK rodando.
7. **Phase 7: MCP tools — writes leves (Task 6).** `habit_log`, `habit_log_undo`, `habit_render_dashboard` + tests. Estado: ~8 tests; `habit_render_dashboard` escreve em tmpdir nos testes.
8. **Phase 8: MCP tools — writes destrutivos (Task 7).** `habit_create`, `habit_edit`, `habit_archive`, `habit_unarchive` + tests. Estado: ~12 tests.
9. **Phase 9: MCP server factory (Task 8).** `createHabitsMcpServer` agrupando as 10 tools com schemas zod. Estado: factory exportada, smoke unit verde.
10. **Phase 10: Wire-up no index.ts (Task 9).** Instancia repos, factory, registra no `inProcessMcpServers`. Estado: `pnpm run quality-gate` verde, container sobe, log `mcp_inprocess_registered name=habits`.
11. **Phase 11: Skills + SOUL + nota cruzada (Task 10).** SKILL.md novo + atualização do scheduled-messages + regra SOUL. Estado: `soul_md_loaded` mostra bytes maiores no boot; skills carregam sem erro.
12. **Phase 12: Docs (parte de Task 10) + Smoke (Task 11).** SMOKE.md ganha H1-H12. Executa H1-H12 via Telegram + verifica `context/habits/dashboard.md` no vault. Estado: `smoke-results.md` commitado, spec frontmatter `status: shipped`.

**Dependencies notáveis:**
- Task 1 e Task 2 são sequenciais (mesma migration, mesma idempotência).
- Task 3 (stats) e Task 4 (dashboard) precisam de Task 1+2 (tipos de record) mas são puros — podem rodar paralelo.
- Tasks 5, 6, 7 dependem de 1+2+3 (tools chamam repos e stats). Task 7 também depende de tools de `scheduled-messages` já existentes (será chamada na mesma turn pelo Whis em `habit_create` quando user opta por lembrete — mas isso é orquestração no LLM, não dependência de código).
- Task 8 (factory) depende de 5+6+7.
- Task 9 (wire-up) depende de 8.
- Task 10 (skills) depende de 9 (precisa de tools registradas pra few-shots fazerem sentido).
- Task 11 (smoke) depende de 9 + 10.
- Tasks 3 e 4 podem rodar paralelas. Tasks 5, 6, 7 podem rodar paralelas entre si.

## Notas operacionais

- **Compose change não é necessário** — sem novos volumes, portas ou env vars. `whis_data` (já existe) persiste o SQLite com as 2 tabelas novas. `context/` já está montado read-write (validação na Task 0).
- **Migration roda automática no boot** via `runMigrations(db)` em `index.ts` (existente). `schema_version` sobe pra 3 silenciosamente.
- **Sem mudança no Dockerfile** — zero deps novas.
- **Backward compat:** specs 0001-0005 intactas. Whis com Telegram + Calendar + Scheduled continua funcionando se a feature nova for desabilitada (basta não registrar o MCP server `habits` — feito por skip no `index.ts` se preferir guard por env futuro). v1 sempre ativa.
- **Logs estruturados:** `habit_created`, `habit_logged`, `habit_log_undone`, `habit_archived`, `habit_unarchived`, `habit_dashboard_rendered { path, size_bytes }`, `habit_reminder_sent { habit_id, schedule_id }`, `habit_reminder_silenced { habit_id, schedule_id }`. Buscáveis em `pnpm run docker:logs:local` durante smoke.
- **Path do dashboard em runtime:** `${config.contextDir}/habits/dashboard.md`. Validação na Task 0 que `contextDir` resolve correto dentro do container.
- **Quality-gate alvo:** ~140 tests atuais + ~78 novos = ~218 tests, todos verdes.

## Risks / Open Decisions

**Locked-in pela spec (não re-abrir sem voltar à spec):**
- Duas tabelas próprias (`habits` + `habit_logs`), separadas de `scheduled_messages`.
- Três tipos de hábito (binary/quantity/duration), 3 cadences (daily/weekly/custom_days).
- Criação puramente conversacional (sem YAML).
- Log sem confirmação 3-passos; writes destrutivos com.
- Proatividade delegada à skill 0004 (zero engine nova).
- FK `habits.reminder_schedule_id` nullable para cascade.
- Visualização dupla: Telegram (`habit_status`) + Obsidian (`habit_render_dashboard`).
- Streaks calculados em runtime, sem cache.

**Resolvíveis em Task 0 (Discovery):**
- Path exato de `context/` em runtime + permissão de criar subdir.
- Comportamento de routing de tools cross-skill no `dispatchSynthetic` (lembrete pré-emptivo precisa chamar `habit_today_status` — tool de outra skill).
- Decisão final sobre dashboard render: markdown puro com emojis ASCII-safe (`✅ ⬜ 🟧 ▫️`) ou usar caracteres Unicode bem suportados pelo Obsidian. Default proposto: ✅ ⬜ 🟧 ▫️ — validar render.

**Aceitos como conhecidos:**
- Match natural ambíguo pode logar errado — `habit_log_undo` cobre, janela 5min.
- Streak quebrado por log retroativo errado — undo + relog cobre.
- Dashboard pode ficar denso com 20+ hábitos — v2 paginação/categorias.
- `context/` corrompido = perda de dashboard, mas DB sobrevive (single source of truth).

**Riscos novos:**
- Task 0 pode descobrir que `dispatchSynthetic` não tem acesso a tools de outras skills (isolamento por server). Mitigação: passar **todos** os in-process servers no `mcpServers` da chamada — já é o caso, pois `ClaudeCodeBackend` registra o dict inteiro de `inProcessMcpServers`. Validar com smoke real.
- Renderização Markdown com 30 colunas (heatmap) pode quebrar layout no Telegram se Whis tentar mostrar lá. Mitigação: dashboard markdown é **só** pro Obsidian; `habit_status` no Telegram tem formato compacto separado. Tools diferentes, outputs diferentes.

---

Execução detalhada está em `[[tasks]]`.
