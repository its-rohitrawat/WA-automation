import type { MeetingStats } from '../store/meetings.ts';

/**
 * Why meetings are not transcribed although STT_PROVIDER is local (plan 2026-10-28-meetings-local-stt.md, Task 3):
 * STT_LOCAL_BIN or STT_LOCAL_MODEL was not a file when the service started. The voice notes' problems of the same names.
 */
export type MeetingSttProblem = 'local_not_set_up_bin' | 'local_not_set_up_model';

/** What Health needs to know about meetings; null when meetings are switched off. */
export interface MeetingsHealth {
  stats: MeetingStats;
  paused: null | 'google_scopes' | 'google_auth' | 'no_ffmpeg';
  /** STT_PROVIDER as it runs: 'none' when it is none; 'local' for the local engine, set up or not (then sttProblem). */
  sttProvider: 'local' | 'sarvam' | 'elevenlabs' | 'openai' | 'none';
  /** The local engine is not set up: meetings wait (stt_none). Missing when nothing is wrong, and in older snapshots. */
  sttProblem?: MeetingSttProblem;
  /** Extra Google accounts (by label) whose sign-in Google refused; their meetings wait, the others go on. */
  lostAccounts?: readonly string[];
}
