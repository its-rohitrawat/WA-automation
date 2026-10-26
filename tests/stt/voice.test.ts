import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { SpendGuard } from '../../src/spend/spendGuard.ts';
import { AudioError, Ffmpeg } from '../../src/stt/audio.ts';
import { SttHttpError, type HttpFetch } from '../../src/stt/http.ts';
import { withSttHold, type SttBooking } from '../../src/stt/paidStt.ts';
import { costUsd, modelFor } from '../../src/stt/prices.ts';
import type { AudioPart, ProviderId, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import {
  canSendVoice, createVoiceTranscriber, sizeBoundSeconds, SttPartialError, VOICE_CONVERT_TIMEOUT_MS, VOICE_LENGTH_TOLERANCE_S, VOICE_STT_TIMEOUTS,
  voiceCeilingUsd,
  voiceTranscriber, type VoiceInput, type VoiceResult, type VoiceTranscriber,
} from '../../src/stt/voice.ts';
import { manualClock } from '../../src/util/clock.ts';
import { seededDb } from '../helpers/db.ts';

/** Every adapter built by createVoiceTranscriber, with the options it was given. The real adapters are still used. */
const built = vi.hoisted(() => [] as { id: string; opts: Record<string, unknown> }[]);
vi.mock('../../src/stt/providers/sarvam.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/stt/providers/sarvam.ts')>();
  class SarvamProvider extends m.SarvamProvider {
    constructor(opts: ConstructorParameters<typeof m.SarvamProvider>[0]) {
      built.push({ id: 'sarvam', opts: { ...opts } });
      super(opts);
    }
  }
  return { ...m, SarvamProvider };
});
vi.mock('../../src/stt/providers/elevenlabs.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/stt/providers/elevenlabs.ts')>();
  class ElevenLabsProvider extends m.ElevenLabsProvider {
    constructor(opts: ConstructorParameters<typeof m.ElevenLabsProvider>[0]) {
      built.push({ id: 'elevenlabs', opts: { ...opts } });
      super(opts);
    }
  }
  return { ...m, ElevenLabsProvider };
});
vi.mock('../../src/stt/providers/openai.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/stt/providers/openai.ts')>();
  class OpenAiProvider extends m.OpenAiProvider {
    constructor(opts: ConstructorParameters<typeof m.OpenAiProvider>[0]) {
      built.push({ id: 'openai', opts: { ...opts } });
      super(opts);
    }
  }
  return { ...m, OpenAiProvider };
});

const INR = 88;
const MAX_PART: Record<ProviderId, number> = { sarvam: 7200, elevenlabs: 36_000, openai: 300 };

const said = (...texts: string[]): Segment[] => texts.map((text, i) => ({ start: i, end: i + 1, speaker: null, text }));
const result = (segments: Segment[], billedSeconds: number | null = null, ref?: string): ProviderResult => ({
  model: 'm1', segments, billedSeconds, raw: ref === undefined ? {} : { ref },
});
type Script = (audio: AudioPart, opts: TranscribeOptions) => Promise<ProviderResult>;

/** Records every part and option it is sent, and answers from its script (one entry per call), else "namaste". */
class FakeProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds: number;
  readonly calls: { audio: AudioPart; opts: TranscribeOptions }[] = [];
  script: Script[] = [];
  readonly forgotten: string[] = [];
  constructor(id: ProviderId) {
    this.id = id;
    this.maxPartSeconds = MAX_PART[id];
  }
  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push({ audio, opts });
    const next = this.script.shift() ?? (async () => result(said('namaste')));
    return await next(audio, opts);
  }
}
/** A provider that keeps copies, named by the answer's raw.ref (as ElevenLabs does). */
class CopyingProvider extends FakeProvider {
  forgetRef(r: ProviderResult): string | null {
    return (r.raw as { ref?: string }).ref ?? null;
  }
  async forgetById(ref: string): Promise<void> {
    this.forgotten.push(ref);
  }
}

/**
 * Never starts a program: toMp3 writes a file, seconds returns a set length, split returns set parts. Like the real -t,
 * a conversion stops at its maxSeconds: the MP3 then measures no longer than that.
 */
class FakeFfmpeg extends Ffmpeg {
  readonly conversions: { input: string; output: string; maxSeconds: number | undefined }[] = [];
  /** The timeoutMs of every conversion. */
  readonly timeouts: (number | undefined)[] = [];
  readonly splits: { part: AudioPart; dir: string; partSeconds: number }[] = [];
  /** Every file measured, in order. */
  readonly measured: string[] = [];
  /** The true length of the audio. */
  length = 42;
  parts: AudioPart[] = [];
  toMp3Error: Error | null = null;
  secondsError: Error | null = null;
  /** Called at the start of toMp3, to look at the folder as it is then. */
  onToMp3: () => void = () => {};
  #cutAt = Number.POSITIVE_INFINITY;
  constructor() {
    super('ffmpeg-never-run', async () => {
      throw new Error('no program is run in these tests');
    });
  }
  override async toMp3(input: string, output: string, _signal?: AbortSignal, opts: { maxSeconds?: number; timeoutMs?: number } = {}): Promise<void> {
    this.onToMp3();
    this.conversions.push({ input, output, maxSeconds: opts.maxSeconds });
    this.timeouts.push(opts.timeoutMs);
    if (this.toMp3Error) throw this.toMp3Error;
    this.#cutAt = opts.maxSeconds ?? Number.POSITIVE_INFINITY;
    writeFileSync(output, 'mp3');
  }
  override async seconds(input: string): Promise<number> {
    this.measured.push(input);
    if (this.secondsError) throw this.secondsError;
    return Number.isFinite(this.length) ? Math.min(this.length, this.#cutAt) : this.length;
  }
  override async split(part: AudioPart, dir: string, partSeconds: number): Promise<AudioPart[]> {
    this.splits.push({ part, dir, partSeconds });
    mkdirSync(dir, { recursive: true });
    for (const p of this.parts) writeFileSync(p.path, 'part');
    return this.parts;
  }
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wa-voice-'));
  built.length = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const input = (o: Partial<VoiceInput> = {}): VoiceInput => ({ mediaId: 7, path: join(tmp, 'media', 'note.ogg'), maxSeconds: 120, ...o });
const voiceDir = (id = 7) => join(tmp, 'work', `voice-${id}`);
const make = (provider: SttProvider, ffmpeg: Ffmpeg | null = new FakeFfmpeg()): VoiceTranscriber =>
  voiceTranscriber(provider, { inrPerUsd: INR, ffmpeg, tmpDir: join(tmp, 'work') });
/** Both steps, as the extractor runs them (without the hold). */
const run = async (t: VoiceTranscriber, i: VoiceInput): Promise<VoiceResult> => t.transcribe(await t.prepare(i));
const codeOf = (e: unknown): string | null => (e instanceof AudioError ? e.code : null);

const PROVIDERS = ['sarvam', 'elevenlabs', 'openai'] as const;
/** WhatsApp voice notes, MP3 files and other audio: since review round 1 of Task 5, every one is converted first. */
const MIMES = [
  'audio/ogg; codecs=opus', 'audio/ogg ; codecs=opus', 'audio/opus', 'AUDIO/OGG; Codecs=Opus', 'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/aac', 'audio/amr', 'application/octet-stream', null, 'audio/ogg-x', '',
];

// Owner decision (Task 5 review round 1, amends V3 and N2): every file is converted, so its true length is known first.
describe('voiceTranscriber: every file is converted first', () => {
  it.each(PROVIDERS)('%s: converts the original to MP3, stopped at maxSeconds + tolerance + 1, measures the MP3 and sends it as mp3', async (id) => {
    const p = new FakeProvider(id);
    const ff = new FakeFfmpeg();
    await run(make(p, ff), input());
    const mp3 = join(voiceDir(), 'audio.mp3');
    expect(ff.conversions).toEqual([{ input: input().path, output: mp3, maxSeconds: 120 + VOICE_LENGTH_TOLERANCE_S + 1 }]);
    // Only the MP3 ffmpeg wrote is measured, never the original: its header is the sender's.
    expect(ff.measured).toEqual([mp3]);
    expect(p.calls).toEqual([{ audio: { path: mp3, seconds: 42, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
    expect(ff.splits).toEqual([]);
  });

  // Task 5 review round 2: a voice note's conversion has its own, shorter timeout; meetings keep toMp3's 60 minutes.
  it.each(PROVIDERS)('%s: the conversion is given VOICE_CONVERT_TIMEOUT_MS, 5 minutes', async (id) => {
    const ff = new FakeFfmpeg();
    await run(make(new FakeProvider(id), ff), input());
    expect(ff.timeouts).toEqual([5 * 60_000]);
  });

  it("VOICE_CONVERT_TIMEOUT_MS is 5 minutes, inside the media queue's 15-minute claim", () => {
    expect(VOICE_CONVERT_TIMEOUT_MS).toBe(300_000);
    expect(VOICE_CONVERT_TIMEOUT_MS).toBeLessThan(15 * 60_000);
  });

  it.each(PROVIDERS)('%s: canSend is true for every file while ffmpeg is there, and false for every file without it', (id) => {
    const withFfmpeg = make(new FakeProvider(id));
    const without = make(new FakeProvider(id), null);
    for (const mime of MIMES) {
      expect(withFfmpeg.canSend(mime)).toBe(true);
      expect(without.canSend(mime)).toBe(false);
    }
  });

  it('canSendVoice, the pure rule the CLI uses without a key, is whether ffmpeg is there, and agrees with every transcriber', () => {
    for (const id of PROVIDERS) {
      for (const ffmpeg of [new FakeFfmpeg(), null]) {
        const t = make(new FakeProvider(id), ffmpeg);
        for (const mime of MIMES) {
          expect(canSendVoice(id, mime, ffmpeg !== null)).toBe(ffmpeg !== null);
          expect(canSendVoice(id, mime, ffmpeg !== null)).toBe(t.canSend(mime));
        }
      }
    }
  });

  it.each(PROVIDERS)('%s: without ffmpeg, prepare refuses every file as no_ffmpeg, touching no folder', async (id) => {
    const p = new FakeProvider(id);
    const e = await make(p, null).prepare(input()).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('no_ffmpeg');
    expect(existsSync(join(tmp, 'work'))).toBe(false);
    expect(p.calls).toEqual([]);
  });
});

describe('voiceTranscriber: prepare, the free step', () => {
  it.each(PROVIDERS)('%s: makes no provider call', async (id) => {
    const p = new FakeProvider(id);
    const prepared = await make(p).prepare(input());
    expect(p.calls).toEqual([]);
    prepared.dispose();
  });

  it('gives the measured length of the MP3', async () => {
    const ff = new FakeFfmpeg();
    ff.length = 61.5;
    const prepared = await make(new FakeProvider('sarvam'), ff).prepare(input());
    expect(prepared.measuredSeconds).toBe(61.5);
    expect(prepared.parts).toEqual([{ path: join(voiceDir(), 'audio.mp3'), seconds: 61.5, offset: 0, format: 'mp3' }]);
  });

  it('a measuring failure is fatal, and the folder is removed', async () => {
    const ff = new FakeFfmpeg();
    ff.secondsError = new AudioError('no_duration');
    await expect(make(new FakeProvider('sarvam'), ff).prepare(input())).rejects.toBe(ff.secondsError);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -3])('an MP3 measured as %s is refused as no_duration', async (length) => {
    const ff = new FakeFfmpeg();
    ff.length = length;
    const e = await make(new FakeProvider('elevenlabs'), ff).prepare(input()).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('no_duration');
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('VOICE_LENGTH_TOLERANCE_S is 5 seconds', () => {
    expect(VOICE_LENGTH_TOLERANCE_S).toBe(5);
  });

  describe.each(PROVIDERS)('too long (%s)', (id) => {
    it('a note measured at 2,000 s with maxSeconds 600 is refused as too_long: no provider call, no split, the folder removed', async () => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      ff.length = 2000;
      const e = await make(p, ff).prepare(input({ maxSeconds: 600 })).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AudioError);
      expect(codeOf(e)).toBe('too_long');
      // The conversion stopped at 606 s, so a long file is never converted (or sent) whole.
      expect(ff.conversions.map((c) => c.maxSeconds)).toEqual([606]);
      expect(p.calls).toEqual([]);
      expect(ff.splits).toEqual([]);
      expect(existsSync(voiceDir())).toBe(false);
    });

    it('604 s and 605 s pass with maxSeconds 600; 606 s, where the conversion stops, does not', async () => {
      for (const length of [604, 605]) {
        const ff = new FakeFfmpeg();
        ff.length = length;
        if (id === 'openai') ff.parts = [{ path: join(voiceDir(), 'parts', 'part-000.mp3'), seconds: length, offset: 0 }];
        const prepared = await make(new FakeProvider(id), ff).prepare(input({ maxSeconds: 600 }));
        expect(prepared.measuredSeconds).toBe(length);
        prepared.dispose();
      }
      const ff = new FakeFfmpeg();
      ff.length = 606;
      const e = await make(new FakeProvider(id), ff).prepare(input({ maxSeconds: 600 })).catch((x: unknown) => x);
      expect(codeOf(e)).toBe('too_long');
    });
  });

  it('a conversion that reached the -t limit is too_long even when the MP3 measures a fraction under it', async () => {
    const ff = new FakeFfmpeg();
    ff.length = 605.01; // above maxSeconds + tolerance, below the -t limit of 606
    const e = await make(new FakeProvider('sarvam'), ff).prepare(input({ maxSeconds: 600 })).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('too_long');
  });
});

describe('voiceTranscriber: OpenAI parts', () => {
  const parts = (): AudioPart[] => {
    const dir = join(voiceDir(), 'parts');
    return [
      { path: join(dir, 'part-000.mp3'), seconds: 210, offset: 0 },
      { path: join(dir, 'part-001.mp3'), seconds: 210, offset: 210 },
    ];
  };
  const openAi420 = () => {
    const ff = new FakeFfmpeg();
    ff.length = 420;
    ff.parts = parts();
    return ff;
  };

  it('splits a converted note of 420 s into 300 s parts, sends both in order and joins the text', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => result(said('pehla hissa'), 210), async () => result(said('doosra hissa'), 211)];
    const ff = openAi420();
    const r = await run(make(p, ff), input({ maxSeconds: 600 }));
    const mp3 = join(voiceDir(), 'audio.mp3');
    expect(ff.splits).toEqual([{ part: { path: mp3, seconds: 420, offset: 0, format: 'mp3' }, dir: join(voiceDir(), 'parts'), partSeconds: 300 }]);
    expect(p.calls.map((c) => c.audio)).toEqual(parts().map((x) => ({ ...x, format: 'mp3' })));
    expect(p.calls.every((c) => c.opts.diarize === false)).toBe(true);
    expect(r).toEqual({ provider: 'openai', model: 'm1', text: 'pehla hissa doosra hissa', billedSeconds: 421, forgetRef: null });
  });

  it('prepare gives the parts in order, and the measured length of the whole', async () => {
    const prepared = await make(new FakeProvider('openai'), openAi420()).prepare(input({ maxSeconds: 600 }));
    expect(prepared.measuredSeconds).toBe(420);
    expect(prepared.parts).toEqual(parts().map((x) => ({ ...x, format: 'mp3' })));
  });

  it('billedSeconds is null when one part does not report it', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => result(said('a'), 210), async () => result(said('b'), null)];
    expect((await run(make(p, openAi420()), input({ maxSeconds: 600 }))).billedSeconds).toBeNull();
  });

  it('a note of exactly 300 s is sent whole', async () => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    ff.length = 300;
    await run(make(p, ff), input({ maxSeconds: 600 }));
    expect(ff.splits).toEqual([]);
    expect(p.calls).toHaveLength(1);
  });

  it('a note of 301 s is split', async () => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    ff.length = 301;
    const dir = join(voiceDir(), 'parts');
    ff.parts = [{ path: join(dir, 'part-000.mp3'), seconds: 150.5, offset: 0 }, { path: join(dir, 'part-001.mp3'), seconds: 150.5, offset: 150.5 }];
    await run(make(p, ff), input({ maxSeconds: 600 }));
    expect(ff.splits).toEqual([{ part: { path: join(voiceDir(), 'audio.mp3'), seconds: 301, offset: 0, format: 'mp3' }, dir, partSeconds: 300 }]);
    expect(p.calls).toHaveLength(2);
  });

  it('a failing second part is not retried, the first is not sent again, and the error is an SttPartialError', async () => {
    const p = new FakeProvider('openai');
    const err = new SttHttpError(503, 'down');
    p.script = [async () => result(said('a'), 210), async () => {
      throw err;
    }];
    const e = await run(make(p, openAi420()), input({ maxSeconds: 600 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SttPartialError);
    expect(e).not.toBeInstanceOf(SttHttpError);
    expect((e as SttPartialError).code).toBe('partial');
    expect((e as SttPartialError).partsDone).toBe(1);
    expect((e as SttPartialError).cause).toBe(err);
    expect(p.calls.map((c) => c.audio.path)).toEqual(parts().map((x) => x.path));
  });

  it('a failing first part reaches the caller unchanged, and the second is never sent', async () => {
    const p = new FakeProvider('openai');
    const err = new SttHttpError(503, 'down');
    p.script = [async () => {
      throw err;
    }];
    await expect(run(make(p, openAi420()), input({ maxSeconds: 600 }))).rejects.toBe(err);
    expect(p.calls).toHaveLength(1);
  });

  describe('inside withSttHold, with a real SpendGuard', () => {
    const setup = () => {
      const db = seededDb();
      const spend = new SpendGuard({ db, clock: manualClock('2026-10-19T08:00:00Z'), capUsd: 1 });
      const rows = () => db.prepare('SELECT kind, usd, detail FROM spend ORDER BY id').all() as { kind: string; usd: number; detail: string }[];
      return { spend, rows };
    };
    /**
     * The extractor's shape: prepare outside the hold, then transcribe inside it. onBooked is passed because withSttHold
     * books a failed call only when it is given (src/stt/paidStt.ts; reported, not changed here).
     */
    const held = async (p: FakeProvider, spend: SpendGuard) => {
      const booked: SttBooking[] = [];
      const t = make(p, openAi420());
      const bound = 400;
      const prepared = await t.prepare(input({ maxSeconds: 600 }));
      const ceiling = t.ceilingUsd(Math.max(bound, prepared.measuredSeconds));
      const out = await withSttHold(spend, ceiling, 'media 7', async () => {
        const r = await t.transcribe(prepared);
        return { result: r, costUsd: t.costUsd({ maxSeconds: bound, billedSeconds: r.billedSeconds, measuredSeconds: prepared.measuredSeconds }) };
      }, { onBooked: (b) => booked.push(b) }).catch((x: unknown) => x);
      return { out, ceiling, booked };
    };

    it('part 1 billed and part 2 failing with 503: exactly one stt row at the ceiling, and the error is an SttPartialError', async () => {
      const { spend, rows } = setup();
      const p = new FakeProvider('openai');
      const err = new SttHttpError(503, 'down');
      p.script = [async () => result(said('a'), 210), async () => {
        throw err;
      }];
      const { out, ceiling, booked } = await held(p, spend);
      expect(ceiling).toBe(voiceCeilingUsd('openai', 420, INR));
      expect(out).toBeInstanceOf(SttPartialError);
      expect((out as SttPartialError).cause).toBe(err);
      expect(rows()).toEqual([{ kind: 'stt', usd: ceiling, detail: 'media 7 (unknown, estimated)' }]);
      expect(booked).toEqual([{ outcome: 'ceiling', usd: ceiling }]);
    });

    it('part 1 failing with 503 books nothing, as before', async () => {
      const { spend, rows } = setup();
      const p = new FakeProvider('openai');
      const err = new SttHttpError(503, 'down');
      p.script = [async () => {
        throw err;
      }];
      const { out, booked } = await held(p, spend);
      expect(out).toBe(err);
      expect(rows()).toEqual([]);
      expect(booked).toEqual([{ outcome: 'none', usd: 0 }]);
    });
  });
});

describe('voiceTranscriber: text', () => {
  const textOf = async (segments: Segment[]) => {
    const p = new FakeProvider('sarvam');
    p.script = [async () => result(segments)];
    return (await run(make(p), input())).text;
  };

  it('joins the segments with single spaces and trims', async () => {
    expect(await textOf(said('  pehle  ', 'phir', ' ', 'baad mein '))).toBe('pehle phir baad mein');
  });

  it('gives an empty text when no speech was heard', async () => {
    expect(await textOf([])).toBe('');
    expect(await textOf(said('', '   ', '\n'))).toBe('');
  });

  it('keeps Devanagari and Latin words unchanged', async () => {
    expect(await textOf(said('पेमेंट ₹42,000', 'bhej diya'))).toBe('पेमेंट ₹42,000 bhej diya');
  });

  it('reports the provider, model and billed seconds of a single call', async () => {
    const p = new FakeProvider('elevenlabs');
    p.script = [async () => result(said('ok'), 44.5)];
    expect(await run(make(p), input())).toEqual({ provider: 'elevenlabs', model: 'm1', text: 'ok', billedSeconds: 44.5, forgetRef: null });
  });
});

describe('voiceTranscriber: cost', () => {
  it.each(['sarvam', 'elevenlabs', 'openai'] as const)('%s: ceilingUsd is the list price without speaker labels', (id) => {
    const t = make(new FakeProvider(id));
    expect(t.ceilingUsd(600)).toBeCloseTo(costUsd(modelFor(id, false), 600, INR), 12);
    expect(t.ceilingUsd(600)).toBe(voiceCeilingUsd(id, 600, INR));
  });

  it("converts Sarvam's rupees at INR_PER_USD", () => {
    expect(make(new FakeProvider('sarvam')).ceilingUsd(3600)).toBeCloseTo(30 / 88, 12);
    expect(voiceTranscriber(new FakeProvider('sarvam'), { inrPerUsd: 100, ffmpeg: null, tmpDir: tmp }).ceilingUsd(3600)).toBeCloseTo(0.3, 12);
  });

  const cost = (t: VoiceTranscriber, maxSeconds: number, billedSeconds: number | null, measuredSeconds: number | null) =>
    t.costUsd({ maxSeconds, billedSeconds, measuredSeconds });

  it('prices billed seconds first, then the measured length, then maxSeconds (the bound)', () => {
    const t = make(new FakeProvider('elevenlabs'));
    const at = (s: number) => costUsd(modelFor('elevenlabs', false), s, INR);
    expect(cost(t, 600, 45, 47)).toBeCloseTo(at(45), 12);
    expect(cost(t, 600, null, 47)).toBeCloseTo(at(47), 12);
    // The measured length is what was sent: it wins over the bound.
    expect(cost(t, 40, null, 47)).toBeCloseTo(at(47), 12);
    expect(cost(t, 40, null, null)).toBeCloseTo(at(40), 12);
    expect(cost(t, 40, 0, 47)).toBe(0);
    expect(cost(t, 40, null, 0)).toBe(0);
  });

  it('takes no declared length: the sender cannot lower the booking (Task 5 review round 1)', () => {
    const t = make(new FakeProvider('sarvam'));
    const at = (s: number) => costUsd(modelFor('sarvam', false), s, INR);
    // A Sarvam-like answer (no billed seconds) with no measured length books the whole bound, whatever was declared.
    expect(t.costUsd({ maxSeconds: 60, billedSeconds: null, measuredSeconds: null, declaredSeconds: 0 } as never)).toBeCloseTo(at(60), 12);
    expect(at(60)).toBeGreaterThan(0);
  });

  it('ignores a negative, NaN or infinite billed or measured length', () => {
    const t = make(new FakeProvider('openai'));
    const at = (s: number) => costUsd(modelFor('openai', false), s, INR);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cost(t, 600, bad, 47)).toBeCloseTo(at(47), 12);
      expect(cost(t, 600, bad, bad)).toBeCloseTo(at(600), 12);
      expect(cost(t, 40, null, bad)).toBeCloseTo(at(40), 12);
    }
  });
});

describe('voiceTranscriber: forgetRef', () => {
  const refOf = async (ref: string | undefined) => {
    const p = new CopyingProvider('elevenlabs');
    p.script = [async () => result(said('ok'), 3, ref)];
    return (await run(make(p), input())).forgetRef;
  };

  it('takes the provider id of its stored copy when it is 1 to 200 characters', async () => {
    expect(await refOf('tr-1')).toBe('tr-1');
    expect(await refOf('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('is null when there is none, it is empty or it is too long', async () => {
    expect(await refOf(undefined)).toBeNull();
    expect(await refOf('')).toBeNull();
    expect(await refOf('x'.repeat(201))).toBeNull();
  });

  it('is null for a provider that keeps no copies', async () => {
    const p = new FakeProvider('sarvam');
    p.script = [async () => result(said('ok'), null, 'tr-1')];
    expect((await run(make(p), input())).forgetRef).toBeNull();
  });

  it('canForget mirrors forgetById, and forget passes the ref on', async () => {
    expect(make(new FakeProvider('sarvam')).canForget).toBe(false);
    const p = new CopyingProvider('elevenlabs');
    const t = make(p);
    expect(t.canForget).toBe(true);
    await t.forget('tr-9');
    expect(p.forgotten).toEqual(['tr-9']);
    await expect(make(new FakeProvider('openai')).forget('tr-9')).resolves.toBeUndefined();
  });
});

describe('voiceTranscriber: temporary files', () => {
  it('keeps the converted file until transcribe, and removes the voice folder after it', async () => {
    const ff = new FakeFfmpeg();
    let during = false;
    const p = new FakeProvider('openai');
    p.script = [async () => {
      during = existsSync(join(voiceDir(), 'audio.mp3'));
      return result(said('ok'));
    }];
    const t = make(p, ff);
    const prepared = await t.prepare(input());
    expect(existsSync(join(voiceDir(), 'audio.mp3'))).toBe(true);
    await t.transcribe(prepared);
    expect(during).toBe(true);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes the voice folder after the provider fails', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => {
      throw new SttHttpError(500, 'x');
    }];
    await expect(run(make(p), input())).rejects.toBeInstanceOf(SttHttpError);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes the voice folder after ffmpeg fails', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    await expect(make(new FakeProvider('openai'), ff).prepare(input())).rejects.toBe(ff.toMp3Error);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes a folder left by an earlier crash before converting', async () => {
    mkdirSync(join(voiceDir(), 'parts'), { recursive: true });
    writeFileSync(join(voiceDir(), 'audio.mp3'), 'stale');
    writeFileSync(join(voiceDir(), 'parts', '.done'), '');
    const ff = new FakeFfmpeg();
    let leftover: boolean[] = [];
    ff.onToMp3 = () => {
      leftover = [existsSync(join(voiceDir(), 'audio.mp3')), existsSync(join(voiceDir(), 'parts'))];
    };
    await run(make(new FakeProvider('openai'), ff), input());
    expect(leftover).toEqual([false, false]);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it("removes only its own note's folder", async () => {
    mkdirSync(voiceDir(8), { recursive: true });
    await run(make(new FakeProvider('openai')), input());
    expect(existsSync(voiceDir())).toBe(false);
    expect(existsSync(voiceDir(8))).toBe(true);
  });

  it('dispose removes the folder, and may be called twice', async () => {
    const prepared = await make(new FakeProvider('openai')).prepare(input());
    expect(existsSync(voiceDir())).toBe(true);
    prepared.dispose();
    expect(existsSync(voiceDir())).toBe(false);
    expect(() => prepared.dispose()).not.toThrow();
    expect(existsSync(voiceDir())).toBe(false);
  });

  describe.each(PROVIDERS)('transcribe disposes (%s)', (id) => {
    it('once on success', async () => {
      const t = make(new FakeProvider(id));
      const prepared = await t.prepare(input());
      const dispose = vi.spyOn(prepared, 'dispose');
      await t.transcribe(prepared);
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('once on failure', async () => {
      const p = new FakeProvider(id);
      p.script = [async () => {
        throw new SttHttpError(500, 'x');
      }];
      const t = make(p);
      const prepared = await t.prepare(input());
      const dispose = vi.spyOn(prepared, 'dispose');
      await expect(t.transcribe(prepared)).rejects.toBeInstanceOf(SttHttpError);
      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  it.each([Number.NaN, -1, 1.5, 0])('refuses a media id of %s before touching any folder', async (mediaId) => {
    const p = new FakeProvider('sarvam');
    const ff = new FakeFfmpeg();
    await expect(make(p, ff).prepare(input({ mediaId }))).rejects.toThrow(/media id/);
    expect(ff.conversions).toEqual([]);
    expect(existsSync(join(tmp, 'work'))).toBe(false);
    expect(p.calls).toEqual([]);
  });
});

describe('voiceTranscriber: errors', () => {
  it.each([
    new SttHttpError(429, 'busy'),
    new SttHttpError(401, 'key'),
    new Error('anything'),
  ])('a provider error reaches the caller unchanged, after exactly one call (%s)', async (err) => {
    const p = new FakeProvider('elevenlabs');
    p.script = [async () => {
      throw err;
    }];
    await expect(run(make(p), input())).rejects.toBe(err);
    expect(p.calls).toHaveLength(1);
  });

  it('an AudioError from ffmpeg reaches the caller unchanged, and nothing is sent', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    const p = new FakeProvider('sarvam');
    await expect(make(p, ff).prepare(input())).rejects.toBe(ff.toMp3Error);
    expect(p.calls).toEqual([]);
  });
});

describe('createVoiceTranscriber', () => {
  const KEY = 'test-voice-key';
  const env = (provider: string) => parseEnv({ STT_PROVIDER: provider, STT_API_KEY: KEY, INR_PER_USD: '88' });
  const deps = () => ({ ffmpeg: new FakeFfmpeg(), tmpDir: tmp });

  it('is null when speech-to-text is off, and builds no adapter', () => {
    expect(createVoiceTranscriber(parseEnv({}), deps())).toBeNull();
    expect(built).toEqual([]);
  });

  it.each([
    ['sarvam', { maxWaitMs: 10 * 60_000 }],
    ['elevenlabs', { timeoutMs: 5 * 60_000 }],
    ['openai', { timeoutMs: 5 * 60_000 }],
  ] as const)('builds %s with the voice timeouts and STT_API_KEY', (provider, timeout) => {
    const t = createVoiceTranscriber(env(provider), deps())!;
    expect(t.provider).toBe(provider);
    expect(built).toEqual([{ id: provider, opts: { apiKey: KEY, ...timeout } }]);
    expect(t.ceilingUsd(600)).toBe(voiceCeilingUsd(provider, 600, 88));
  });

  it.each(PROVIDERS)('%s: passes deps.ffmpeg on: with it every file can be sent, without it none', (provider) => {
    for (const mime of ['audio/ogg; codecs=opus', 'audio/mpeg', 'audio/aac']) {
      expect(createVoiceTranscriber(env(provider), deps())!.canSend(mime)).toBe(true);
      expect(createVoiceTranscriber(env(provider), { ...deps(), ffmpeg: null })!.canSend(mime)).toBe(false);
    }
  });

  it('VOICE_STT_TIMEOUTS are 5, 5 and 10 minutes', () => {
    expect(VOICE_STT_TIMEOUTS).toEqual({ elevenlabsMs: 300_000, openaiMs: 300_000, sarvamWaitMs: 600_000 });
  });

  it('passes deps.http to the adapter: ElevenLabs gets the voice note converted to MP3, with the key, and deletes its copy', async () => {
    const note = join(tmp, 'note.ogg');
    writeFileSync(note, 'OggS');
    const sent: { method: string; key: string | null; fileName: string | null; fileType: string | null; diarize: string | null }[] = [];
    const http: HttpFetch = async (_url, init) => {
      const form = init.body instanceof FormData ? init.body : null;
      const file = form?.get('file');
      sent.push({
        method: init.method ?? 'GET',
        key: new Headers(init.headers).get('xi-api-key'),
        fileName: file instanceof File ? file.name : null,
        fileType: file instanceof File ? file.type : null,
        diarize: (form?.get('diarize') as string | null) ?? null,
      });
      if (init.method === 'DELETE') return new Response(null, { status: 200 });
      return Response.json({ text: 'haan', words: [{ text: 'haan', type: 'word', start: 0, end: 1 }], audio_duration_secs: 3, transcription_id: 'tr1' });
    };
    const t = createVoiceTranscriber(env('elevenlabs'), { ...deps(), http })!;
    const r = await run(t, { mediaId: 3, path: note, maxSeconds: 60 });
    expect(r).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', text: 'haan', billedSeconds: 3, forgetRef: 'tr1' });
    await t.forget(r.forgetRef!);
    expect(sent).toEqual([
      { method: 'POST', key: KEY, fileName: 'audio.mp3', fileType: 'audio/mpeg', diarize: 'false' },
      { method: 'DELETE', key: KEY, fileName: null, fileType: null, diarize: null },
    ]);
  });
});

describe('sizeBoundSeconds', () => {
  it('is ceil(bytes × 8 / 12,000)', () => {
    expect(sizeBoundSeconds(0)).toBe(0);
    expect(sizeBoundSeconds(900_000)).toBe(600);
    expect(sizeBoundSeconds(1)).toBe(1);
    expect(sizeBoundSeconds(1500)).toBe(1);
    expect(sizeBoundSeconds(1501)).toBe(2);
  });
});

describe('voiceCeilingUsd', () => {
  it.each(['sarvam', 'elevenlabs', 'openai'] as const)('%s: needs no key and equals the transcriber ceiling', (id) => {
    expect(voiceCeilingUsd(id, 45, INR)).toBe(make(new FakeProvider(id)).ceilingUsd(45));
    expect(voiceCeilingUsd(id, 45, INR)).toBeCloseTo(costUsd(modelFor(id, false), 45, INR), 12);
  });
});
