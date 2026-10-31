import { describe, expect, it } from 'vitest';
import { CUSTOMER_NO_STT_REASON, STT_OFF_REASON, transcriberChoice } from '../../src/stt/transcriberChoice.ts';
import { PROVIDER_IDS } from '../../src/stt/types.ts';

describe('transcriberChoice (D2)', () => {
  it('the founder with a paid provider gets it', () => {
    for (const provider of PROVIDER_IDS) expect(transcriberChoice({ founder: true, sttProvider: provider })).toEqual({ kind: 'paid', provider });
  });

  it('a customer with a paid provider configured gets none, with the reason: the founder’s key is never theirs', () => {
    for (const provider of PROVIDER_IDS) {
      expect(transcriberChoice({ founder: false, sttProvider: provider })).toEqual({ kind: 'none', reason: CUSTOMER_NO_STT_REASON });
    }
  });

  it('local speech is for everyone', () => {
    expect(transcriberChoice({ founder: false, sttProvider: 'local' })).toEqual({ kind: 'local' });
    expect(transcriberChoice({ founder: true, sttProvider: 'local' })).toEqual({ kind: 'local' });
  });

  it('with speech off, the founder is told it is off and a customer how to get it', () => {
    expect(transcriberChoice({ founder: true, sttProvider: 'none' })).toEqual({ kind: 'none', reason: STT_OFF_REASON });
    expect(transcriberChoice({ founder: false, sttProvider: 'none' })).toEqual({ kind: 'none', reason: CUSTOMER_NO_STT_REASON });
  });
});
