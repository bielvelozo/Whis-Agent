import type { Fixture } from '@/agent/backends/mock';

/**
 * Hardcoded PT-BR fixtures used pelo MockBackend quando ZENO_BACKEND=mock.
 *
 * O `mock.ts` herdado do zeno usa o tipo `Fixture = { match: RegExp; reply: string }`,
 * então mantemos esse mesmo shape (sem `output: AgentOutput` — diferente do spec original).
 *
 * Primeira regex que casar vence; se nada casar, o `MockBackend` cai num echo default.
 */
export function loadMockFixtures(): Fixture[] {
  return [
    {
      match: /^(oi|olá|ola|hello|hey|e a[ií]|bom dia|boa tarde|boa noite)\b/i,
      reply: 'E aí, Gabriel. Aqui é o Whis (mock). Tudo certo?',
    },
    {
      match: /.*/,
      reply: '(mock fallback) sem fixture pra essa entrada — adicione em mock-fixtures.ts.',
    },
  ];
}
