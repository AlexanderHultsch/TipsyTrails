import { describe, expect, it } from 'vitest';
import { CONFIG, DERIVED } from '@tipsytrails/shared';

describe('@tipsytrails/shared integration', () => {
  it('resolves DERIVED.SESSION_TTL_S from CONFIG.SESSION_TTL_DAYS', () => {
    expect(DERIVED.SESSION_TTL_S).toBe(CONFIG.SESSION_TTL_DAYS * 86400);
  });

  it('resolves DERIVED.SESSION_REFRESH_THRESHOLD_S in seconds', () => {
    expect(DERIVED.SESSION_REFRESH_THRESHOLD_S).toBe(30 * 86400);
  });
});
