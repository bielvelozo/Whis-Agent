import type { HabitLogRecord, HabitRecord } from '@whis/storage';
import { aggregatePeriod, computeStreak, expectsHabitOnDate } from './stats.js';

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
    habit.cadence === 'daily'
      ? 'daily'
      : habit.cadence === 'weekly'
        ? `${habit.targetPerPeriod ?? 1}x/semana`
        : `dias ${habit.daysOfWeek ?? ''}`;
  const targetDesc =
    habit.kind === 'binary' ? '' : ` · target ${habit.target}${habit.unit ? habit.unit : ''}`;
  lines.push(`_${habit.kind} · ${cadenceDesc}${targetDesc}_`);
  lines.push('');
  lines.push(`**Streak:** ${streak}`);
  if (agg.kind === 'binary') {
    lines.push(`**30d:** ${agg.daysDone} dias`);
  } else {
    const sum = Math.round(agg.sum * 10) / 10;
    const avg = Math.round(agg.avgPerDay * 10) / 10;
    const unit = habit.unit ?? '';
    lines.push(`**30d:** total ${sum}${unit} · média ${avg}${unit}/dia`);
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
