// apps/worker/src/channels/telegram/format.test.ts
import { describe, expect, it } from 'vitest';
import { toTelegramMarkdownV2 } from './format';

describe('toTelegramMarkdownV2', () => {
  it('translates **bold** to *bold*', () => {
    expect(toTelegramMarkdownV2('hello **world**')).toBe('hello *world*');
  });

  it('translates *italic* to _italic_', () => {
    expect(toTelegramMarkdownV2('hello *world*')).toBe('hello _world_');
  });

  it('preserves inline `code` content but escapes special chars inside', () => {
    expect(toTelegramMarkdownV2('use `pnpm install`')).toBe('use `pnpm install`');
  });

  it('preserves fenced code blocks unchanged', () => {
    const input = 'before\n```\nfoo\n```\nafter';
    expect(toTelegramMarkdownV2(input)).toBe(input);
  });

  it('escapes special chars in plain text', () => {
    expect(toTelegramMarkdownV2('hello. world!')).toBe('hello\\. world\\!');
    expect(toTelegramMarkdownV2('a (b) c [d]')).toBe('a \\(b\\) c \\[d\\]');
    expect(toTelegramMarkdownV2('1 + 2 = 3')).toBe('1 \\+ 2 \\= 3');
  });

  it('escapes special chars but keeps formatting markers', () => {
    expect(toTelegramMarkdownV2('see **here** for details.')).toBe('see *here* for details\\.');
  });

  it('escapes special chars inside italic content', () => {
    expect(toTelegramMarkdownV2('this is *cool.*')).toBe('this is _cool\\._');
  });

  it('escapes special chars inside inline code', () => {
    expect(toTelegramMarkdownV2('see `a.b!` now')).toBe('see `a\\.b\\!` now');
  });

  it('preserves text without markdown', () => {
    expect(toTelegramMarkdownV2('plain text')).toBe('plain text');
  });

  it('handles mixed bold + italic + code', () => {
    expect(toTelegramMarkdownV2('**bold** and *italic* and `code`')).toBe(
      '*bold* and _italic_ and `code`',
    );
  });

  it('handles bold containing dot', () => {
    expect(toTelegramMarkdownV2('**Hello.**')).toBe('*Hello\\.*');
  });
});
