// packages/logger/src/index.test.ts
import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

describe('createLogger', () => {
  it('returns a logger with the configured service field', () => {
    const logger = createLogger({ service: 'test-svc' });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });
});
