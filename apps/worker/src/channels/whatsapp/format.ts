/**
 * Translates Claude-style markdown into WhatsApp markdown.
 *
 * - `**bold**`  → `*bold*`
 * - `*italic*`  → `_italic_`
 * - Inline `code` and fenced ``` blocks are preserved untouched.
 * - Other formatting passes through.
 *
 * Implementação em estágios com placeholders pra evitar que o italic
 * re-converta o resultado do bold (`*x*` virando `_x_`).
 */
export function toWhatsAppText(input: string): string {
  // Stage 1: proteger code blocks e inline code com placeholder seguro.
  const codePlaceholders: string[] = [];
  const protectCode = (match: string): string => {
    codePlaceholders.push(match);
    return `C${codePlaceholders.length - 1}`;
  };
  let s = input
    .replace(/```[\s\S]*?```/g, protectCode)
    .replace(/`[^`\n]+`/g, protectCode);

  // Stage 2: extrair bold spans `**x**`, guardando só o conteúdo. Substituir
  // por placeholder pra que o italic não veja `*` algum aqui.
  const boldContents: string[] = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, content: string) => {
    boldContents.push(content);
    return `B${boldContents.length - 1}`;
  });

  // Stage 3: italic `*x*` → `_x_`. Seguro porque bold virou placeholder.
  s = s.replace(/\*([^*\n]+)\*/g, '_$1_');

  // Stage 4: restaurar bold como `*content*` (WhatsApp bold).
  s = s.replace(/B(\d+)/g, (_, idx: string) => `*${boldContents[Number(idx)]}*`);

  // Stage 5: restaurar code blocks/inline.
  s = s.replace(/C(\d+)/g, (_, idx: string) => codePlaceholders[Number(idx)] ?? '');

  return s;
}
