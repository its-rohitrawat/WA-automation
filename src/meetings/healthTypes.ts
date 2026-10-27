import type { MeetingStats } from '../store/meetings.ts';

/** What Health needs to know about meetings; null when meetings are switched off. */
export interface MeetingsHealth {
  stats: MeetingStats;
  paused: null | 'google_scopes' | 'google_auth' | 'no_ffmpeg';
  sttProvider: 'sarvam' | 'elevenlabs' | 'openai' | 'none';
  /** Extra Google accounts (by label) whose sign-in Google refused; their meetings wait, the others go on. */
  lostAccounts?: readonly string[];
}
