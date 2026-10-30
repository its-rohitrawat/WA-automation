import type { Env } from '../config/env.ts';
import type { ProviderId } from './types.ts';

// D2 (owner, 30 Oct): customers never use the founder's paid speech-to-text. A customer's voice notes and meetings are
// transcribed only with local speech; otherwise not at all, and the screens say why. The founder keeps today's choice.
// Lane A calls this where a runtime is built (S4.7 A2); this file only decides.

export const CUSTOMER_NO_STT_REASON = 'Transcription needs local speech or your own speech key';
export const STT_OFF_REASON = 'Transcription is turned off';

export type TranscriberChoice =
  | { kind: 'paid'; provider: ProviderId }
  | { kind: 'local' }
  | { kind: 'none'; reason: string };

export function transcriberChoice(o: { founder: boolean; sttProvider: Env['VOICE_STT_PROVIDER'] }): TranscriberChoice {
  if (o.sttProvider === 'local') return { kind: 'local' };
  if (o.sttProvider === 'none') return { kind: 'none', reason: o.founder ? STT_OFF_REASON : CUSTOMER_NO_STT_REASON };
  return o.founder ? { kind: 'paid', provider: o.sttProvider } : { kind: 'none', reason: CUSTOMER_NO_STT_REASON };
}
