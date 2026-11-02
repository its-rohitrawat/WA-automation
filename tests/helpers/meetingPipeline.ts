import { writeFileSync } from 'node:fs';
import type { MeetingAi, MeetingAiResult } from '../../src/brain/meetingClient.ts';
import type { RunFile, RunOptions } from '../../src/stt/audio.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import type { NewMeeting } from '../../src/store/meetings.ts';
import type { FakeMeetingsApi } from './fakeMeetings.ts';

// Fakes for the whole meeting pipeline (Task 10): speech, Claude summary and ffmpeg. Nothing here reaches a network or
// runs a program.

export const FILE_ID = 'fileAbc123';
/** 15:30 IST on 1 Nov 2026. */
export const STARTED = '2026-11-01T10:00:00.000Z';
export const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

let seq = 0;
/**
 * A queued Sharma meeting at stage found, as discovery stores it. The client id is the caller's (idOf, or seeded()'s
 * ids): no default, since on Postgres Sharma is not 1.
 */
export const queuedMeeting = (o: Partial<NewMeeting> & Pick<NewMeeting, 'clientId'>): NewMeeting => ({
  recording: `conferenceRecords/c1/recordings/r${++seq}`,
  conference: 'conferenceRecords/c1',
  driveFileId: FILE_ID,
  meetingCode: 'abc-defg-hij',
  title: 'Sharma weekly',
  startedAt: STARTED,
  endedAt: null,
  attendees: [{ email: 'asha@sharma.example', name: 'Asha Verma', team: false }],
  participants: [],
  matchKind: 'title',
  status: 'queued',
  driveSeconds: 2700,
  createdAt: '2026-11-01T11:00:00.000Z',
  ...o,
});

/** The recording's Drive file in the fake Google. */
export function addRecordingFile(api: FakeMeetingsApi, fileId = FILE_ID): void {
  api.files.set(fileId, {
    info: { name: 'Sharma weekly (2026-11-01 15:30 GMT+05:30).mp4', size: 1000, mimeType: 'video/mp4', durationMs: 2_700_000 },
    bytes: Buffer.from('video-bytes'),
  });
}

/** What the fake speech provider says, in two segments. */
export const SAID = [
  { start: 1, end: 4, speaker: 'A', text: 'Logo files aap kal tak bhej dijiye' },
  { start: 4, end: 8, speaker: 'B', text: 'Haan, bhej denge.' },
];

/** A scripted speech provider (ElevenLabs style: one call, a copy to forget). `gate` holds every call until it resolves. */
export class FakeSttProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds: number;
  readonly calls: { audio: AudioPart; opts: TranscribeOptions }[] = [];
  readonly forgotten: string[] = [];
  /** Errors to throw, in order, before answering. */
  failures: Error[] = [];
  gate: Promise<void> | undefined;
  /** Resolves when a call has started. */
  started: Promise<void>;
  #started: () => void = () => {};
  #ref = 0;

  constructor(id: ProviderId = 'elevenlabs', maxPartSeconds = 36_000) {
    this.id = id;
    this.maxPartSeconds = maxPartSeconds;
    this.started = new Promise<void>((r) => (this.#started = r));
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push({ audio, opts });
    this.#started();
    if (this.gate) await this.gate;
    const e = this.failures.shift();
    if (e) throw e;
    const segments = SAID.map((s) => ({ ...s }));
    return { model: 'scribe', segments, billedSeconds: null, raw: { ref: `tr-${++this.#ref}` } };
  }

  forgetRef(r: ProviderResult): string | null {
    return (r.raw as { ref?: string }).ref ?? null;
  }

  async forgetById(ref: string): Promise<void> {
    this.forgotten.push(ref);
  }
}

/** The summary the fake Claude writes: one client action item and one decision, both citing s1. */
export const SUMMARY_WIRE = {
  whatHappened: 'The client will send the logo files.',
  discussion: [{ topic: 'Logo', summary: 'Files are needed.' }],
  decisions: [{ text: 'Blue theme chosen.', segmentIds: ['s2'] }],
  actionItems: [{ side: 'client', task: 'Send the logo files.', owner: '', deadline: '2026-11-02', segmentIds: ['s1'] }],
  openQuestions: [],
  conclusion: 'Logo files next.',
  speakers: [{ label: 'A', name: 'Asha Verma' }],
};

/** Answers in order from a queue (an Error is thrown); defaults to SUMMARY_WIRE at 5 cents. `gate` holds every call. */
export class FakeMeetingAi implements MeetingAi {
  readonly calls: { system: string; user: string }[] = [];
  readonly #queue: (Partial<MeetingAiResult> | Error)[];
  gate: Promise<void> | undefined;
  started: Promise<void>;
  #started: () => void = () => {};

  constructor(queue: (Partial<MeetingAiResult> | Error)[] = []) {
    this.#queue = [...queue];
    this.started = new Promise<void>((r) => (this.#started = r));
  }

  async summarize(system: string, user: string): Promise<MeetingAiResult> {
    this.calls.push({ system, user });
    this.#started();
    if (this.gate) await this.gate;
    const n = this.#queue.shift();
    if (n instanceof Error) throw n;
    return { output: structuredClone(SUMMARY_WIRE), usage: ZERO_USAGE, costUsd: 0.05, fallbackUsed: false, model: 'fake', ...n };
  }
}

const banner = (seconds: number) =>
  `Input #0, mp3, from 'x':\n  Duration: ${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.00, start: 0\n`;

export interface FakeFfmpeg {
  run: RunFile;
  opts: RunOptions[];
  /** The conversion: 'ok' writes the MP3, 'fail' exits 1, 'hang' waits for the signal. */
  convert: 'ok' | 'fail' | 'hang';
  /** What measuring any file gives. */
  seconds: number;
  conversions: number;
  /** Resolves when a hanging conversion has started. */
  hung: Promise<void>;
}

/**
 * ffmpeg without a program: converting writes a small file, measuring answers `seconds`. A split (-f segment) writes
 * equal parts, each measured at its own length.
 */
export function fakeFfmpeg(seconds = 2700): FakeFfmpeg {
  let hung: () => void = () => {};
  const parts = new Map<string, number>();
  const f: FakeFfmpeg = {
    opts: [],
    convert: 'ok',
    seconds,
    conversions: 0,
    hung: new Promise<void>((r) => (hung = r)),
    run: async (_file, args, o) => {
      f.opts.push(o);
      if (args.includes('libmp3lame')) {
        f.conversions++;
        if (f.convert === 'fail') return { code: 1, stderr: '' };
        if (f.convert === 'hang') {
          hung();
          await new Promise<void>((resolve) => o.signal?.addEventListener('abort', () => resolve(), { once: true }));
          return { code: -1, stderr: '' };
        }
        writeFileSync(args[args.length - 1]!, 'mp3-bytes');
        return { code: 0, stderr: '' };
      }
      if (args.includes('segment')) {
        const each = Number(args[args.indexOf('-segment_time') + 1]);
        const count = Math.round(f.seconds / each);
        for (let i = 0; i < count; i++) {
          const path = args[args.length - 1]!.replace('%03d', String(i).padStart(3, '0'));
          writeFileSync(path, 'mp3-part');
          parts.set(path, Math.round(each));
        }
        return { code: 0, stderr: '' };
      }
      return { code: 1, stderr: banner(parts.get(args[args.indexOf('-i') + 1]!) ?? f.seconds) };
    },
  };
  return f;
}

/** A promise the test settles by hand. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}
