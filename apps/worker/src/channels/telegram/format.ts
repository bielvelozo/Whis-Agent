// apps/worker/src/channels/telegram/format.ts

/**
 * Translates Claude-style markdown into Telegram MarkdownV2.
 *
 * - `**bold**`  → `*bold*`
 * - `*italic*`  → `_italic_`
 * - Inline `code` and fenced ``` blocks: backticks preservados; conteúdo de
 *   inline code é escapado por dentro (regra MarkdownV2). Fenced ``` blocks
 *   preservam conteúdo cru.
 * - Caracteres especiais MarkdownV2 (`_*[]()~`>#+-=|{}.!`) recebem `\` em texto comum.
 *
 * Stages com placeholders puramente alfanuméricos (`WHISCMARK<n>END`, `WHISBMARK<n>END`,
 * `WHISIMARK<n>END`) — escolhidos pra não conter nenhum caractere especial do MarkdownV2.
 * Importante: o stage 4 (escape global) executa entre placeholders postos e restaurados;
 * se algum char do placeholder fosse special (ex: `_`), o escape o quebraria.
 */
const MD_V2_SPECIAL = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export function toTelegramMarkdownV2(input: string): string {
  // Stage 1: proteger fenced code blocks e inline code com placeholders.
  const codePlaceholders: string[] = [];
  const protectCode = (match: string): string => {
    codePlaceholders.push(match);
    return `WHISCMARK${codePlaceholders.length - 1}END`;
  };
  let s = input.replace(/```[\s\S]*?```/g, protectCode).replace(/`[^`\n]+`/g, protectCode);

  // Stage 2: extrair bold spans `**x**`.
  const boldContents: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, content: string) => {
    boldContents.push(content);
    return `WHISBMARK${boldContents.length - 1}END`;
  });

  // Stage 3: extrair italic spans `*x*`.
  const italicContents: string[] = [];
  s = s.replace(/\*([^*\n]+)\*/g, (_, content: string) => {
    italicContents.push(content);
    return `WHISIMARK${italicContents.length - 1}END`;
  });

  // Stage 4: escape em todo o texto plano restante (placeholders sobrevivem por serem alfanuméricos).
  s = s.replace(MD_V2_SPECIAL, '\\$1');

  // Stage 5: restaurar italic com escape interno.
  s = s.replace(/WHISIMARK(\d+)END/g, (_, idx: string) => {
    const content = italicContents[Number(idx)] ?? '';
    return `_${escapeText(content)}_`;
  });

  // Stage 6: restaurar bold com escape interno.
  s = s.replace(/WHISBMARK(\d+)END/g, (_, idx: string) => {
    const content = boldContents[Number(idx)] ?? '';
    return `*${escapeText(content)}*`;
  });

  // Stage 7: restaurar code blocks.
  s = s.replace(/WHISCMARK(\d+)END/g, (_, idx: string) => {
    const block = codePlaceholders[Number(idx)] ?? '';
    return restoreCode(block);
  });

  return s;
}

function escapeText(s: string): string {
  return s.replace(MD_V2_SPECIAL, '\\$1');
}

/** Restaura inline `code` (com escape interno) ou fenced ``` block (cru). */
function restoreCode(block: string): string {
  if (block.startsWith('```')) {
    // Fenced block: preservar como veio.
    return block;
  }
  // Inline `code`: backticks preservados, conteúdo recebe escape MarkdownV2.
  const inner = block.slice(1, -1);
  return `\`${inner.replace(MD_V2_SPECIAL, '\\$1')}\``;
}
