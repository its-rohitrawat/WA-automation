import { beforeAll, describe, expect, it, vi } from 'vitest';

// A browser module (its JSDoc types are checked by tsconfig.web.json).
let meetingLinkId: (search: string) => number | null;
beforeAll(async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  // @ts-expect-error -- browser module (see above)
  ({ meetingLinkId } = await import('../../src/web/public/views/meetings.js'));
});

describe('meetingLinkId', () => {
  it('reads digits only', () => {
    expect(meetingLinkId('?meeting=12')).toBe(12);
    expect(meetingLinkId('?view=ready&meeting=3')).toBe(3);
    expect(meetingLinkId('')).toBeNull();
    expect(meetingLinkId('?meeting=')).toBeNull();
    expect(meetingLinkId('?meeting=12abc')).toBeNull();
    expect(meetingLinkId('?meeting=-1')).toBeNull();
    expect(meetingLinkId('?meeting=1234567890')).toBeNull();
  });
});
