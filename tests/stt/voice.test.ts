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
  createVoiceTranscriber, sizeBoundSeconds, SttPartialError, VOICE_LENGTH_TOLERANCE_S, VOICE_STT_TIMEOUTS, voiceCeilingUsd,
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

/** Never starts a program: toMp3 writes a file, seconds returns a set length, split returns set parts. */
class FakeFfmpeg extends Ffmpeg {
  readonly conversions: { input: string; output: string }[] = [];
  readonly splits: { part: AudioPart; dir: string; partSeconds: number }[] = [];
  /** Every file measured, in order. */
  readonly measured: string[] = [];
  length = 42;
  parts: AudioPart[] = [];
  toMp3Error: Error | null = null;
  secondsError: Error | null = null;
  /** Called at the start of toMp3, to look at the folder as it is then. */
  onToMp3: () => void = () => {};
  constructor() {
    super('ffmpeg-never-run', async () => {
      throw new Error('no program is run in these tests');
    });
  }
  override async toMp3(input: string, output: string): Promise<void> {
    this.onToMp3();
    this.conversions.push({ input, output });
    if (this.toMp3Error) throw this.toMp3Error;
    writeFileSync(output, 'mp3');
  }
  override async seconds(input: string): Promise<number> {
    this.measured.push(input);
    if (this.secondsError) throw this.secondsError;
    return this.length;
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

const input = (mimeType: string | null, o: Partial<VoiceInput> = {}): VoiceInput => ({
  mediaId: 7, path: join(tmp, 'media', 'note.ogg'), mimeType, maxSeconds: 120, ...o,
});
const voiceDir = (id = 7) => join(tmp, 'work', `voice-${id}`);
const make = (provider: SttProvider, ffmpeg: Ffmpeg | null = new FakeFfmpeg()): VoiceTranscriber =>
  voiceTranscriber(provider, { inrPerUsd: INR, ffmpeg, tmpDir: join(tmp, 'work') });
/** Both steps, as the extractor runs them (without the hold). */
const run = async (t: VoiceTranscriber, i: VoiceInput): Promise<VoiceResult> => t.transcribe(await t.prepare(i));
const codeOf = (e: unknown): string | null => (e instanceof AudioError ? e.code : null);

const OGG_MIMES = ['audio/ogg; codecs=opus', 'audio/ogg ; codecs=opus', 'audio/opus', 'AUDIO/OGG; Codecs=Opus'];
const MP3_MIMES = ['audio/mpeg', 'audio/mp3'];
const OTHER_MIMES = ['audio/mp4', 'audio/aac', 'audio/amr', 'application/octet-stream', null, 'audio/ogg-x', ''];

describe('voiceTranscriber: choosing the format', () => {
  describe.each(['sarvam', 'elevenlabs'] as const)('%s', (id) => {
    it.each(OGG_MIMES)('sends %s as it is, as ogg, without speaker labels, measured by ffmpeg but not converted', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await run(make(p, ff), input(mime));
      expect(p.calls).toEqual([{ audio: { path: input(mime).path, seconds: 42, offset: 0, format: 'ogg' }, opts: { diarize: false } }]);
      expect(ff.conversions).toEqual([]);
      expect(ff.measured).toEqual([input(mime).path]);
    });

    it.each(MP3_MIMES)('sends %s as it is, as mp3', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await run(make(p, ff), input(mime));
      expect(p.calls).toEqual([{ audio: { path: input(mime).path, seconds: 42, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
      expect(ff.conversions).toEqual([]);
    });

    it.each(OTHER_MIMES)('converts %s to MP3 first, then sends it as mp3', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await run(make(p, ff), input(mime));
      const mp3 = join(voiceDir(), 'audio.mp3');
      expect(ff.conversions).toEqual([{ input: input(mime).path, output: mp3 }]);
      expect(ff.measured).toEqual([mp3]);
      expect(p.calls).toEqual([{ audio: { path: mp3, seconds: 42, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
      expect(ff.splits).toEqual([]);
    });
  });

  it.each([...OGG_MIMES, ...MP3_MIMES, ...OTHER_MIMES])('openai: converts %s first', async (mime) => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    await run(make(p, ff), input(mime));
    const mp3 = join(voiceDir(), 'audio.mp3');
    expect(ff.conversions).toEqual([{ input: input(mime).path, output: mp3 }]);
    expect(p.calls).toEqual([{ audio: { path: mp3, seconds: 42, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
  });

  it.each(['sarvam', 'elevenlabs', 'openai'] as const)('%s: canSend is true for every file while ffmpeg is there', (id) => {
    const t = make(new FakeProvider(id));
    for (const mime of [...OGG_MIMES, ...MP3_MIMES, ...OTHER_MIMES]) expect(t.canSend(mime)).toBe(true);
  });

  it.each(['sarvam', 'elevenlabs'] as const)('%s: without ffmpeg, canSend is true only for Ogg and MP3', (id) => {
    const t = make(new FakeProvider(id), null);
    for (const mime of [...OGG_MIMES, ...MP3_MIMES]) expect(t.canSend(mime)).toBe(true);
    for (const mime of OTHER_MIMES) expect(t.canSend(mime)).toBe(false);
  });

  it('openai: without ffmpeg, canSend is always false', () => {
    const t = make(new FakeProvider('openai'), null);
    for (const mime of [...OGG_MIMES, ...MP3_MIMES, ...OTHER_MIMES]) expect(t.canSend(mime)).toBe(false);
  });

  it('without ffmpeg, a file that needs converting is refused by prepare', async () => {
    const p = new FakeProvider('sarvam');
    const e = await make(p, null).prepare(input('audio/aac')).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('no_ffmpeg');
    expect(p.calls).toEqual([]);
  });
});

describe('voiceTranscriber: prepare, the free step', () => {
  it('makes no provider call on any path', async () => {
    for (const [id, mime] of [['sarvam', 'audio/ogg'], ['sarvam', 'audio/aac'], ['openai', 'audio/ogg']] as const) {
      const p = new FakeProvider(id);
      const prepared = await make(p).prepare(input(mime));
      expect(p.calls).toEqual([]);
      prepared.dispose();
    }
  });

  it('measures the original sent as it is when ffmpeg is there', async () => {
    const ff = new FakeFfmpeg();
    ff.length = 61.5;
    const prepared = await make(new FakeProvider('sarvam'), ff).prepare(input('audio/ogg'));
    expect(ff.measured).toEqual([input('audio/ogg').path]);
    expect(prepared.measuredSeconds).toBe(61.5);
    expect(prepared.parts).toEqual([{ path: input('audio/ogg').path, seconds: 61.5, offset: 0, format: 'ogg' }]);
  });

  it('does not measure without ffmpeg: measuredSeconds is null and the part is maxSeconds long', async () => {
    const prepared = await make(new FakeProvider('elevenlabs'), null).prepare(input('audio/mpeg'));
    expect(prepared.measuredSeconds).toBeNull();
    expect(prepared.parts).toEqual([{ path: input('audio/mpeg').path, seconds: 120, offset: 0, format: 'mp3' }]);
  });

  it.each([new AudioError('no_duration'), new Error('anything')])('a measuring failure on the as-is path is not fatal (%s)', async (err) => {
    const ff = new FakeFfmpeg();
    ff.secondsError = err;
    const p = new FakeProvider('sarvam');
    const t = make(p, ff);
    const prepared = await t.prepare(input('audio/ogg'));
    expect(prepared.measuredSeconds).toBeNull();
    expect(prepared.parts).toEqual([{ path: input('audio/ogg').path, seconds: 120, offset: 0, format: 'ogg' }]);
    await t.transcribe(prepared);
    expect(p.calls).toHaveLength(1);
  });

  it('a measuring failure on the conversion path is fatal, and the folder is removed', async () => {
    const ff = new FakeFfmpeg();
    ff.secondsError = new AudioError('no_duration');
    await expect(make(new FakeProvider('openai'), ff).prepare(input('audio/ogg'))).rejects.toBe(ff.secondsError);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -3])('a converted file measured as %s is refused as no_duration', async (length) => {
    const ff = new FakeFfmpeg();
    ff.length = length;
    const e = await make(new FakeProvider('openai'), ff).prepare(input('audio/ogg')).catch((x: unknown) => x);
    expect(codeOf(e)).toBe('no_duration');
    expect(existsSync(voiceDir())).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -3])('an original measured as %s counts as not measured', async (length) => {
    const ff = new FakeFfmpeg();
    ff.length = length;
    const prepared = await make(new FakeProvider('sarvam'), ff).prepare(input('audio/ogg'));
    expect(prepared.measuredSeconds).toBeNull();
    expect(prepared.parts[0]!.seconds).toBe(120);
  });

  it('VOICE_LENGTH_TOLERANCE_S is 5 seconds', () => {
    expect(VOICE_LENGTH_TOLERANCE_S).toBe(5);
  });

  describe.each([
    ['converted', 'sarvam', 'audio/aac'],
    ['converted for OpenAI', 'openai', 'audio/ogg'],
    ['sent as it is', 'elevenlabs', 'audio/ogg'],
  ] as const)('too long (%s)', (_name, id, mime) => {
    it('a note measured at 2,000 s with maxSeconds 600 is refused as too_long: no provider call, no split, the folder removed', async () => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      ff.length = 2000;
      const e = await make(p, ff).prepare(input(mime, { maxSeconds: 600 })).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AudioError);
      expect(codeOf(e)).toBe('too_long');
      expect(p.calls).toEqual([]);
      expect(ff.splits).toEqual([]);
      expect(existsSync(voiceDir())).toBe(false);
    });

    it('604 s and 605 s pass with maxSeconds 600, 606 s does not', async () => {
      for (const length of [604, 605]) {
        const ff = new FakeFfmpeg();
        ff.length = length;
        if (id === 'openai') ff.parts = [{ path: join(voiceDir(), 'parts', 'part-000.mp3'), seconds: length, offset: 0 }];
        const prepared = await make(new FakeProvider(id), ff).prepare(input(mime, { maxSeconds: 600 }));
        expect(prepared.measuredSeconds).toBe(length);
        prepared.dispose();
      }
      const ff = new FakeFfmpeg();
      ff.length = 606;
      const e = await make(new FakeProvider(id), ff).prepare(input(mime, { maxSeconds: 600 })).catch((x: unknown) => x);
      expect(codeOf(e)).toBe('too_long');
    });
  });

  it('a note sent as it is without ffmpeg is never refused as too long: it cannot be measured', async () => {
    const prepared = await make(new FakeProvider('sarvam'), null).prepare(input('audio/ogg', { maxSeconds: 600 }));
    expect(prepared.measuredSeconds).toBeNull();
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
    const r = await run(make(p, ff), input('audio/ogg', { maxSeconds: 600 }));
    const mp3 = join(voiceDir(), 'audio.mp3');
    expect(ff.splits).toEqual([{ part: { path: mp3, seconds: 420, offset: 0, format: 'mp3' }, dir: join(voiceDir(), 'parts'), partSeconds: 300 }]);
    expect(p.calls.map((c) => c.audio)).toEqual(parts().map((x) => ({ ...x, format: 'mp3' })));
    expect(p.calls.every((c) => c.opts.diarize === false)).toBe(true);
    expect(r).toEqual({ provider: 'openai', model: 'm1', text: 'pehla hissa doosra hissa', billedSeconds: 421, forgetRef: null });
  });

  it('prepare gives the parts in order, and the measured length of the whole', async () => {
    const prepared = await make(new FakeProvider('openai'), openAi420()).prepare(input('audio/ogg', { maxSeconds: 600 }));
    expect(prepared.measuredSeconds).toBe(420);
    expect(prepared.parts).toEqual(parts().map((x) => ({ ...x, format: 'mp3' })));
  });

  it('billedSeconds is null when one part does not report it', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => result(said('a'), 210), async () => result(said('b'), null)];
    expect((await run(make(p, openAi420()), input('audio/ogg', { maxSeconds: 600 }))).billedSeconds).toBeNull();
  });

  it('a note of exactly 300 s is sent whole', async () => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    ff.length = 300;
    await run(make(p, ff), input('audio/ogg', { maxSeconds: 600 }));
    expect(ff.splits).toEqual([]);
    expect(p.calls).toHaveLength(1);
  });

  it('a note of 301 s is split', async () => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    ff.length = 301;
    const dir = join(voiceDir(), 'parts');
    ff.parts = [{ path: join(dir, 'part-000.mp3'), seconds: 150.5, offset: 0 }, { path: join(dir, 'part-001.mp3'), seconds: 150.5, offset: 150.5 }];
    await run(make(p, ff), input('audio/ogg', { maxSeconds: 600 }));
    expect(ff.splits).toEqual([{ part: { path: join(voiceDir(), 'audio.mp3'), seconds: 301, offset: 0, format: 'mp3' }, dir, partSeconds: 300 }]);
    expect(p.calls).toHaveLength(2);
  });

  it('a failing second part is not retried, the first is not sent again, and the error is an SttPartialError', async () => {
    const p = new FakeProvider('openai');
    const err = new SttHttpError(503, 'down');
    p.script = [async () => result(said('a'), 210), async () => {
      throw err;
    }];
    const e = await run(make(p, openAi420()), input('audio/ogg', { maxSeconds: 600 })).catch((x: unknown) => x);
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
    await expect(run(make(p, openAi420()), input('audio/ogg', { maxSeconds: 600 }))).rejects.toBe(err);
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
      const prepared = await t.prepare(input('audio/ogg', { maxSeconds: 600 }));
      const ceiling = t.ceilingUsd(Math.max(bound, prepared.measuredSeconds ?? 0));
      const out = await withSttHold(spend, ceiling, 'media 7', async () => {
        const r = await t.transcribe(prepared);
        return { result: r, costUsd: t.costUsd({ maxSeconds: bound, billedSeconds: r.billedSeconds, declaredSeconds: null, measuredSeconds: prepared.measuredSeconds }) };
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
    return (await run(make(p), input('audio/ogg'))).text;
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
    expect(await run(make(p), input('audio/ogg'))).toEqual({ provider: 'elevenlabs', model: 'm1', text: 'ok', billedSeconds: 44.5, forgetRef: null });
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

  const cost = (t: VoiceTranscriber, maxSeconds: number, billedSeconds: number | null, declaredSeconds: number | null, measuredSeconds: number | null) =>
    t.costUsd({ maxSeconds, billedSeconds, declaredSeconds, measuredSeconds });

  it('prices billed seconds first, then the measured length, then the lower of the bound and the declared length', () => {
    const t = make(new FakeProvider('elevenlabs'));
    const at = (s: number) => costUsd(modelFor('elevenlabs', false), s, INR);
    expect(cost(t, 600, 45, 50, 47)).toBeCloseTo(at(45), 12);
    expect(cost(t, 600, null, 50, 47)).toBeCloseTo(at(47), 12);
    // The measured length is what was sent: it wins over the bound and the declared length alike.
    expect(cost(t, 40, null, 50, 47)).toBeCloseTo(at(47), 12);
    expect(cost(t, 600, null, 50, null)).toBeCloseTo(at(50), 12);
    expect(cost(t, 40, null, 50, null)).toBeCloseTo(at(40), 12);
    expect(cost(t, 40, null, null, null)).toBeCloseTo(at(40), 12);
    expect(cost(t, 40, 0, 50, 47)).toBe(0);
    expect(cost(t, 40, null, 50, 0)).toBe(0);
  });

  it('ignores a negative, NaN or infinite billed, measured or declared length', () => {
    const t = make(new FakeProvider('openai'));
    const at = (s: number) => costUsd(modelFor('openai', false), s, INR);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cost(t, 600, bad, 50, 47)).toBeCloseTo(at(47), 12);
      expect(cost(t, 600, bad, 50, bad)).toBeCloseTo(at(50), 12);
      expect(cost(t, 40, null, bad, null)).toBeCloseTo(at(40), 12);
      expect(cost(t, 40, bad, bad, bad)).toBeCloseTo(at(40), 12);
    }
  });
});

describe('voiceTranscriber: forgetRef', () => {
  const refOf = async (ref: string | undefined) => {
    const p = new CopyingProvider('elevenlabs');
    p.script = [async () => result(said('ok'), 3, ref)];
    return (await run(make(p), input('audio/ogg'))).forgetRef;
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
    expect((await run(make(p), input('audio/ogg'))).forgetRef).toBeNull();
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
    const prepared = await t.prepare(input('audio/ogg'));
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
    await expect(run(make(p), input('audio/ogg'))).rejects.toBeInstanceOf(SttHttpError);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes the voice folder after ffmpeg fails', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    await expect(make(new FakeProvider('openai'), ff).prepare(input('audio/ogg'))).rejects.toBe(ff.toMp3Error);
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
    await run(make(new FakeProvider('openai'), ff), input('audio/ogg'));
    expect(leftover).toEqual([false, false]);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('a note sent as it is touches no folder, and its dispose removes nothing', async () => {
    mkdirSync(voiceDir(), { recursive: true });
    const t = make(new FakeProvider('sarvam'));
    const prepared = await t.prepare(input('audio/ogg'));
    expect(existsSync(voiceDir())).toBe(true);
    await t.transcribe(prepared);
    prepared.dispose();
    expect(existsSync(voiceDir())).toBe(true);
  });

  it("removes only its own note's folder", async () => {
    mkdirSync(voiceDir(8), { recursive: true });
    await run(make(new FakeProvider('openai')), input('audio/ogg'));
    expect(existsSync(voiceDir())).toBe(false);
    expect(existsSync(voiceDir(8))).toBe(true);
  });

  it('dispose removes the folder, and may be called twice', async () => {
    const prepared = await make(new FakeProvider('openai')).prepare(input('audio/ogg'));
    expect(existsSync(voiceDir())).toBe(true);
    prepared.dispose();
    expect(existsSync(voiceDir())).toBe(false);
    expect(() => prepared.dispose()).not.toThrow();
    expect(existsSync(voiceDir())).toBe(false);
  });

  describe.each([['converted', 'openai', 'audio/ogg'], ['sent as it is', 'sarvam', 'audio/ogg']] as const)('transcribe disposes (%s)', (_name, id, mime) => {
    it('once on success', async () => {
      const t = make(new FakeProvider(id));
      const prepared = await t.prepare(input(mime));
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
      const prepared = await t.prepare(input(mime));
      const dispose = vi.spyOn(prepared, 'dispose');
      await expect(t.transcribe(prepared)).rejects.toBeInstanceOf(SttHttpError);
      expect(dispose).toHaveBeenCalledOnce();
    });
  });

  it.each([Number.NaN, -1, 1.5, 0])('refuses a media id of %s before touching any folder', async (mediaId) => {
    const p = new FakeProvider('sarvam');
    const ff = new FakeFfmpeg();
    await expect(make(p, ff).prepare(input('audio/aac', { mediaId }))).rejects.toThrow(/media id/);
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
    await expect(run(make(p), input('audio/ogg'))).rejects.toBe(err);
    expect(p.calls).toHaveLength(1);
  });

  it('an AudioError from ffmpeg reaches the caller unchanged, and nothing is sent', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    const p = new FakeProvider('sarvam');
    await expect(make(p, ff).prepare(input('audio/aac'))).rejects.toBe(ff.toMp3Error);
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

  it('passes deps.ffmpeg on: with it a file can be converted, without it not', () => {
    expect(createVoiceTranscriber(env('elevenlabs'), deps())!.canSend('audio/aac')).toBe(true);
    expect(createVoiceTranscriber(env('openai'), deps())!.canSend('audio/ogg')).toBe(true);
    expect(createVoiceTranscriber(env('elevenlabs'), { ...deps(), ffmpeg: null })!.canSend('audio/aac')).toBe(false);
    expect(createVoiceTranscriber(env('openai'), { ...deps(), ffmpeg: null })!.canSend('audio/ogg')).toBe(false);
  });

  it('VOICE_STT_TIMEOUTS are 5, 5 and 10 minutes', () => {
    expect(VOICE_STT_TIMEOUTS).toEqual({ elevenlabsMs: 300_000, openaiMs: 300_000, sarvamWaitMs: 600_000 });
  });

  it('passes deps.http to the adapter: ElevenLabs gets the voice note as Ogg, with the key, and deletes its copy', async () => {
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
    const r = await run(t, { mediaId: 3, path: note, mimeType: 'audio/ogg; codecs=opus', maxSeconds: 60 });
    expect(r).toEqual({ provider: 'elevenlabs', model: 'scribe_v2', text: 'haan', billedSeconds: 3, forgetRef: 'tr1' });
    await t.forget(r.forgetRef!);
    expect(sent).toEqual([
      { method: 'POST', key: KEY, fileName: 'voice.ogg', fileType: 'audio/ogg', diarize: 'false' },
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
