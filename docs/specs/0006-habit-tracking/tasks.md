---
feature: habit-tracking
plan: "[[plan]]"
spec: "[[spec]]"
created: 2026-05-18
---
# Habit Tracking Skill — Tasks

**For this plan:** `[[plan]]`

12 tasks (1 discovery + 10 implementation + 1 smoke). TDD-first em tudo que toca lógica. Cada task termina em commit. Quality-gate verde em cada commit (~140 → ~218 tests).

---

## Phase 1: Discovery

### Task 0: Validar `context/` writable + tool routing cross-skill

**Purpose:** Resolver Open Questions do plan antes de escrever código que depende delas (Tasks 4, 6, 9).

**Files:**
- Create: `docs/specs/0006-habit-tracking/discovery-notes.md`

- [ ] **Step 1: Localizar `contextDir` em runtime**

```bash
grep -rn "contextDir\|context/\|/app/context" apps/worker/src/ infra/ 2>&1 | head -20
```

Anotar: variável no config, valor default, caminho dentro do container, montagem em `docker-compose.yml`.

- [ ] **Step 2: Validar permissão de criar subdir**

Subir o worker e exec dentro do container:

```bash
pnpm run docker:up && pnpm run docker:sh -- 'mkdir -p /app/context/habits && touch /app/context/habits/test.md && ls -la /app/context/habits/ && rm /app/context/habits/test.md'
```

Esperado: `test.md` criado sem permission denied, dono = `node:node`. Anotar permissões.

- [ ] **Step 3: Inspecionar como `dispatchSynthetic` injeta MCP servers**

```bash
grep -n "inProcessMcpServers\|mcpServers" apps/worker/src/agent/*.ts apps/worker/src/index.ts
```

Verificar que `ClaudeCodeBackend` passa o **dict inteiro** de `inProcessMcpServers` em toda query (não filtra por skill). Confirmar que `dispatchSynthetic` reusa `core.bind` → `backend.query` → mesmas tools disponíveis pra qualquer turn (humano ou sintética). Anotar exatamente o trajeto.

- [ ] **Step 4: Validar rendering Unicode dos emojis no Obsidian**

Criar arquivo de teste manual:

```bash
cat > /tmp/heatmap-test.md <<'EOF'
| dia | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| meditar | ✅ | ✅ | ⬜ | 🟧 | ▫️ |
EOF
```

Copiar para o vault local (`context/habits/_test.md`) e abrir no Obsidian. Confirmar que os 4 emojis renderizam alinhados e visualmente distintos. Anotar. Se algum tiver problema, propor alternativa (ex: `▪` em vez de `▫️`).

- [ ] **Step 5: Escrever `discovery-notes.md`**

Create `docs/specs/0006-habit-tracking/discovery-notes.md`:

```markdown
---
feature: habit-tracking
spec: "[[spec]]"
plan: "[[plan]]"
created: 2026-05-18
---
# Discovery — Habit Tracking (0006)

**Data:** 2026-05-18

## 1. contextDir em runtime
**Variável:** [anotar — provável config.contextDir, lido do .env]
**Valor default:** [anotar]
**Path no container:** /app/context
**Montagem (compose):** [linha exata do docker-compose.yml]
**Permissões:** dono `node:node`, write OK em subdirs.

## 2. Tool routing cross-skill no dispatchSynthetic
**ClaudeCodeBackend.query** recebe `inProcessMcpServers` completo. Não há filtro por skill. Lembrete pré-emptivo (scheduled-message agent disparado em modo synthetic) **pode** chamar `habit_today_status` (tool da skill habits) sem mudança no backend.
**Veredito:** OK pra prosseguir.

## 3. Rendering Unicode no Obsidian
**Testado:** ✅ ⬜ 🟧 ▫️
**Resultado:** [anotar — todos renderizam? ou substituir algum?]
**Decisão final pro renderer:** [anotar caracteres finais]

## 4. Open questions resolvidas
- Janela do habit_log_undo: 5min (confirmado pelo Gabriel via spec).
- Dashboard: 1 arquivo único `context/habits/dashboard.md` (confirmado).
```

- [ ] **Step 6: Commit**

```bash
git add docs/specs/0006-habit-tracking/discovery-notes.md
git commit -m "docs(discovery): context dir + cross-skill tool routing (spec 0006)"
```

---

## Phase 2: Storage — habits table

### Task 1: Migration_003 part 1 (`habits`) + `HabitRepo` + tests

**Files:**
- Modify: `packages/storage/src/db.ts`
- Create: `packages/storage/src/habit-repo.ts`
- Create: `packages/storage/src/habit-repo.test.ts`
- Modify: `packages/storage/src/index.ts`

- [ ] **Step 1: Adicionar MIGRATION_003 ao `db.ts`**

Edit `packages/storage/src/db.ts`. Após o bloco `MIGRATION_002`, adicionar:

```ts
const MIGRATION_003 = `
CREATE TABLE habits (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT    NOT NULL UNIQUE,
  kind                   TEXT    NOT NULL CHECK (kind IN ('binary','quantity','duration')),
  unit                   TEXT,
  target                 REAL,
  cadence                TEXT    NOT NULL CHECK (cadence IN ('daily','weekly','custom_days')),
  target_per_period      INTEGER,
  days_of_week           TEXT,
  reminder_schedule_id   INTEGER REFERENCES scheduled_messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  archived_at            INTEGER
);

CREATE TABLE habit_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id        INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  value           REAL    NOT NULL,
  logged_at       INTEGER NOT NULL,
  for_date        TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  correlation_id  TEXT    NOT NULL
);
CREATE INDEX idx_habit_logs_habit_date ON habit_logs (habit_id, for_date);
`;
```

E atualizar o array `MIGRATIONS`:

```ts
const MIGRATIONS: Migration[] = [
  { version: 1, filename: '001_initial.sql', sql: MIGRATION_001 },
  { version: 2, filename: '002_scheduled_messages.sql', sql: MIGRATION_002 },
  { version: 3, filename: '003_habits.sql', sql: MIGRATION_003 },
];
```

*Nota:* a migration cria as duas tabelas no mesmo step pra simplicidade (mesmo schema_version). Task 2 vai escrever o `HabitLogRepo` que consome `habit_logs`.

- [ ] **Step 2: Escrever tests do `HabitRepo` (TDD — vão falhar)**

Create `packages/storage/src/habit-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db';
import { HabitRepo, type HabitRecord } from './habit-repo';
import { ScheduledMessageRepo } from './scheduled-message-repo';

const baseHabit = (overrides: Partial<Omit<HabitRecord, 'id'>> = {}): Omit<HabitRecord, 'id'> => ({
  name: 'meditar',
  kind: 'duration',
  unit: 'min',
  target: 10,
  cadence: 'daily',
  targetPerPeriod: null,
  daysOfWeek: null,
  reminderScheduleId: null,
  createdAt: 1_700_000_000_000,
  archivedAt: null,
  ...overrides,
});

describe('HabitRepo', () => {
  let db: Db;
  let repo: HabitRepo;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    repo = new HabitRepo(db);
  });

  it('insert returns id and persists fields', () => {
    const id = repo.insert(baseHabit());
    expect(id).toBeGreaterThan(0);
    const found = repo.findById(id);
    expect(found?.name).toBe('meditar');
    expect(found?.kind).toBe('duration');
    expect(found?.target).toBe(10);
  });

  it('insert rejects duplicate name', () => {
    repo.insert(baseHabit({ name: 'meditar' }));
    expect(() => repo.insert(baseHabit({ name: 'meditar' }))).toThrow(/UNIQUE/);
  });

  it('list(active) excludes archived', () => {
    const id1 = repo.insert(baseHabit({ name: 'a' }));
    repo.insert(baseHabit({ name: 'b' }));
    repo.archive(id1, 1_700_000_001_000);
    expect(repo.list('active').map((h) => h.name)).toEqual(['b']);
  });

  it('list(archived) returns only archived', () => {
    const id = repo.insert(baseHabit({ name: 'x' }));
    repo.archive(id, 1_700_000_001_000);
    expect(repo.list('archived').map((h) => h.name)).toEqual(['x']);
  });

  it('list(all) returns both', () => {
    repo.insert(baseHabit({ name: 'a' }));
    const id = repo.insert(baseHabit({ name: 'b' }));
    repo.archive(id, 1_700_000_001_000);
    expect(repo.list('all').map((h) => h.name).sort()).toEqual(['a', 'b']);
  });

  it('findByName matches case-insensitive substring', () => {
    repo.insert(baseHabit({ name: 'Meditar Diariamente' }));
    expect(repo.findByName('meditar')?.name).toBe('Meditar Diariamente');
    expect(repo.findByName('diaria')?.name).toBe('Meditar Diariamente');
    expect(repo.findByName('foo')).toBeNull();
  });

  it('update changes fields atomically', () => {
    const id = repo.insert(baseHabit());
    repo.update(id, { target: 15, unit: 'min' });
    expect(repo.findById(id)?.target).toBe(15);
  });

  it('setReminderScheduleId links to FK', () => {
    const id = repo.insert(baseHabit());
    const scheduledRepo = new ScheduledMessageRepo(db);
    const schedId = scheduledRepo.insert({
      chatId: 'tg:1', title: 'lembrete', kind: 'agent',
      payload: 'x', recurrence: '0 17 * * *', timezone: 'America/Sao_Paulo',
      nextFireAt: 1_900_000_000_000, lastFiredAt: null, paused: 0,
      createdAt: 1_700_000_000_000, createdCorrelationId: 'c1',
    });
    repo.setReminderScheduleId(id, schedId);
    expect(repo.findById(id)?.reminderScheduleId).toBe(schedId);
    repo.setReminderScheduleId(id, null);
    expect(repo.findById(id)?.reminderScheduleId).toBeNull();
  });

  it('archive sets archivedAt; unarchive clears', () => {
    const id = repo.insert(baseHabit());
    repo.archive(id, 1_700_000_002_000);
    expect(repo.findById(id)?.archivedAt).toBe(1_700_000_002_000);
    repo.unarchive(id);
    expect(repo.findById(id)?.archivedAt).toBeNull();
  });

  it('FK ON DELETE SET NULL cleans reminder_schedule_id when scheduled-message is removed', () => {
    const scheduledRepo = new ScheduledMessageRepo(db);
    const schedId = scheduledRepo.insert({
      chatId: 'tg:1', title: 'x', kind: 'agent', payload: 'y',
      recurrence: '0 17 * * *', timezone: 'America/Sao_Paulo',
      nextFireAt: 1_900_000_000_000, lastFiredAt: null, paused: 0,
      createdAt: 1_700_000_000_000, createdCorrelationId: 'c1',
    });
    const hid = repo.insert(baseHabit({ reminderScheduleId: schedId }));
    scheduledRepo.delete(schedId);
    expect(repo.findById(hid)?.reminderScheduleId).toBeNull();
  });
});
```

Rode `pnpm test --filter @whis/storage habit-repo`. Esperado: erro de import `HabitRepo` não existe.

- [ ] **Step 3: Implementar `habit-repo.ts`**

Create `packages/storage/src/habit-repo.ts`:

```ts
import type { Db } from './db';

export type HabitKind = 'binary' | 'quantity' | 'duration';
export type HabitCadence = 'daily' | 'weekly' | 'custom_days';

export interface HabitRecord {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  cadence: HabitCadence;
  targetPerPeriod: number | null;
  /** CSV "1,3,5" (1=monday) ou null se cadence !== 'custom_days' */
  daysOfWeek: string | null;
  reminderScheduleId: number | null;
  createdAt: number;
  archivedAt: number | null;
}

type DbRow = {
  id: number;
  name: string;
  kind: HabitKind;
  unit: string | null;
  target: number | null;
  cadence: HabitCadence;
  target_per_period: number | null;
  days_of_week: string | null;
  reminder_schedule_id: number | null;
  created_at: number;
  archived_at: number | null;
};

const fromRow = (r: DbRow): HabitRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  unit: r.unit,
  target: r.target,
  cadence: r.cadence,
  targetPerPeriod: r.target_per_period,
  daysOfWeek: r.days_of_week,
  reminderScheduleId: r.reminder_schedule_id,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

export class HabitRepo {
  constructor(private readonly db: Db) {}

  insert(rec: Omit<HabitRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO habits
        (name, kind, unit, target, cadence, target_per_period, days_of_week,
         reminder_schedule_id, created_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      rec.name,
      rec.kind,
      rec.unit,
      rec.target,
      rec.cadence,
      rec.targetPerPeriod,
      rec.daysOfWeek,
      rec.reminderScheduleId,
      rec.createdAt,
      rec.archivedAt,
    );
    return info.lastInsertRowid as number;
  }

  findById(id: number): HabitRecord | null {
    const row = this.db.prepare('SELECT * FROM habits WHERE id = ?').get(id) as DbRow | undefined;
    return row ? fromRow(row) : null;
  }

  findByName(query: string): HabitRecord | null {
    const row = this.db
      .prepare("SELECT * FROM habits WHERE name LIKE ? COLLATE NOCASE ORDER BY archived_at IS NOT NULL, id ASC LIMIT 1")
      .get(`%${query}%`) as DbRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(filter: 'active' | 'archived' | 'all'): HabitRecord[] {
    let where = '';
    if (filter === 'active') where = 'WHERE archived_at IS NULL';
    if (filter === 'archived') where = 'WHERE archived_at IS NOT NULL';
    const rows = this.db.prepare(`SELECT * FROM habits ${where} ORDER BY id ASC`).all() as DbRow[];
    return rows.map(fromRow);
  }

  update(
    id: number,
    fields: Partial<Pick<HabitRecord, 'name' | 'unit' | 'target' | 'cadence' | 'targetPerPeriod' | 'daysOfWeek'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
    if (fields.unit !== undefined) { sets.push('unit = ?'); values.push(fields.unit); }
    if (fields.target !== undefined) { sets.push('target = ?'); values.push(fields.target); }
    if (fields.cadence !== undefined) { sets.push('cadence = ?'); values.push(fields.cadence); }
    if (fields.targetPerPeriod !== undefined) { sets.push('target_per_period = ?'); values.push(fields.targetPerPeriod); }
    if (fields.daysOfWeek !== undefined) { sets.push('days_of_week = ?'); values.push(fields.daysOfWeek); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  setReminderScheduleId(id: number, scheduleId: number | null): void {
    this.db.prepare('UPDATE habits SET reminder_schedule_id = ? WHERE id = ?').run(scheduleId, id);
  }

  archive(id: number, at: number): void {
    this.db.prepare('UPDATE habits SET archived_at = ? WHERE id = ?').run(at, id);
  }

  unarchive(id: number): void {
    this.db.prepare('UPDATE habits SET archived_at = NULL WHERE id = ?').run(id);
  }
}
```

- [ ] **Step 4: Re-exportar de `index.ts`**

Edit `packages/storage/src/index.ts`, adicionar:

```ts
export { HabitRepo, type HabitRecord, type HabitKind, type HabitCadence } from './habit-repo';
```

- [ ] **Step 5: Rodar tests + quality gate**

```bash
pnpm test --filter @whis/storage
pnpm run quality-gate
```

Esperado: ~10 testes novos passando em `habit-repo.test.ts`. Zero regressão.

- [ ] **Step 6: Commit**

```bash
git add packages/storage/src/db.ts packages/storage/src/habit-repo.ts packages/storage/src/habit-repo.test.ts packages/storage/src/index.ts
git commit -m "feat(storage): add habits table + HabitRepo (spec 0006)"
```

---

## Phase 3: Storage — habit_logs repo

### Task 2: `HabitLogRepo` + tests

**Files:**
- Create: `packages/storage/src/habit-log-repo.ts`
- Create: `packages/storage/src/habit-log-repo.test.ts`
- Modify: `packages/storage/src/index.ts`

A migration já criou a tabela `habit_logs` no Task 1. Esta task implementa o repo.

- [ ] **Step 1: Escrever tests (TDD — vão falhar)**

Create `packages/storage/src/habit-log-repo.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase, runMigrations } from './db';
import { HabitRepo } from './habit-repo';
import { HabitLogRepo, type HabitLogRecord } from './habit-log-repo';

const baseLog = (habitId: number, overrides: Partial<Omit<HabitLogRecord, 'id'>> = {}): Omit<HabitLogRecord, 'id'> => ({
  habitId,
  value: 1,
  loggedAt: 1_700_000_000_000,
  forDate: '2026-05-18',
  createdAt: 1_700_000_000_000,
  correlationId: 'c1',
  ...overrides,
});

describe('HabitLogRepo', () => {
  let db: Db;
  let habits: HabitRepo;
  let logs: HabitLogRepo;
  let habitId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    habits = new HabitRepo(db);
    logs = new HabitLogRepo(db);
    habitId = habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10,
      cadence: 'daily', targetPerPeriod: null, daysOfWeek: null,
      reminderScheduleId: null, createdAt: 1_700_000_000_000, archivedAt: null,
    });
  });

  it('insert returns id and persists', () => {
    const id = logs.insert(baseLog(habitId));
    expect(id).toBeGreaterThan(0);
    const range = logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31');
    expect(range).toHaveLength(1);
    expect(range[0].value).toBe(1);
  });

  it('findByHabitAndDateRange returns sorted asc by for_date', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 10 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-16', value: 5 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17', value: 8 }));
    const range = logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31');
    expect(range.map((l) => l.forDate)).toEqual(['2026-05-16', '2026-05-17', '2026-05-18']);
  });

  it('findByHabitAndDateRange excludes other habits', () => {
    const other = habits.insert({
      name: 'ler', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: 1_700_000_000_000, archivedAt: null,
    });
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    logs.insert(baseLog(other, { forDate: '2026-05-18' }));
    expect(logs.findByHabitAndDateRange(habitId, '2026-05-01', '2026-05-31')).toHaveLength(1);
  });

  it('findLast returns N most recent by loggedAt desc', () => {
    logs.insert(baseLog(habitId, { loggedAt: 100, forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { loggedAt: 300, forDate: '2026-05-17' }));
    logs.insert(baseLog(habitId, { loggedAt: 200, forDate: '2026-05-16' }));
    const last2 = logs.findLast(habitId, 2);
    expect(last2.map((l) => l.loggedAt)).toEqual([300, 200]);
  });

  it('deleteLast within window deletes most recent log only', () => {
    const id1 = logs.insert(baseLog(habitId, { loggedAt: 100 }));
    const id2 = logs.insert(baseLog(habitId, { loggedAt: 200 }));
    const deleted = logs.deleteLast(habitId, 300, 1000); // now=300, within 1s
    expect(deleted?.id).toBe(id2);
    const remaining = logs.findLast(habitId, 5);
    expect(remaining.map((l) => l.id)).toEqual([id1]);
  });

  it('deleteLast outside window returns null and deletes nothing', () => {
    logs.insert(baseLog(habitId, { loggedAt: 100 }));
    const deleted = logs.deleteLast(habitId, 10_000, 1000); // now=10s, window=1s → log é 9.9s antigo
    expect(deleted).toBeNull();
    expect(logs.findLast(habitId, 5)).toHaveLength(1);
  });

  it('countByHabitForDate sums values for a date', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 30 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-18', value: 15 }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17', value: 99 }));
    expect(logs.countByHabitForDate(habitId, '2026-05-18')).toBe(45);
    expect(logs.countByHabitForDate(habitId, '2026-05-19')).toBe(0);
  });

  it('streakDays counts consecutive days back from asOf for daily cadence', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-16' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(4);
  });

  it('streakDays breaks on gap', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-15' }));
    logs.insert(baseLog(habitId, { forDate: '2026-05-17' })); // gap 16/05
    logs.insert(baseLog(habitId, { forDate: '2026-05-18' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(2);
  });

  it('streakDays returns 0 if asOf has no log', () => {
    logs.insert(baseLog(habitId, { forDate: '2026-05-16' }));
    expect(logs.streakDays(habitId, '2026-05-18')).toBe(0);
  });

  it('FK ON DELETE CASCADE removes logs when habit is deleted', () => {
    logs.insert(baseLog(habitId));
    db.prepare('DELETE FROM habits WHERE id = ?').run(habitId);
    expect(logs.findLast(habitId, 5)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Implementar `habit-log-repo.ts`**

Create `packages/storage/src/habit-log-repo.ts`:

```ts
import type { Db } from './db';

export interface HabitLogRecord {
  id: number;
  habitId: number;
  value: number;
  loggedAt: number;
  /** YYYY-MM-DD — data lógica do hábito (timezone aplicada antes de inserir) */
  forDate: string;
  createdAt: number;
  correlationId: string;
}

type DbRow = {
  id: number;
  habit_id: number;
  value: number;
  logged_at: number;
  for_date: string;
  created_at: number;
  correlation_id: string;
};

const fromRow = (r: DbRow): HabitLogRecord => ({
  id: r.id,
  habitId: r.habit_id,
  value: r.value,
  loggedAt: r.logged_at,
  forDate: r.for_date,
  createdAt: r.created_at,
  correlationId: r.correlation_id,
});

export class HabitLogRepo {
  constructor(private readonly db: Db) {}

  insert(rec: Omit<HabitLogRecord, 'id'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO habit_logs (habit_id, value, logged_at, for_date, created_at, correlation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      rec.habitId, rec.value, rec.loggedAt, rec.forDate, rec.createdAt, rec.correlationId,
    );
    return info.lastInsertRowid as number;
  }

  findByHabitAndDateRange(habitId: number, fromDate: string, toDate: string): HabitLogRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM habit_logs
                WHERE habit_id = ? AND for_date BETWEEN ? AND ?
                ORDER BY for_date ASC, logged_at ASC`)
      .all(habitId, fromDate, toDate) as DbRow[];
    return rows.map(fromRow);
  }

  findLast(habitId: number, n: number): HabitLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM habit_logs WHERE habit_id = ? ORDER BY logged_at DESC LIMIT ?')
      .all(habitId, n) as DbRow[];
    return rows.map(fromRow);
  }

  /**
   * Deletes the most recent log of habit if it was created within `windowMs` of `now`.
   * Returns the deleted record or null if no log exists or it's outside the window.
   */
  deleteLast(habitId: number, now: number, windowMs: number): HabitLogRecord | null {
    const [last] = this.findLast(habitId, 1);
    if (!last) return null;
    if (now - last.loggedAt > windowMs) return null;
    this.db.prepare('DELETE FROM habit_logs WHERE id = ?').run(last.id);
    return last;
  }

  countByHabitForDate(habitId: number, date: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(value), 0) AS total FROM habit_logs WHERE habit_id = ? AND for_date = ?')
      .get(habitId, date) as { total: number };
    return row.total;
  }

  /**
   * For daily cadence: count consecutive days with at least one log going back from asOf.
   * For weekly/custom_days, this primitive isn't meaningful by itself — stats.ts wraps it.
   */
  streakDays(habitId: number, asOfDate: string): number {
    const rows = this.db
      .prepare('SELECT DISTINCT for_date FROM habit_logs WHERE habit_id = ? AND for_date <= ? ORDER BY for_date DESC')
      .all(habitId, asOfDate) as Array<{ for_date: string }>;
    if (rows.length === 0) return 0;
    if (rows[0].for_date !== asOfDate) return 0;

    let count = 0;
    let cursor = asOfDate;
    for (const r of rows) {
      if (r.for_date !== cursor) break;
      count++;
      const d = new Date(`${cursor}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      cursor = d.toISOString().slice(0, 10);
    }
    return count;
  }
}
```

- [ ] **Step 3: Re-exportar de `index.ts`**

Adicionar em `packages/storage/src/index.ts`:

```ts
export { HabitLogRepo, type HabitLogRecord } from './habit-log-repo';
```

- [ ] **Step 4: Rodar tests + quality gate**

```bash
pnpm test --filter @whis/storage
pnpm run quality-gate
```

- [ ] **Step 5: Commit**

```bash
git add packages/storage/src/habit-log-repo.ts packages/storage/src/habit-log-repo.test.ts packages/storage/src/index.ts
git commit -m "feat(storage): add HabitLogRepo with streak/range/undo (spec 0006)"
```

---

## Phase 4: Stats module (puro)

### Task 3: `apps/worker/src/skills/habits/stats.ts` + tests

**Files:**
- Create: `apps/worker/src/skills/habits/stats.ts`
- Create: `apps/worker/src/skills/habits/stats.test.ts`

- [ ] **Step 1: Escrever tests primeiro (TDD)**

Create `apps/worker/src/skills/habits/stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HabitRecord, HabitLogRecord } from '@whis/storage';
import {
  aggregatePeriod,
  computeStreak,
  expectsHabitOnDate,
  isPendingForDate,
} from './stats';

const habit = (overrides: Partial<HabitRecord> = {}): HabitRecord => ({
  id: 1, name: 'h', kind: 'binary', unit: null, target: null,
  cadence: 'daily', targetPerPeriod: null, daysOfWeek: null,
  reminderScheduleId: null, createdAt: 0, archivedAt: null,
  ...overrides,
});

const log = (forDate: string, value = 1, habitId = 1): HabitLogRecord => ({
  id: 1, habitId, value, loggedAt: 0, forDate, createdAt: 0, correlationId: 'c',
});

describe('expectsHabitOnDate', () => {
  it('daily: true on any day', () => {
    expect(expectsHabitOnDate(habit({ cadence: 'daily' }), '2026-05-18')).toBe(true);
  });

  it('weekly: true on any day (target_per_period drives status, not date)', () => {
    expect(expectsHabitOnDate(habit({ cadence: 'weekly', targetPerPeriod: 3 }), '2026-05-18')).toBe(true);
  });

  it('custom_days: true only on listed days', () => {
    // 2026-05-18 é segunda-feira (dow=1)
    expect(expectsHabitOnDate(habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' }), '2026-05-18')).toBe(true);
    expect(expectsHabitOnDate(habit({ cadence: 'custom_days', daysOfWeek: '2,4,6' }), '2026-05-18')).toBe(false);
  });
});

describe('isPendingForDate', () => {
  it('binary daily: pending if no log; done if at least one', () => {
    const h = habit({ kind: 'binary', cadence: 'daily' });
    expect(isPendingForDate(h, [], '2026-05-18')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18')], '2026-05-18')).toBe(false);
  });

  it('quantity daily: pending if sum < target', () => {
    const h = habit({ kind: 'quantity', cadence: 'daily', target: 30 });
    expect(isPendingForDate(h, [log('2026-05-18', 10), log('2026-05-18', 15)], '2026-05-18')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18', 30)], '2026-05-18')).toBe(false);
    expect(isPendingForDate(h, [log('2026-05-18', 100)], '2026-05-18')).toBe(false);
  });

  it('duration daily: same as quantity', () => {
    const h = habit({ kind: 'duration', cadence: 'daily', target: 10 });
    expect(isPendingForDate(h, [log('2026-05-18', 8)], '2026-05-18')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18', 10)], '2026-05-18')).toBe(false);
  });

  it('weekly target: pending if count this week < targetPerPeriod', () => {
    const h = habit({ kind: 'binary', cadence: 'weekly', targetPerPeriod: 3 });
    // 2026-05-18 = Monday. Semana = 2026-05-18..2026-05-24.
    expect(isPendingForDate(h, [log('2026-05-18'), log('2026-05-20')], '2026-05-21')).toBe(true);
    expect(isPendingForDate(h, [log('2026-05-18'), log('2026-05-19'), log('2026-05-20')], '2026-05-21')).toBe(false);
  });

  it('custom_days: not pending on non-target day', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '2,4,6' }); // ter/qui/sab
    expect(isPendingForDate(h, [], '2026-05-18')).toBe(false); // monday (1)
  });
});

describe('computeStreak', () => {
  it('daily: consecutive days', () => {
    const h = habit({ cadence: 'daily' });
    const logs = [log('2026-05-16'), log('2026-05-17'), log('2026-05-18')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(3);
  });

  it('daily: 0 if today missing', () => {
    const h = habit({ cadence: 'daily' });
    const logs = [log('2026-05-16'), log('2026-05-17')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(0);
  });

  it('custom_days: skips off-days from streak count', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' }); // seg/qua/sex
    // logs on Mon 11, Wed 13, Fri 15, Mon 18. AsOf=Mon 18.
    const logs = [log('2026-05-11'), log('2026-05-13'), log('2026-05-15'), log('2026-05-18')];
    expect(computeStreak(h, logs, '2026-05-18')).toBe(4);
  });

  it('weekly target: streak counts weeks where target was met', () => {
    const h = habit({ cadence: 'weekly', targetPerPeriod: 3 });
    // Semana 18/05 (seg)..24/05: 3 logs → done
    // Semana 11/05..17/05: 3 logs → done
    // Semana 04/05..10/05: 2 logs → broken
    const logs = [
      log('2026-05-04'), log('2026-05-05'),
      log('2026-05-12'), log('2026-05-13'), log('2026-05-14'),
      log('2026-05-18'), log('2026-05-19'), log('2026-05-20'),
    ];
    expect(computeStreak(h, logs, '2026-05-20')).toBe(2);
  });
});

describe('aggregatePeriod', () => {
  it('binary: count of distinct days', () => {
    const h = habit({ kind: 'binary' });
    const logs = [log('2026-05-16'), log('2026-05-17'), log('2026-05-17')];
    expect(aggregatePeriod(h, logs)).toEqual({ kind: 'binary', daysDone: 2, total: 2 });
  });

  it('quantity: sum and avg-per-day', () => {
    const h = habit({ kind: 'quantity' });
    const logs = [log('2026-05-16', 10), log('2026-05-17', 20)];
    expect(aggregatePeriod(h, logs)).toEqual({ kind: 'quantity', sum: 30, daysWithLog: 2, avgPerDay: 15 });
  });

  it('duration: sum and avg-per-day', () => {
    const h = habit({ kind: 'duration' });
    const logs = [log('2026-05-16', 30), log('2026-05-17', 45)];
    expect(aggregatePeriod(h, logs)).toEqual({ kind: 'duration', sum: 75, daysWithLog: 2, avgPerDay: 37.5 });
  });

  it('empty logs returns zero values', () => {
    expect(aggregatePeriod(habit({ kind: 'binary' }), [])).toEqual({ kind: 'binary', daysDone: 0, total: 0 });
  });
});
```

- [ ] **Step 2: Implementar `stats.ts`**

Create `apps/worker/src/skills/habits/stats.ts`:

```ts
import type { HabitLogRecord, HabitRecord } from '@whis/storage';

/** ISO weekday: 1=Mon..7=Sun */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const wd = d.getUTCDay(); // 0=Sun..6=Sat
  return wd === 0 ? 7 : wd;
}

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function startOfIsoWeek(date: string): string {
  const wd = isoWeekday(date);
  return addDays(date, -(wd - 1));
}

function endOfIsoWeek(date: string): string {
  return addDays(startOfIsoWeek(date), 6);
}

export function expectsHabitOnDate(habit: HabitRecord, date: string): boolean {
  if (habit.cadence === 'daily') return true;
  if (habit.cadence === 'weekly') return true;
  // custom_days
  if (!habit.daysOfWeek) return false;
  const expected = habit.daysOfWeek.split(',').map((s) => Number.parseInt(s, 10));
  return expected.includes(isoWeekday(date));
}

function sumForDate(logs: HabitLogRecord[], date: string): number {
  return logs.filter((l) => l.forDate === date).reduce((acc, l) => acc + l.value, 0);
}

function countDaysInRange(logs: HabitLogRecord[], from: string, to: string): number {
  const dates = new Set(logs.filter((l) => l.forDate >= from && l.forDate <= to).map((l) => l.forDate));
  return dates.size;
}

export function isPendingForDate(habit: HabitRecord, logs: HabitLogRecord[], date: string): boolean {
  if (!expectsHabitOnDate(habit, date)) return false;

  if (habit.cadence === 'weekly') {
    const target = habit.targetPerPeriod ?? 1;
    const from = startOfIsoWeek(date);
    const to = endOfIsoWeek(date);
    return countDaysInRange(logs, from, to) < target;
  }

  // daily / custom_days
  const sum = sumForDate(logs, date);
  if (habit.kind === 'binary') return sum < 1;
  const target = habit.target ?? 0;
  return sum < target;
}

export function computeStreak(habit: HabitRecord, logs: HabitLogRecord[], asOf: string): number {
  if (habit.cadence === 'weekly') {
    // count consecutive weeks back where targetPerPeriod was met (using distinct days as proxy)
    let count = 0;
    let weekStart = startOfIsoWeek(asOf);
    let weekEnd = endOfIsoWeek(asOf);
    const target = habit.targetPerPeriod ?? 1;
    // Streak counts the current week only if it's already met
    while (true) {
      const days = countDaysInRange(logs, weekStart, weekEnd);
      if (days < target) break;
      count++;
      weekStart = addDays(weekStart, -7);
      weekEnd = addDays(weekEnd, -7);
    }
    return count;
  }

  // daily / custom_days — count consecutive expected days with at least one log, back from asOf
  let count = 0;
  let cursor = asOf;
  // Guardrail pra não rodar pra sempre se logs vazios
  for (let i = 0; i < 365 * 5; i++) {
    if (expectsHabitOnDate(habit, cursor)) {
      const sum = sumForDate(logs, cursor);
      const met = habit.kind === 'binary' ? sum >= 1 : sum >= (habit.target ?? 0);
      if (!met) break;
      count++;
    }
    cursor = addDays(cursor, -1);
  }
  return count;
}

export type PeriodAgg =
  | { kind: 'binary'; daysDone: number; total: number }
  | { kind: 'quantity'; sum: number; daysWithLog: number; avgPerDay: number }
  | { kind: 'duration'; sum: number; daysWithLog: number; avgPerDay: number };

export function aggregatePeriod(habit: HabitRecord, logs: HabitLogRecord[]): PeriodAgg {
  if (habit.kind === 'binary') {
    const days = new Set(logs.map((l) => l.forDate));
    return { kind: 'binary', daysDone: days.size, total: logs.length };
  }
  const sum = logs.reduce((acc, l) => acc + l.value, 0);
  const days = new Set(logs.map((l) => l.forDate));
  const daysWithLog = days.size;
  const avgPerDay = daysWithLog === 0 ? 0 : sum / daysWithLog;
  return { kind: habit.kind, sum, daysWithLog, avgPerDay };
}
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm test --filter worker stats
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/stats.ts apps/worker/src/skills/habits/stats.test.ts
git commit -m "feat(habits): pure stats module — streak, isPending, aggregatePeriod (spec 0006)"
```

---

## Phase 5: Dashboard renderer (puro)

### Task 4: `dashboard.ts` + tests

**Files:**
- Create: `apps/worker/src/skills/habits/dashboard.ts`
- Create: `apps/worker/src/skills/habits/dashboard.test.ts`

- [ ] **Step 1: Escrever tests primeiro**

Create `apps/worker/src/skills/habits/dashboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { HabitLogRecord, HabitRecord } from '@whis/storage';
import { renderDashboard } from './dashboard';

const habit = (overrides: Partial<HabitRecord> = {}): HabitRecord => ({
  id: 1, name: 'meditar', kind: 'binary', unit: null, target: null,
  cadence: 'daily', targetPerPeriod: null, daysOfWeek: null,
  reminderScheduleId: null, createdAt: 0, archivedAt: null,
  ...overrides,
});

const log = (habitId: number, forDate: string, value = 1): HabitLogRecord => ({
  id: 1, habitId, value, loggedAt: 0, forDate, createdAt: 0, correlationId: 'c',
});

describe('renderDashboard', () => {
  it('renders empty state when no habits', () => {
    const out = renderDashboard({ habits: [], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('# Habits Dashboard');
    expect(out).toContain('Nenhum hábito ativo');
  });

  it('renders single habit with heatmap of 30 days', () => {
    const h = habit({ id: 1, name: 'meditar' });
    const logs = [log(1, '2026-05-18'), log(1, '2026-05-17')];
    const out = renderDashboard({ habits: [h], logs, asOf: '2026-05-18' });
    expect(out).toContain('## meditar');
    expect(out).toContain('Streak: 2');
    // 30 dias, last 2 done
    expect(out).toMatch(/✅/);
    expect(out).toMatch(/⬜/);
  });

  it('binary done is ✅, pending is ⬜', () => {
    const h = habit({ kind: 'binary', cadence: 'daily' });
    const out = renderDashboard({ habits: [h], logs: [log(1, '2026-05-18')], asOf: '2026-05-18' });
    const heatmapLine = out.split('\n').find((l) => l.includes('✅') || l.includes('⬜'));
    expect(heatmapLine).toBeDefined();
  });

  it('quantity partial is 🟧, full is ✅', () => {
    const h = habit({ kind: 'quantity', cadence: 'daily', target: 30 });
    const logs = [log(1, '2026-05-18', 15), log(1, '2026-05-17', 30)];
    const out = renderDashboard({ habits: [h], logs, asOf: '2026-05-18' });
    expect(out).toContain('🟧');
    expect(out).toContain('✅');
  });

  it('custom_days off-day shows ▫️', () => {
    const h = habit({ cadence: 'custom_days', daysOfWeek: '1,3,5' }); // mon/wed/fri
    const out = renderDashboard({ habits: [h], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('▫️');
  });

  it('multiple habits each get a section', () => {
    const a = habit({ id: 1, name: 'meditar' });
    const b = habit({ id: 2, name: 'malhação', cadence: 'weekly', targetPerPeriod: 3 });
    const out = renderDashboard({ habits: [a, b], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('## meditar');
    expect(out).toContain('## malhação');
  });

  it('includes asOf in header', () => {
    const out = renderDashboard({ habits: [], logs: [], asOf: '2026-05-18' });
    expect(out).toContain('2026-05-18');
  });

  it('archived habits are excluded', () => {
    const a = habit({ id: 1, name: 'old', archivedAt: 999 });
    const out = renderDashboard({ habits: [a], logs: [], asOf: '2026-05-18' });
    expect(out).not.toContain('## old');
  });
});
```

- [ ] **Step 2: Implementar `dashboard.ts`**

Create `apps/worker/src/skills/habits/dashboard.ts`:

```ts
import type { HabitLogRecord, HabitRecord } from '@whis/storage';
import { aggregatePeriod, computeStreak, expectsHabitOnDate } from './stats';

const HEATMAP_DAYS = 30;

function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function cellFor(habit: HabitRecord, logs: HabitLogRecord[], date: string): string {
  if (!expectsHabitOnDate(habit, date)) return '▫️';
  const sum = logs.filter((l) => l.forDate === date).reduce((acc, l) => acc + l.value, 0);
  if (habit.kind === 'binary') return sum >= 1 ? '✅' : '⬜';
  const target = habit.target ?? 0;
  if (sum >= target) return '✅';
  if (sum > 0) return '🟧';
  return '⬜';
}

function renderHeatmap(habit: HabitRecord, logs: HabitLogRecord[], asOf: string): string {
  const cells: string[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    cells.push(cellFor(habit, logs, addDays(asOf, -i)));
  }
  return cells.join(' ');
}

function renderHabitSection(habit: HabitRecord, allLogs: HabitLogRecord[], asOf: string): string {
  const habitLogs = allLogs.filter((l) => l.habitId === habit.id);
  const streak = computeStreak(habit, habitLogs, asOf);
  const periodLogs = habitLogs.filter((l) => l.forDate > addDays(asOf, -HEATMAP_DAYS));
  const agg = aggregatePeriod(habit, periodLogs);

  const lines: string[] = [];
  lines.push(`## ${habit.name}`);
  const cadenceDesc =
    habit.cadence === 'daily' ? 'daily' :
    habit.cadence === 'weekly' ? `${habit.targetPerPeriod ?? 1}x/semana` :
    `dias ${habit.daysOfWeek ?? ''}`;
  const targetDesc = habit.kind === 'binary' ? '' : ` · target ${habit.target}${habit.unit ? habit.unit : ''}`;
  lines.push(`_${habit.kind} · ${cadenceDesc}${targetDesc}_`);
  lines.push('');
  lines.push(`**Streak:** ${streak}`);
  if (agg.kind === 'binary') {
    lines.push(`**30d:** ${agg.daysDone} dias`);
  } else {
    lines.push(`**30d:** total ${Math.round(agg.sum * 10) / 10}${habit.unit ?? ''} · média ${Math.round(agg.avgPerDay * 10) / 10}${habit.unit ?? ''}/dia`);
  }
  lines.push('');
  lines.push('```');
  lines.push(renderHeatmap(habit, habitLogs, asOf));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

export interface RenderDashboardArgs {
  habits: HabitRecord[];
  logs: HabitLogRecord[];
  asOf: string;
}

export function renderDashboard({ habits, logs, asOf }: RenderDashboardArgs): string {
  const active = habits.filter((h) => h.archivedAt === null);
  const header = `# Habits Dashboard\n\n_atualizado: ${asOf}_\n\n`;
  if (active.length === 0) {
    return `${header}Nenhum hábito ativo. Conversa com o Whis pra criar.\n`;
  }
  const legend = '_Legenda: ✅ feito · 🟧 parcial · ⬜ pendente · ▫️ fora do dia_\n\n';
  const sections = active.map((h) => renderHabitSection(h, logs, asOf)).join('\n');
  return `${header}${legend}${sections}`;
}
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm test --filter worker dashboard
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/dashboard.ts apps/worker/src/skills/habits/dashboard.test.ts
git commit -m "feat(habits): markdown dashboard renderer with 30d heatmap (spec 0006)"
```

---

## Phase 6: MCP tools — reads

### Task 5: Tools `habit_list`, `habit_status`, `habit_today_pending`, `habit_today_status`

**Files:**
- Create: `apps/worker/src/skills/habits/tools.ts` (parte 1)
- Create: `apps/worker/src/skills/habits/tools.test.ts` (parte 1)

Esta task escreve o esqueleto de `tools.ts` com `buildHabitToolHandlers(deps)` e implementa só as 4 tools de leitura. Writes vêm nas Tasks 6 e 7. Factory `createHabitsMcpServer` vem na Task 8.

- [ ] **Step 1: Escrever tests das reads (TDD)**

Create `apps/worker/src/skills/habits/tools.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, HabitLogRepo, HabitRepo, openDatabase, runMigrations } from '@whis/storage';
import { buildHabitToolHandlers, type HabitToolHandlers } from './tools';

const TZ = 'America/Sao_Paulo';

describe('habit tools — reads', () => {
  let db: Db;
  let habits: HabitRepo;
  let logs: HabitLogRepo;
  let h: HabitToolHandlers;
  let clockMs = Date.UTC(2026, 4, 18, 12, 0, 0); // 2026-05-18 12:00 UTC

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    habits = new HabitRepo(db);
    logs = new HabitLogRepo(db);
    h = buildHabitToolHandlers({
      habits, logs,
      clock: () => clockMs,
      timezone: TZ,
      dashboardPath: '/tmp/test-dashboard.md',
    });
  });

  it('habit_list returns empty when no habits', async () => {
    const r = await h.habit_list({});
    expect(r.entries).toEqual([]);
  });

  it('habit_list returns active habits with shape', async () => {
    habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10,
      cadence: 'daily', targetPerPeriod: null, daysOfWeek: null,
      reminderScheduleId: null, createdAt: clockMs, archivedAt: null,
    });
    const r = await h.habit_list({});
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ name: 'meditar', kind: 'duration', target: 10 });
  });

  it('habit_list filter=archived excludes active', async () => {
    const id = habits.insert({
      name: 'old', kind: 'binary', unit: null, target: null,
      cadence: 'daily', targetPerPeriod: null, daysOfWeek: null,
      reminderScheduleId: null, createdAt: clockMs, archivedAt: null,
    });
    habits.archive(id, clockMs);
    expect((await h.habit_list({ filter: 'active' })).entries).toHaveLength(0);
    expect((await h.habit_list({ filter: 'archived' })).entries).toHaveLength(1);
  });

  it('habit_status returns done/pending/off per habit for today', async () => {
    const m = habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    habits.insert({
      name: 'ler', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    logs.insert({
      habitId: m, value: 10, loggedAt: clockMs, forDate: '2026-05-18',
      createdAt: clockMs, correlationId: 'c',
    });
    const r = await h.habit_status({});
    expect(r.today).toContainEqual(expect.objectContaining({ name: 'meditar', status: 'done' }));
    expect(r.today).toContainEqual(expect.objectContaining({ name: 'ler', status: 'pending' }));
  });

  it('habit_today_pending lists only pending habits', async () => {
    habits.insert({
      name: 'ler', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    const r = await h.habit_today_pending({});
    expect(r.pending.map((p) => p.name)).toEqual(['ler']);
  });

  it('habit_today_status returns single-habit done/pending', async () => {
    const id = habits.insert({
      name: 'exercitar', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    expect((await h.habit_today_status({ habitId: id })).status).toBe('pending');
    logs.insert({
      habitId: id, value: 1, loggedAt: clockMs, forDate: '2026-05-18',
      createdAt: clockMs, correlationId: 'c',
    });
    expect((await h.habit_today_status({ habitId: id })).status).toBe('done');
  });

  it('habit_today_status throws on unknown habit id', async () => {
    await expect(h.habit_today_status({ habitId: 9999 })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Implementar tools.ts (somente reads e infra compartilhada)**

Create `apps/worker/src/skills/habits/tools.ts`:

```ts
import type { HabitLogRepo, HabitRecord, HabitRepo } from '@whis/storage';
import { isPendingForDate, computeStreak } from './stats';

export interface HabitToolDeps {
  habits: HabitRepo;
  logs: HabitLogRepo;
  /** Test seam */
  clock?: () => number;
  timezone: string;
  /** Absolute path where habit_render_dashboard writes markdown */
  dashboardPath: string;
}

interface HabitListed {
  id: number;
  name: string;
  kind: HabitRecord['kind'];
  unit: string | null;
  target: number | null;
  cadence: HabitRecord['cadence'];
  targetPerPeriod: number | null;
  daysOfWeek: string | null;
  reminderScheduleId: number | null;
  archived: boolean;
}

interface TodayEntry {
  id: number;
  name: string;
  status: 'done' | 'pending' | 'off';
  streak: number;
}

export interface HabitToolHandlers {
  habit_list: (input: { filter?: 'active' | 'archived' | 'all' }) => Promise<{ entries: HabitListed[] }>;
  habit_status: (input: {}) => Promise<{ today: TodayEntry[]; date: string }>;
  habit_today_pending: (input: {}) => Promise<{ pending: { id: number; name: string }[]; date: string }>;
  habit_today_status: (input: { habitId: number }) => Promise<{ status: 'done' | 'pending' | 'off'; name: string; streak: number; date: string }>;
  // Writes vêm nas Tasks 6 e 7
}

/**
 * Returns the local YYYY-MM-DD for a given UTC ms and IANA timezone.
 * Uses Intl.DateTimeFormat for correctness.
 */
function localDateString(ms: number, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date(ms));
}

export function buildHabitToolHandlers(deps: HabitToolDeps): HabitToolHandlers {
  const clock = deps.clock ?? (() => Date.now());
  const today = () => localDateString(clock(), deps.timezone);

  return {
    async habit_list({ filter = 'active' }) {
      const list = deps.habits.list(filter);
      return {
        entries: list.map((h) => ({
          id: h.id,
          name: h.name,
          kind: h.kind,
          unit: h.unit,
          target: h.target,
          cadence: h.cadence,
          targetPerPeriod: h.targetPerPeriod,
          daysOfWeek: h.daysOfWeek,
          reminderScheduleId: h.reminderScheduleId,
          archived: h.archivedAt !== null,
        })),
      };
    },

    async habit_status(_input) {
      const date = today();
      const active = deps.habits.list('active');
      const items: TodayEntry[] = active.map((h) => {
        const logs = deps.logs.findByHabitAndDateRange(h.id, '0000-01-01', date);
        const pending = isPendingForDate(h, logs, date);
        const todays = logs.filter((l) => l.forDate === date);
        const status: TodayEntry['status'] =
          todays.length === 0 && !pending ? 'off' :
          pending ? 'pending' : 'done';
        return { id: h.id, name: h.name, status, streak: computeStreak(h, logs, date) };
      });
      return { today: items, date };
    },

    async habit_today_pending(_input) {
      const date = today();
      const active = deps.habits.list('active');
      const pending = active
        .filter((h) => {
          const logs = deps.logs.findByHabitAndDateRange(h.id, '0000-01-01', date);
          return isPendingForDate(h, logs, date);
        })
        .map((h) => ({ id: h.id, name: h.name }));
      return { pending, date };
    },

    async habit_today_status({ habitId }) {
      const habit = deps.habits.findById(habitId);
      if (!habit) throw new Error(`habit not found: ${habitId}`);
      const date = today();
      const logs = deps.logs.findByHabitAndDateRange(habit.id, '0000-01-01', date);
      const pending = isPendingForDate(habit, logs, date);
      const todays = logs.filter((l) => l.forDate === date);
      const status: 'done' | 'pending' | 'off' =
        todays.length === 0 && !pending ? 'off' :
        pending ? 'pending' : 'done';
      return { status, name: habit.name, streak: computeStreak(habit, logs, date), date };
    },
  };
}
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm test --filter worker tools
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/tools.ts apps/worker/src/skills/habits/tools.test.ts
git commit -m "feat(habits): MCP read tools — list, status, today_pending, today_status (spec 0006)"
```

---

## Phase 7: MCP tools — writes leves

### Task 6: Tools `habit_log`, `habit_log_undo`, `habit_render_dashboard`

**Files:**
- Modify: `apps/worker/src/skills/habits/tools.ts`
- Modify: `apps/worker/src/skills/habits/tools.test.ts`

- [ ] **Step 1: Adicionar tests pros novos handlers**

Append em `tools.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('habit tools — writes leves', () => {
  let db: Db;
  let habits: HabitRepo;
  let logs: HabitLogRepo;
  let h: HabitToolHandlers;
  let clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);
  let tmpDir: string;
  let dashboardPath: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    habits = new HabitRepo(db);
    logs = new HabitLogRepo(db);
    tmpDir = mkdtempSync(join(tmpdir(), 'whis-habit-'));
    dashboardPath = join(tmpDir, 'habits', 'dashboard.md');
    h = buildHabitToolHandlers({
      habits, logs, clock: () => clockMs,
      timezone: 'America/Sao_Paulo', dashboardPath,
    });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('habit_log inserts row and returns streak', async () => {
    const id = habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    const r = await h.habit_log({ habitId: id, value: 12, correlationId: 'c1' });
    expect(r.streak).toBe(1);
    expect(r.forDate).toBe('2026-05-18');
    expect(logs.findLast(id, 5)).toHaveLength(1);
  });

  it('habit_log accepts retroactive at=YYYY-MM-DD', async () => {
    const id = habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    const r = await h.habit_log({ habitId: id, value: 8, at: '2026-05-17', correlationId: 'c1' });
    expect(r.forDate).toBe('2026-05-17');
  });

  it('habit_log throws on unknown habit', async () => {
    await expect(h.habit_log({ habitId: 9999, value: 1, correlationId: 'c' })).rejects.toThrow(/not found/);
  });

  it('habit_log throws on archived habit', async () => {
    const id = habits.insert({
      name: 'x', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    habits.archive(id, clockMs);
    await expect(h.habit_log({ habitId: id, value: 1, correlationId: 'c' })).rejects.toThrow(/archived/);
  });

  it('habit_log_undo removes last log within window', async () => {
    const id = habits.insert({
      name: 'x', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    await h.habit_log({ habitId: id, value: 1, correlationId: 'c' });
    const r = await h.habit_log_undo({ habitId: id });
    expect(r.undone).toBe(true);
    expect(logs.findLast(id, 5)).toHaveLength(0);
  });

  it('habit_log_undo fails outside 5min window', async () => {
    const id = habits.insert({
      name: 'x', kind: 'binary', unit: null, target: null, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    await h.habit_log({ habitId: id, value: 1, correlationId: 'c' });
    clockMs += 6 * 60 * 1000; // +6min
    const r = await h.habit_log_undo({ habitId: id });
    expect(r.undone).toBe(false);
  });

  it('habit_render_dashboard writes markdown to dashboardPath', async () => {
    habits.insert({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10, cadence: 'daily',
      targetPerPeriod: null, daysOfWeek: null, reminderScheduleId: null,
      createdAt: clockMs, archivedAt: null,
    });
    const r = await h.habit_render_dashboard({});
    expect(r.path).toBe(dashboardPath);
    expect(r.sizeBytes).toBeGreaterThan(0);
    const content = readFileSync(dashboardPath, 'utf8');
    expect(content).toContain('## meditar');
  });

  it('habit_render_dashboard creates parent dir if missing', async () => {
    const r = await h.habit_render_dashboard({});
    expect(r.path).toBe(dashboardPath);
  });
});
```

- [ ] **Step 2: Adicionar imports e handlers**

Edit `tools.ts`:

```ts
// Add at top:
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderDashboard } from './dashboard';

// Add to HabitToolHandlers interface:
habit_log: (input: { habitId: number; value?: number; at?: string; correlationId: string }) => Promise<{ id: number; forDate: string; streak: number }>;
habit_log_undo: (input: { habitId: number }) => Promise<{ undone: boolean; deletedLog?: { id: number; value: number; forDate: string } }>;
habit_render_dashboard: (input: {}) => Promise<{ path: string; sizeBytes: number }>;
```

E nos handlers:

```ts
const UNDO_WINDOW_MS = 5 * 60 * 1000;

async habit_log({ habitId, value, at, correlationId }) {
  const habit = deps.habits.findById(habitId);
  if (!habit) throw new Error(`habit not found: ${habitId}`);
  if (habit.archivedAt !== null) throw new Error(`habit is archived: ${habit.name}`);
  const v = value ?? 1; // binary defaults to 1
  const now = clock();
  const forDate = at ?? localDateString(now, deps.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forDate)) {
    throw new Error(`invalid date format (expected YYYY-MM-DD): ${forDate}`);
  }
  const id = deps.logs.insert({
    habitId: habit.id, value: v, loggedAt: now, forDate,
    createdAt: now, correlationId,
  });
  const allLogs = deps.logs.findByHabitAndDateRange(habit.id, '0000-01-01', localDateString(now, deps.timezone));
  return { id, forDate, streak: computeStreak(habit, allLogs, localDateString(now, deps.timezone)) };
},

async habit_log_undo({ habitId }) {
  const deleted = deps.logs.deleteLast(habitId, clock(), UNDO_WINDOW_MS);
  if (!deleted) return { undone: false };
  return {
    undone: true,
    deletedLog: { id: deleted.id, value: deleted.value, forDate: deleted.forDate },
  };
},

async habit_render_dashboard(_input) {
  const habits = deps.habits.list('active');
  const today = localDateString(clock(), deps.timezone);
  // Carrega últimos 30 dias de logs por hábito
  const since = (() => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  })();
  const allLogs = habits.flatMap((h) => deps.logs.findByHabitAndDateRange(h.id, since, today));
  const md = renderDashboard({ habits, logs: allLogs, asOf: today });
  mkdirSync(dirname(deps.dashboardPath), { recursive: true });
  writeFileSync(deps.dashboardPath, md, 'utf8');
  return { path: deps.dashboardPath, sizeBytes: Buffer.byteLength(md, 'utf8') };
},
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm test --filter worker tools
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/tools.ts apps/worker/src/skills/habits/tools.test.ts
git commit -m "feat(habits): MCP write tools — log, log_undo, render_dashboard (spec 0006)"
```

---

## Phase 8: MCP tools — writes destrutivos

### Task 7: Tools `habit_create`, `habit_edit`, `habit_archive`, `habit_unarchive`

**Files:**
- Modify: `apps/worker/src/skills/habits/tools.ts`
- Modify: `apps/worker/src/skills/habits/tools.test.ts`

- [ ] **Step 1: Tests**

Append em `tools.test.ts`:

```ts
describe('habit tools — writes destrutivos', () => {
  let db: Db;
  let habits: HabitRepo;
  let logs: HabitLogRepo;
  let h: HabitToolHandlers;
  let clockMs = Date.UTC(2026, 4, 18, 12, 0, 0);

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    habits = new HabitRepo(db);
    logs = new HabitLogRepo(db);
    h = buildHabitToolHandlers({
      habits, logs, clock: () => clockMs,
      timezone: 'America/Sao_Paulo', dashboardPath: '/tmp/x.md',
    });
  });

  it('habit_create binary daily', async () => {
    const r = await h.habit_create({
      name: 'malhação', kind: 'binary', cadence: 'daily',
      correlationId: 'c1',
    });
    expect(r.id).toBeGreaterThan(0);
    expect(habits.findById(r.id)?.kind).toBe('binary');
  });

  it('habit_create quantity with unit/target', async () => {
    const r = await h.habit_create({
      name: 'água', kind: 'quantity', cadence: 'daily',
      unit: 'ml', target: 2000, correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.target).toBe(2000);
    expect(habits.findById(r.id)?.unit).toBe('ml');
  });

  it('habit_create weekly with targetPerPeriod', async () => {
    const r = await h.habit_create({
      name: 'malhação', kind: 'binary', cadence: 'weekly',
      targetPerPeriod: 3, correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.targetPerPeriod).toBe(3);
  });

  it('habit_create custom_days normalizes daysOfWeek to CSV', async () => {
    const r = await h.habit_create({
      name: 'corrida', kind: 'binary', cadence: 'custom_days',
      daysOfWeek: [1, 3, 5], correlationId: 'c1',
    });
    expect(habits.findById(r.id)?.daysOfWeek).toBe('1,3,5');
  });

  it('habit_create rejects duplicate name', async () => {
    await h.habit_create({ name: 'meditar', kind: 'binary', cadence: 'daily', correlationId: 'c1' });
    await expect(h.habit_create({ name: 'meditar', kind: 'binary', cadence: 'daily', correlationId: 'c2' }))
      .rejects.toThrow(/UNIQUE|exists/i);
  });

  it('habit_create rejects quantity without target', async () => {
    await expect(h.habit_create({ name: 'x', kind: 'quantity', cadence: 'daily', correlationId: 'c' }))
      .rejects.toThrow(/target/);
  });

  it('habit_create rejects custom_days without daysOfWeek', async () => {
    await expect(h.habit_create({ name: 'x', kind: 'binary', cadence: 'custom_days', correlationId: 'c' }))
      .rejects.toThrow(/daysOfWeek/);
  });

  it('habit_create rejects weekly without targetPerPeriod', async () => {
    await expect(h.habit_create({ name: 'x', kind: 'binary', cadence: 'weekly', correlationId: 'c' }))
      .rejects.toThrow(/targetPerPeriod/);
  });

  it('habit_edit changes target and re-validates', async () => {
    const { id } = await h.habit_create({
      name: 'meditar', kind: 'duration', unit: 'min', target: 10, cadence: 'daily', correlationId: 'c1',
    });
    await h.habit_edit({ id, fields: { target: 15 } });
    expect(habits.findById(id)?.target).toBe(15);
  });

  it('habit_archive sets archivedAt', async () => {
    const { id } = await h.habit_create({
      name: 'flexões', kind: 'quantity', unit: null, target: 30, cadence: 'daily', correlationId: 'c1',
    });
    const r = await h.habit_archive({ id });
    expect(r.archivedAt).toBeGreaterThan(0);
    expect(habits.findById(id)?.archivedAt).not.toBeNull();
  });

  it('habit_unarchive clears archivedAt', async () => {
    const { id } = await h.habit_create({
      name: 'flexões', kind: 'binary', cadence: 'daily', correlationId: 'c1',
    });
    await h.habit_archive({ id });
    await h.habit_unarchive({ id });
    expect(habits.findById(id)?.archivedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Implementar handlers**

Edit `tools.ts`, adicionar à interface e handlers:

```ts
// Interface:
habit_create: (input: {
  name: string;
  kind: 'binary' | 'quantity' | 'duration';
  cadence: 'daily' | 'weekly' | 'custom_days';
  unit?: string | null;
  target?: number | null;
  targetPerPeriod?: number | null;
  daysOfWeek?: number[] | null;
  correlationId: string;
}) => Promise<{ id: number; name: string }>;
habit_edit: (input: {
  id: number;
  fields: { name?: string; unit?: string | null; target?: number | null; cadence?: 'daily' | 'weekly' | 'custom_days'; targetPerPeriod?: number | null; daysOfWeek?: number[] | null };
}) => Promise<{ id: number }>;
habit_archive: (input: { id: number }) => Promise<{ id: number; archivedAt: number }>;
habit_unarchive: (input: { id: number }) => Promise<{ id: number }>;

// Handlers:
async habit_create({ name, kind, cadence, unit, target, targetPerPeriod, daysOfWeek, correlationId: _correlationId }) {
  if (kind !== 'binary' && (target === undefined || target === null)) {
    throw new Error('target is required for quantity/duration habits');
  }
  if (cadence === 'weekly' && (targetPerPeriod === undefined || targetPerPeriod === null)) {
    throw new Error('targetPerPeriod is required for weekly cadence');
  }
  if (cadence === 'custom_days' && (!daysOfWeek || daysOfWeek.length === 0)) {
    throw new Error('daysOfWeek is required for custom_days cadence');
  }
  for (const d of daysOfWeek ?? []) {
    if (d < 1 || d > 7) throw new Error(`daysOfWeek must be 1-7, got ${d}`);
  }
  const now = clock();
  const id = deps.habits.insert({
    name,
    kind,
    unit: unit ?? null,
    target: target ?? null,
    cadence,
    targetPerPeriod: targetPerPeriod ?? null,
    daysOfWeek: daysOfWeek ? daysOfWeek.slice().sort((a, b) => a - b).join(',') : null,
    reminderScheduleId: null,
    createdAt: now,
    archivedAt: null,
  });
  return { id, name };
},

async habit_edit({ id, fields }) {
  const existing = deps.habits.findById(id);
  if (!existing) throw new Error(`habit not found: ${id}`);
  if (fields.daysOfWeek) {
    for (const d of fields.daysOfWeek) {
      if (d < 1 || d > 7) throw new Error(`daysOfWeek must be 1-7, got ${d}`);
    }
  }
  deps.habits.update(id, {
    name: fields.name,
    unit: fields.unit,
    target: fields.target,
    cadence: fields.cadence,
    targetPerPeriod: fields.targetPerPeriod,
    daysOfWeek: fields.daysOfWeek === undefined ? undefined : (fields.daysOfWeek === null ? null : fields.daysOfWeek.slice().sort((a, b) => a - b).join(',')),
  });
  return { id };
},

async habit_archive({ id }) {
  if (!deps.habits.findById(id)) throw new Error(`habit not found: ${id}`);
  const at = clock();
  deps.habits.archive(id, at);
  return { id, archivedAt: at };
},

async habit_unarchive({ id }) {
  if (!deps.habits.findById(id)) throw new Error(`habit not found: ${id}`);
  deps.habits.unarchive(id);
  return { id };
},
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm test --filter worker tools
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/tools.ts apps/worker/src/skills/habits/tools.test.ts
git commit -m "feat(habits): MCP destructive tools — create, edit, archive, unarchive (spec 0006)"
```

---

## Phase 9: MCP server factory

### Task 8: `createHabitsMcpServer` agrupando 10 tools

**Files:**
- Modify: `apps/worker/src/skills/habits/tools.ts`
- Modify: `apps/worker/src/skills/habits/tools.test.ts`

- [ ] **Step 1: Adicionar factory**

Append em `tools.ts`:

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const cadenceEnum = z.enum(['daily', 'weekly', 'custom_days']);
const kindEnum = z.enum(['binary', 'quantity', 'duration']);

export function createHabitsMcpServer(deps: HabitToolDeps): ReturnType<typeof createSdkMcpServer> {
  const handlers = buildHabitToolHandlers(deps);

  return createSdkMcpServer({
    name: 'habits',
    version: '0.1.0',
    tools: [
      tool(
        'habit_list',
        'List habits (default filter=active).',
        { filter: z.enum(['active', 'archived', 'all']).optional() },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_list(input)) }],
        }),
      ),
      tool(
        'habit_status',
        'Return today status for all active habits with streak.',
        {},
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_status(input)) }],
        }),
      ),
      tool(
        'habit_today_pending',
        'List habits pending today (not done yet, expected today).',
        {},
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_today_pending(input)) }],
        }),
      ),
      tool(
        'habit_today_status',
        'Return today status for a single habit by id. Used by pre-emptive reminders to decide between firing and silencing.',
        { habitId: z.number().int().positive() },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_today_status(input)) }],
        }),
      ),
      tool(
        'habit_log',
        'Log a habit. value defaults to 1 (binary). at defaults to today (YYYY-MM-DD, local timezone).',
        {
          habitId: z.number().int().positive(),
          value: z.number().positive().optional(),
          at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          correlationId: z.string(),
        },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_log(input)) }],
        }),
      ),
      tool(
        'habit_log_undo',
        'Undo the last log for a habit if within 5 minutes.',
        { habitId: z.number().int().positive() },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_log_undo(input)) }],
        }),
      ),
      tool(
        'habit_render_dashboard',
        'Render markdown dashboard to context/habits/dashboard.md (overwrite).',
        {},
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_render_dashboard(input)) }],
        }),
      ),
      tool(
        'habit_create',
        'Create a new habit. binary/quantity/duration + daily/weekly/custom_days.',
        {
          name: z.string().min(1),
          kind: kindEnum,
          cadence: cadenceEnum,
          unit: z.string().nullable().optional(),
          target: z.number().positive().nullable().optional(),
          targetPerPeriod: z.number().int().positive().nullable().optional(),
          daysOfWeek: z.array(z.number().int().min(1).max(7)).nullable().optional(),
          correlationId: z.string(),
        },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_create(input)) }],
        }),
      ),
      tool(
        'habit_edit',
        'Edit habit fields.',
        {
          id: z.number().int().positive(),
          fields: z.object({
            name: z.string().min(1).optional(),
            unit: z.string().nullable().optional(),
            target: z.number().positive().nullable().optional(),
            cadence: cadenceEnum.optional(),
            targetPerPeriod: z.number().int().positive().nullable().optional(),
            daysOfWeek: z.array(z.number().int().min(1).max(7)).nullable().optional(),
          }),
        },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_edit(input)) }],
        }),
      ),
      tool(
        'habit_archive',
        'Archive habit (keeps history; hides from status; cancels reminder if linked — done by orchestration in SKILL.md, not here).',
        { id: z.number().int().positive() },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_archive(input)) }],
        }),
      ),
      tool(
        'habit_unarchive',
        'Unarchive habit.',
        { id: z.number().int().positive() },
        async (input) => ({
          content: [{ type: 'text', text: JSON.stringify(await handlers.habit_unarchive(input)) }],
        }),
      ),
    ],
  });
}
```

- [ ] **Step 2: Test smoke da factory (não testa cada tool — só forma)**

Append em `tools.test.ts`:

```ts
import { createHabitsMcpServer } from './tools';

describe('createHabitsMcpServer', () => {
  it('returns server with expected name', () => {
    const db = openDatabase(':memory:');
    runMigrations(db);
    const server = createHabitsMcpServer({
      habits: new HabitRepo(db),
      logs: new HabitLogRepo(db),
      timezone: 'America/Sao_Paulo',
      dashboardPath: '/tmp/x.md',
    });
    expect(server).toBeDefined();
    // SDK shape varies — minimal assertion is non-throwing construction.
  });
});
```

- [ ] **Step 3: Rodar tests + quality gate**

```bash
pnpm run quality-gate
```

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/skills/habits/tools.ts apps/worker/src/skills/habits/tools.test.ts
git commit -m "feat(habits): createHabitsMcpServer factory wiring 10 zod-typed tools (spec 0006)"
```

---

## Phase 10: Wire-up no index.ts

### Task 9: Instanciar repos + factory + registrar no `inProcessMcpServers`

**Files:**
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Editar `index.ts`**

Adicionar imports:

```ts
import { HabitLogRepo, HabitRepo } from '@whis/storage';
import { createHabitsMcpServer } from './skills/habits/tools';
```

Após instanciar `scheduledMessages`, adicionar:

```ts
const habits = new HabitRepo(db);
const habitLogs = new HabitLogRepo(db);
```

Modificar `buildBackend` pra aceitar habits MCP server, e adicionar instanciação:

```ts
function buildBackend(
  config: Config,
  scheduledMcp: ReturnType<typeof createScheduledMessagesMcpServer> | null,
  habitsMcp: ReturnType<typeof createHabitsMcpServer> | null,
): AgentBackend {
  if (config.backend === 'mock') {
    return new MockBackend(loadMockFixtures());
  }
  const mcpServers = loadMcpConfig();
  const inProcess: Record<string, unknown> = {};
  if (scheduledMcp) inProcess['scheduled-messages'] = scheduledMcp;
  if (habitsMcp) inProcess['habits'] = habitsMcp;
  return new ClaudeCodeBackend({
    mcpServers,
    inProcessMcpServers: inProcess as never,
  });
}
```

Em `main()`, criar `habitsMcp` e passar:

```ts
const habitsMcp = createHabitsMcpServer({
  habits,
  logs: habitLogs,
  timezone: 'America/Sao_Paulo',
  dashboardPath: join(config.contextDir, 'habits', 'dashboard.md'),
});
bootLogger.info({ event: 'mcp_inprocess_registered', name: 'habits' });

const backend = buildBackend(config, scheduledMcp, habitsMcp);
```

- [ ] **Step 2: Rodar quality gate + boot real**

```bash
pnpm run quality-gate
pnpm run docker:build
pnpm run docker:up
pnpm run docker:logs:local | head -30
```

Esperado nos logs: `mcp_inprocess_registered name=habits`, `migrations_applied`, schema_version=3 implícito.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat(habits): wire HabitRepo + HabitLogRepo + habits MCP server in worker boot (spec 0006)"
```

---

## Phase 11: Skills + SOUL + docs

### Task 10: SKILL.md novo + atualização do scheduled-messages + regra SOUL + SMOKE + AGENTS

**Files:**
- Create: `agent/skills/habits/SKILL.md`
- Modify: `agent/skills/scheduled-messages/SKILL.md`
- Modify: `agent/SOUL.md`
- Modify: `SMOKE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Criar `agent/skills/habits/SKILL.md`**

Estrutura (~180 linhas):

```markdown
---
name: habits
description: Use quando o Gabriel mencionar tracking de hábitos: criar/listar/editar/arquivar hábitos, registrar atividade (mesmo sem dizer "registra" — ex: "fui pra academia", "30 flexões", "10min de meditação"), pedir status do dia, dashboard, ou cobrança proativa. Storage próprio em SQLite (separado de scheduled-messages e Google Calendar).
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

- Anotação livre sem padrão de hábito ("hoje foi um dia bom") → vault Obsidian.
- Tarefas one-shot ("comprar pão amanhã") → `scheduled-messages`.
- Eventos com pessoas/local → `google-calendar`.

## Ferramentas disponíveis

**Reads — executa direto, sem confirmar:**
- `habit_list` — lista hábitos (filter: 'active'|'archived'|'all', default 'active').
- `habit_status` — status de hoje com streak de cada hábito ativo.
- `habit_today_pending` — só os pendentes hoje.
- `habit_today_status` — status de um único hábito por id. **Usado pelos lembretes pré-emptivos** (no scheduled-message agent: cheque antes de mandar; se done, silencie).

**Writes leves — executa direto, confirma pós-fato (SEM 3-passos):**
- `habit_log` — registra atividade. Após executar, confirme: *"Anotado: **X** (Yunidade). Streak: Zd."*
- `habit_log_undo` — desfaz último log se <5min. Quando user disser "desfaz/foi mal", chame e confirme.
- `habit_render_dashboard` — escreve `context/habits/dashboard.md`. Confirme com path.

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

1. Carregue `habit_list` se ainda não tiver na turn.
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
   - Cria scheduled-message `kind: 'agent'`, recurrence cron diária no horário pedido.
   - Payload: `"é {hora}. Cheque habit_today_status(habitId={id}). Se 'done', silencie totalmente (não envie). Se 'pending', mande um lembrete curto e gentil."`
   - Pós-cria, chame `habit_edit` setando `reminderScheduleId` (via tool dedicada — ver `setReminderScheduleId` em repo) ou aceite a separação loose: cascade só funciona via SKILL.md.
2. **Check-in noturno geral.** Pergunte: *"E quer check-in noturno geral (21h) que cobra tudo que faltou?"* — se sim, cria scheduled-message agent não-linkado a hábito específico. Único pro Gabriel; não recria se já existe.

## Comportamento em `scheduled_trigger`

Quando o turn vem com flag `scheduled_trigger` injetada (dispatcher chamou `dispatchSynthetic`):

- **Lembrete pré-emptivo:** chame `habit_today_status` conforme o payload manda. Se `done` → não envie mensagem. Se `pending` → curto e gentil, sem floreio: *"17h, lembrete: **exercitar** hoje (streak: 4)."*
- **Check-in noturno geral:** chame `habit_today_pending`. Se vazio → mensagem positiva curta (*"21h. Hoje fechou tudo, bora dormir 🌙"*). Se não vazio → liste e cobre amigavelmente.

## Cascade no archive

Quando `habit_archive`, se `reminderScheduleId` não é null:

1. Mostre no resumo: *"Vou arquivar **flexões** e cancelar o lembrete diário das 18h. Histórico fica."*
2. Após aprovar, chame `habit_archive(id)` E `schedule_cancel(id=reminderScheduleId)` em sequência.

## Padrões few-shot (H1–H12)

**H1 — criar com lembrete pré-emptivo** ...
**H1b — criar e perguntar** ...
**H1c — só check-in noturno** ...
**H3 — log natural duração** ...
**H6 — log retroativo** ...
**H9 — lembrete pré-emptivo dispara pending** ...
**H9b — silencia se done** ...
**H11 — archive com cascade** ...
**H12 — undo dentro de 5min** ...

(Cenários completos espelham `docs/specs/0006-habit-tracking/spec.md` H1-H12.)

## Coisas que NÃO devo fazer

- Pedir confirmação antes de `habit_log` / `habit_log_undo` / `habit_render_dashboard` — quebra o caminho quente.
- Criar hábito sem nome único — o repo rejeita; traduza erro pro user.
- Tentar logar em hábito arquivado — repo rejeita; sugira `habit_unarchive` se for o caso.
- Modificar logs históricos retroativamente além de undo — v1 não suporta. Sugira undo + relog.
- Re-renderizar dashboard automaticamente em toda turn — só on-demand.
- Usar `CronCreate` / `ScheduleWakeup` (built-ins do harness Claude) — sempre use `schedule_*` e `habit_*` deste workspace.
```

- [ ] **Step 2: Atualizar `agent/skills/scheduled-messages/SKILL.md`**

Adicionar antes da seção "Ferramentas disponíveis":

```markdown
## Quando NÃO usar (use `habits` em vez)

- Lembretes que dependem do user já ter feito algo aquele dia (*"todo dia 17h me lembra de exercitar"* + silenciar se já feito) → use a skill `habits`, que tem `habit_today_status` pra decidir entre lembrar ou silenciar.
- Tracking recorrente de comportamento (academia, meditação, leitura) → `habits` agrega + faz heatmap + cobra contextualmente.

**Regra:** lembrete *cego* (sempre dispara) → `scheduled-messages`. Lembrete *condicional ao status do hábito* → `habits`.
```

- [ ] **Step 3: Atualizar `agent/SOUL.md`**

Adicionar na seção "Regras absolutas de segurança", paralela às do Calendar e Scheduled:

```markdown
- **Habits:** ações de escrita destrutivas (`habit_create`, `habit_edit`, `habit_archive`, `habit_unarchive`) sempre mostre o resumo da operação e peça "sim" antes de chamar a tool. **Exceção explícita** — `habit_log`, `habit_log_undo` e `habit_render_dashboard` executam DIRETO sem confirmação prévia; o caminho quente do tracking pede registro intuitivo. Whis confirma pós-fato com info útil ("Anotado: X, streak Y"). Esta regra é absoluta.
```

- [ ] **Step 4: Atualizar `SMOKE.md`**

Adicionar seção "Smoke `habits`" com checklist H1-H12. Padrão: cada cenário tem (a) input do user, (b) chamadas de tool esperadas, (c) resposta esperada do Whis, (d) verificação no DB ou no `context/habits/dashboard.md`.

- [ ] **Step 5: Atualizar `AGENTS.md`**

Em "Locais de conhecimento", adicionar linha:

```markdown
| Spec Habits (skill) | `docs/specs/0006-habit-tracking/spec.md` |
```

- [ ] **Step 6: Rodar quality gate + boot real**

```bash
pnpm run quality-gate
pnpm run docker:up
pnpm run docker:logs:local | grep -E 'soul_md_loaded|mcp_inprocess'
```

Esperado: `soul_md_loaded bytes` maior que antes; `mcp_inprocess_registered name=habits` presente.

- [ ] **Step 7: Commit**

```bash
git add agent/skills/habits/SKILL.md agent/skills/scheduled-messages/SKILL.md agent/SOUL.md SMOKE.md AGENTS.md
git commit -m "docs(habits): SKILL.md + SOUL rule + scheduled-messages cross-ref + SMOKE + AGENTS (spec 0006)"
```

---

## Phase 12: Smoke manual

### Task 11: Executar H1–H12 via Telegram + validar dashboard

**Files:**
- Create: `docs/specs/0006-habit-tracking/smoke-results.md`
- Modify: `docs/specs/0006-habit-tracking/spec.md` (frontmatter `status: shipped`)

- [ ] **Step 1: Subir worker em modo limpo (DB zerado)**

```bash
pnpm run docker:down
docker volume rm whis_data || true  # zera DB
pnpm run docker:up
pnpm run docker:logs:local | head -30
```

Confirmar logs: `migrations_applied`, `mcp_inprocess_registered name=habits`.

- [ ] **Step 2: Executar H1–H12 via Telegram**

Para cada cenário (H1–H12), enviar input via Telegram e marcar resultado em `smoke-results.md`:

```markdown
- [x] H1 — criar hábito com lembrete pré-emptivo. Whis criou + agendou lembrete. Log `habit_created`.
- [x] H1b — criar sem horário (pergunta). OK.
- [x] H1c — só check-in noturno. OK.
- [x] H3 — log natural duração ("acabei de meditar 12min"). OK.
- [x] H5 — log binário ("fui pra academia"). OK.
- [x] H6 — log retroativo. OK.
- [x] H7 — status rápido. OK.
- [x] H8 — habit_render_dashboard. Arquivo escrito em `context/habits/dashboard.md`, abre no Obsidian, heatmap correto.
- [x] H9 — lembrete pré-emptivo dispara com pending. Log `habit_reminder_sent`.
- [x] H9b — silencia se done. Log `habit_reminder_silenced`. Sem mensagem.
- [x] H9c — check-in noturno geral. OK.
- [x] H10 — edit com cascade. OK.
- [x] H11 — archive com cascade. OK.
- [x] H12 — undo dentro de 5min. OK.
```

- [ ] **Step 3: Verificar `context/habits/dashboard.md`**

Abrir no Obsidian (vault local). Confirmar:
- Header com data.
- Legenda visível.
- Seção por hábito ativo.
- Heatmap de 30 dias renderizado, 4 estados (✅ ⬜ 🟧 ▫️) onde esperado.
- Streaks e stats 30d corretos.

- [ ] **Step 4: Marcar spec como shipped**

Editar `docs/specs/0006-habit-tracking/spec.md` frontmatter:

```yaml
---
status: shipped
feature: habit-tracking
created: 2026-05-18
shipped: 2026-05-XX
---
```

- [ ] **Step 5: Commit final**

```bash
git add docs/specs/0006-habit-tracking/smoke-results.md docs/specs/0006-habit-tracking/spec.md
git commit -m "docs(habits): mark spec 0006 as shipped — H1-H12 smoke validated"
```

---

## Checklist final

- [ ] Task 0: Discovery (context dir + tool routing + Unicode)
- [ ] Task 1: Migration_003 + HabitRepo
- [ ] Task 2: HabitLogRepo
- [ ] Task 3: stats.ts puro
- [ ] Task 4: dashboard.ts puro
- [ ] Task 5: MCP read tools
- [ ] Task 6: MCP write tools (leves)
- [ ] Task 7: MCP write tools (destrutivos)
- [ ] Task 8: createHabitsMcpServer factory
- [ ] Task 9: Wire-up no index.ts
- [ ] Task 10: SKILL.md + SOUL + cross-ref + SMOKE + AGENTS
- [ ] Task 11: Smoke manual H1-H12 + dashboard validado + spec shipped
