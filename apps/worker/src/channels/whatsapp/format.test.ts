import { describe, it, expect } from 'vitest';
import { toWhatsAppText } from './format';

describe('toWhatsAppText', () => {
  it('translates **bold** to *bold*', () => {
    expect(toWhatsAppText('hello **world**')).toBe('hello *world*');
  });

  it('translates *italic* to _italic_', () => {
    expect(toWhatsAppText('hello *world*')).toBe('hello _world_');
  });

  it('keeps inline `code` unchanged', () => {
    expect(toWhatsAppText('use `pnpm install`')).toBe('use `pnpm install`');
  });

  it('keeps fenced code blocks unchanged', () => {
    const input = 'before\n```\nfoo\n```\nafter';
    expect(toWhatsAppText(input)).toBe(input);
  });

  it('preserves text without markdown', () => {
    expect(toWhatsAppText('plain text')).toBe('plain text');
  });
});
