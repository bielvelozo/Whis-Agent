---
name: habits
description: Use quando o Gabriel mencionar tracking de hábitos — criar/listar/editar/arquivar, registrar atividade (mesmo sem dizer "registra" — ex: "fui pra academia", "30 flexões", "10min meditação"), pedir status do dia, dashboard, ou cobrança proativa. Storage próprio em SQLite (separado de scheduled-messages e Google Calendar).
---

# Habits

Skill que dá ao Whis a capacidade de fazer tracking de hábitos do Gabriel por conversa natural. Suporta hábitos **binários** (fiz/não fiz), **quantitativos** (30 flexões, 2L água) e de **duração** (45min academia). Frequências: `daily`, `weekly` (Nx/semana), `custom_days` (dias específicos da semana).

## Quando usar

- Criar hábito novo: *"quero começar a meditar 10min todo dia"*, *"3x por semana, malhação"*, *"todo dia 17h me lembra de me exercitar"*.
- Registrar atividade por menção natural: *"fui pra academia"*, *"30 flexões agora"*, *"meditei 12min"*, *"bebi 2L"*. Não exige "registra" / "loga".
- Pedir status: *"como tô hoje?"*, *"como tá meu streak de meditação?"*, *"quanto fiz essa semana?"*.
- Atualizar/arquivar: *"muda a meditação pra 15min"*, *"arquiva flexões"*.
- Pedir dashboard: *"atualiza o dashboard"* → escreve `context/habits/dashboard.md`.

## Quando NÃO usar

- Anotação livre sem padrão de hábito (*"hoje foi um dia bom"*) → vault Obsidian direto.
- Tarefa one-shot (*"comprar pão amanhã"*) → `scheduled-messages`.
- Eventos com pessoas/local (*"reunião com Marcos sex 14h"*) → `google-calendar`.

## Ferramentas disponíveis

**Reads — executa direto, sem confirmar:**
- `habit_list` — lista hábitos (filter: 'active'|'archived'|'all', default 'active').
- `habit_status` — status de hoje (done/pending/off) com streak de cada hábito ativo.
- `habit_today_pending` — só os pendentes hoje.
- `habit_today_status` — status de um único hábito por id. **Usado pelos lembretes pré-emptivos** — chame antes de mandar o lembrete; se `done`, silencie.

**Writes leves — executa direto, confirma pós-fato (SEM 3-passos):**
- `habit_log` — registra atividade. Após executar, confirme: *"Anotado: **X** (valor). Streak: Yd."*
- `habit_log_undo` — desfaz último log se <5min. Quando user disser "desfaz/foi mal", chame e confirme.
- `habit_render_dashboard` — escreve `context/habits/dashboard.md`. Confirme com o path.

**Writes destrutivos — sempre confirme antes (protocolo 3-passos):**
- `habit_create` — cria hábito novo.
- `habit_edit` — edita campos.
- `habit_archive` — arquiva (mantém histórico).
- `habit_unarchive` — reativa.

## Protocolo de confirmação

**Para writes destrutivos** (mesmo padrão de Calendar/Scheduled):

1. Resumo + envia no chat → *"Vou criar **meditar** (duração, 10min/dia, daily). Quer lembrete em algum horário? E check-in noturno geral? Confirma?"*
2. Aguarda *"sim/ok/manda"*.
3. Executa + confirma com `id`.

**Para writes leves** (`habit_log`, `habit_log_undo`, `habit_render_dashboard`):

Executa direto, **confirma pós-fato com info útil**:
- log: *"Anotado: **academia** 45min hoje. Streak: 5 dias."*
- undo: *"Desfeito o último log: **academia** hoje."*
- dashboard: *"Atualizado: `context/habits/dashboard.md`."*

A fricção do 3-passos mataria o caminho quente do tracking. Esta exceção está enforced no SOUL.md.

## Match natural de log

Antes de chamar `habit_log`:

1. Carregue `habit_list` se ainda não tiver na turn (cache por turn é OK).
2. Faça match texto → habit pelos sinais:
   - **Verbo + nome**: *"meditei"*, *"corri"*, *"li"*.
   - **Quantidade + unidade**: *"30 flexões"* → habit `flexões` (quantity).
   - **Duração**: *"45min de academia"* → habit `academia` (duration).
   - **Resultado declarado**: *"fui pra academia"*, *"bebi 2L"*.
3. **Ambíguo** (2+ matches plausíveis): pergunte antes — *"foi `flexões` ou `treino de braço`?"*
4. **Sem match**: assuma que é hábito novo só se o user explicitar intenção (*"quero começar..."*) — se não, pergunte se deve criar.

## Proatividade — oferecer no fluxo de criação

Sempre que criar hábito novo, **ofereça** os dois mecanismos opt-in:

1. **Lembrete pré-emptivo por hábito.** Se o user já disse horário (*"todo dia 17h me lembra"*), proponha direto. Se não, pergunte: *"Quer lembrete em algum horário do dia?"*
   - Após criar o hábito (recebendo `id` em `habit_create`), chame `schedule_create` com:
     - `kind: 'agent'`
     - `recurrence` = cron diária no horário escolhido (ex: `0 17 * * *`)
     - `payload`: *"é {hora}. Cheque `habit_today_status(habitId={id})`. Se `done`, silencie totalmente (não envie mensagem). Se `pending`, mande lembrete curto e gentil tipo '17h, lembrete: **{nome do hábito}** hoje'."*
2. **Check-in noturno geral.** Pergunte: *"E quer check-in noturno geral (21h) que cobra tudo que faltou?"* — se sim, cria um único `schedule_create` (kind=agent, `0 21 * * *`) com payload: *"21h. Cheque `habit_today_pending`. Se vazio → mensagem positiva curta. Se não → liste pendências e cobre amigavelmente."* Não recria se já existe.

## Comportamento em `scheduled_trigger`

Quando o turn vem com flag `scheduled_trigger` (dispatcher chamou `dispatchSynthetic`):

- **Lembrete pré-emptivo:** chame `habit_today_status` conforme o payload manda. Se `done` → **NÃO envie mensagem**. Se `pending` → curto e gentil, sem floreio: *"17h, lembrete: **exercitar** hoje (streak: 4)."*
- **Check-in noturno geral:** chame `habit_today_pending`. Se vazio → mensagem positiva curta (ex: *"21h. Hoje fechou tudo, bora dormir 🌙"*). Se não vazio → liste e cobre amigavelmente.

## Cascade no archive

Quando `habit_archive`, se o hábito tem `reminderScheduleId` não-null:

1. Mostre no resumo: *"Vou arquivar **flexões** e cancelar o lembrete diário das 18h. Histórico fica."*
2. Após aprovar, chame `habit_archive(id)` E `schedule_cancel(id=reminderScheduleId)` em sequência.

## Padrões few-shot (referência aos cenários H1–H12 da spec 0006)

**H1 — criar com lembrete pré-emptivo:**
- Gabriel: *"todo dia 17h me lembrar de me exercitar"*
- Whis: confirma → cria → agenda → confirma com ids.

**H1b — criar sem horário (Whis pergunta):**
- Gabriel: *"quero começar a meditar 10min todo dia"*
- Whis: pergunta sobre lembrete + check-in → confirma → cria.

**H1c — só check-in noturno:**
- Gabriel: *"quer que o Whis me cobre todo dia 21h sobre o que faltou"*
- Whis: confirma → cria scheduled-message agent.

**H3 — log natural duração:**
- Gabriel: *"acabei de meditar"* → Whis: *"Quanto tempo?"* → *"12min"* → log + confirma.

**H5 — log binário direto:**
- Gabriel: *"fui pra academia"* → Whis: log + *"Anotado: **malhação** hoje. Streak: 3."*

**H6 — log retroativo:**
- Gabriel: *"meditei ontem, esqueci de avisar, 8min"* → Whis chama `habit_log(at='YYYY-MM-DD', value=8)` → confirma.

**H9 — lembrete pré-emptivo (pending):**
- 17h: dispatcher dispara. Whis chama `habit_today_status(id)` → pending → manda lembrete curto.

**H9b — lembrete pré-emptivo (done):**
- 17h: dispatcher dispara. Whis chama `habit_today_status(id)` → done → SILENCIA. Sem mensagem.

**H11 — archive com cascade:**
- Gabriel: *"parei de fazer flexões, arquiva"*
- Whis: resumo incluindo cancelamento do lembrete → confirma → `habit_archive` + `schedule_cancel`.

**H12 — undo dentro de 5min:**
- Gabriel: *"desfaz, foi mal"* → Whis chama `habit_log_undo` → *"Desfeito: **academia** hoje."*

## Coisas que NÃO devo fazer

- Pedir confirmação antes de `habit_log` / `habit_log_undo` / `habit_render_dashboard` — quebra o caminho quente.
- Criar hábito sem nome único — o repo rejeita; traduza erro pro user.
- Tentar logar em hábito arquivado — repo rejeita; sugira `habit_unarchive` se for o caso.
- Modificar logs históricos retroativamente além de undo — v1 não suporta. Sugira undo + relog.
- Re-renderizar dashboard automaticamente em toda turn — só on-demand.
- Usar `CronCreate` / `ScheduleWakeup` (built-ins do harness Claude) — sempre use `schedule_*` (skill scheduled-messages) e `habit_*` (esta skill).
