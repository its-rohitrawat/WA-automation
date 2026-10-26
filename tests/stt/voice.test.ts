import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { AudioError, Ffmpeg } from '../../src/stt/audio.ts';
import { SttHttpError, type HttpFetch } from '../../src/stt/http.ts';
import { costUsd, modelFor } from '../../src/stt/prices.ts';
import type { AudioPart, ProviderId, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../../src/stt/types.ts';
import {
  createVoiceTranscriber, sizeBoundSeconds, VOICE_STT_TIMEOUTS, voiceCeilingUsd, voiceTranscriber, type VoiceInput, type VoiceTranscriber,
} from '../../src/stt/voice.ts';

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
  length = 42;
  parts: AudioPart[] = [];
  toMp3Error: Error | null = null;
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
  override async seconds(): Promise<number> {
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

const OGG_MIMES = ['audio/ogg; codecs=opus', 'audio/opus', 'AUDIO/OGG; Codecs=Opus'];
const MP3_MIMES = ['audio/mpeg', 'audio/mp3'];
const OTHER_MIMES = ['audio/mp4', 'audio/aac', 'audio/amr', 'application/octet-stream', null, 'audio/ogg-x', ''];

describe('voiceTranscriber: choosing the format', () => {
  describe.each(['sarvam', 'elevenlabs'] as const)('%s', (id) => {
    it.each(OGG_MIMES)('sends %s as it is, as ogg, without speaker labels and without ffmpeg', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await make(p, ff).transcribe(input(mime));
      expect(p.calls).toEqual([{ audio: { path: input(mime).path, seconds: 120, offset: 0, format: 'ogg' }, opts: { diarize: false } }]);
      expect(ff.conversions).toEqual([]);
    });

    it.each(MP3_MIMES)('sends %s as it is, as mp3', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await make(p, ff).transcribe(input(mime));
      expect(p.calls).toEqual([{ audio: { path: input(mime).path, seconds: 120, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
      expect(ff.conversions).toEqual([]);
    });

    it.each(OTHER_MIMES)('converts %s to MP3 first, then sends it as mp3', async (mime) => {
      const p = new FakeProvider(id);
      const ff = new FakeFfmpeg();
      await make(p, ff).transcribe(input(mime));
      const mp3 = join(voiceDir(), 'audio.mp3');
      expect(ff.conversions).toEqual([{ input: input(mime).path, output: mp3 }]);
      expect(p.calls).toEqual([{ audio: { path: mp3, seconds: 42, offset: 0, format: 'mp3' }, opts: { diarize: false } }]);
      expect(ff.splits).toEqual([]);
    });
  });

  it.each([...OGG_MIMES, ...MP3_MIMES, ...OTHER_MIMES])('openai: converts %s first', async (mime) => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    await make(p, ff).transcribe(input(mime));
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

  it('without ffmpeg, a file that needs converting is refused before any provider call', async () => {
    const p = new FakeProvider('sarvam');
    await expect(make(p, null).transcribe(input('audio/aac'))).rejects.toBeInstanceOf(AudioError);
    expect(p.calls).toEqual([]);
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

  it('splits a converted note of 420 s into 300 s parts, sends both in order and joins the text', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => result(said('pehla hissa'), 210), async () => result(said('doosra hissa'), 211)];
    const ff = new FakeFfmpeg();
    ff.length = 420;
    ff.parts = parts();
    const r = await make(p, ff).transcribe(input('audio/ogg'));
    const mp3 = join(voiceDir(), 'audio.mp3');
    expect(ff.splits).toEqual([{ part: { path: mp3, seconds: 420, offset: 0, format: 'mp3' }, dir: join(voiceDir(), 'parts'), partSeconds: 300 }]);
    expect(p.calls.map((c) => c.audio)).toEqual(parts().map((x) => ({ ...x, format: 'mp3' })));
    expect(p.calls.every((c) => c.opts.diarize === false)).toBe(true);
    expect(r).toEqual({ provider: 'openai', model: 'm1', text: 'pehla hissa doosra hissa', billedSeconds: 421, forgetRef: null });
  });

  it('billedSeconds is null when one part does not report it', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => result(said('a'), 210), async () => result(said('b'), null)];
    const ff = new FakeFfmpeg();
    ff.length = 420;
    ff.parts = parts();
    expect((await make(p, ff).transcribe(input('audio/ogg'))).billedSeconds).toBeNull();
  });

  it('a note of exactly 300 s is sent whole', async () => {
    const p = new FakeProvider('openai');
    const ff = new FakeFfmpeg();
    ff.length = 300;
    await make(p, ff).transcribe(input('audio/ogg'));
    expect(ff.splits).toEqual([]);
    expect(p.calls).toHaveLength(1);
  });

  it('a failing second part is not retried, and the first is not sent again', async () => {
    const p = new FakeProvider('openai');
    const err = new SttHttpError(503, 'down');
    p.script = [async () => result(said('a'), 210), async () => {
      throw err;
    }];
    const ff = new FakeFfmpeg();
    ff.length = 420;
    ff.parts = parts();
    await expect(make(p, ff).transcribe(input('audio/ogg'))).rejects.toBe(err);
    expect(p.calls.map((c) => c.audio.path)).toEqual(parts().map((x) => x.path));
  });
});

describe('voiceTranscriber: text', () => {
  const textOf = async (segments: Segment[]) => {
    const p = new FakeProvider('sarvam');
    p.script = [async () => result(segments)];
    return (await make(p).transcribe(input('audio/ogg'))).text;
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
    expect(await make(p).transcribe(input('audio/ogg'))).toEqual({ provider: 'elevenlabs', model: 'm1', text: 'ok', billedSeconds: 44.5, forgetRef: null });
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

  it('prices billed seconds when reported, else the lower of the bound and the declared length', () => {
    const t = make(new FakeProvider('elevenlabs'));
    const at = (s: number) => costUsd(modelFor('elevenlabs', false), s, INR);
    expect(t.costUsd(600, 45, 50)).toBeCloseTo(at(45), 12);
    expect(t.costUsd(600, null, 50)).toBeCloseTo(at(50), 12);
    expect(t.costUsd(40, null, 50)).toBeCloseTo(at(40), 12);
    expect(t.costUsd(40, null, null)).toBeCloseTo(at(40), 12);
    expect(t.costUsd(40, 0, 50)).toBe(0);
  });

  it('ignores a negative, NaN or infinite billed or declared length', () => {
    const t = make(new FakeProvider('openai'));
    const at = (s: number) => costUsd(modelFor('openai', false), s, INR);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(t.costUsd(600, bad, 50)).toBeCloseTo(at(50), 12);
      expect(t.costUsd(40, null, bad)).toBeCloseTo(at(40), 12);
      expect(t.costUsd(40, bad, bad)).toBeCloseTo(at(40), 12);
    }
  });
});

describe('voiceTranscriber: forgetRef', () => {
  const refOf = async (ref: string | undefined) => {
    const p = new CopyingProvider('elevenlabs');
    p.script = [async () => result(said('ok'), 3, ref)];
    return (await make(p).transcribe(input('audio/ogg'))).forgetRef;
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
    expect((await make(p).transcribe(input('audio/ogg'))).forgetRef).toBeNull();
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
  it('removes the voice folder after a converted note is transcribed', async () => {
    const ff = new FakeFfmpeg();
    let during = false;
    const p = new FakeProvider('openai');
    p.script = [async () => {
      during = existsSync(join(voiceDir(), 'audio.mp3'));
      return result(said('ok'));
    }];
    await make(p, ff).transcribe(input('audio/ogg'));
    expect(during).toBe(true);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes the voice folder after the provider fails', async () => {
    const p = new FakeProvider('openai');
    p.script = [async () => {
      throw new SttHttpError(500, 'x');
    }];
    await expect(make(p).transcribe(input('audio/ogg'))).rejects.toBeInstanceOf(SttHttpError);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it('removes the voice folder after ffmpeg fails', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    await expect(make(new FakeProvider('openai'), ff).transcribe(input('audio/ogg'))).rejects.toBe(ff.toMp3Error);
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
    await make(new FakeProvider('openai'), ff).transcribe(input('audio/ogg'));
    expect(leftover).toEqual([false, false]);
    expect(existsSync(voiceDir())).toBe(false);
  });

  it("removes a leftover folder for a note sent as it is too, and touches no other note's folder", async () => {
    mkdirSync(voiceDir(), { recursive: true });
    mkdirSync(voiceDir(8), { recursive: true });
    await make(new FakeProvider('sarvam')).transcribe(input('audio/ogg'));
    expect(existsSync(voiceDir())).toBe(false);
    expect(existsSync(voiceDir(8))).toBe(true);
  });

  it.each([Number.NaN, -1, 1.5, 0])('refuses a media id of %s before touching any folder', async (mediaId) => {
    const p = new FakeProvider('sarvam');
    await expect(make(p).transcribe(input('audio/ogg', { mediaId }))).rejects.toThrow(/media id/);
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
    await expect(make(p).transcribe(input('audio/ogg'))).rejects.toBe(err);
    expect(p.calls).toHaveLength(1);
  });

  it('an AudioError from ffmpeg reaches the caller unchanged, and nothing is sent', async () => {
    const ff = new FakeFfmpeg();
    ff.toMp3Error = new AudioError('convert_failed');
    const p = new FakeProvider('sarvam');
    await expect(make(p, ff).transcribe(input('audio/aac'))).rejects.toBe(ff.toMp3Error);
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
    const r = await t.transcribe({ mediaId: 3, path: note, mimeType: 'audio/ogg; codecs=opus', maxSeconds: 30 });
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
