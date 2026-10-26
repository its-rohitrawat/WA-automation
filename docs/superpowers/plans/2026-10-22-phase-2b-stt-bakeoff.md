# Phase 2b Preparation: STT Bake-off Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command-line tool that sends the owner's real Hinglish voice notes and consented meeting recordings to three speech-to-text providers and writes a private side-by-side report the owner scores by hand (Hinglish accuracy, speaker separation, cost per hour), so the agent's transcription provider can be chosen (spec §7.4).

**Architecture:**
- **Default is a dry run.** `scripts/stt-bakeoff.ts` finds the recordings in `C:\stt-samples\voice-notes` and `C:\stt-samples\meetings` and measures them with an existing ffmpeg. It then prints every file, provider, model and list-price estimate, and sends nothing.
- **A real run (`--yes --confirm-privacy`):**
  - converts each file once into the same mono 16 kHz MP3, so every provider gets identical audio;
  - sends it to Sarvam (Batch API), ElevenLabs (one request) and OpenAI (5-minute parts for meetings);
  - records every slot (one file × one provider) in a ledger on disk before and after the paid call;
  - writes `report.md` and plain-text transcripts.
- **Everything the tool writes stays in `C:\stt-samples\bakeoff-out`, outside every git repository.**
- **Paid requests are never retried automatically.** A lost answer is marked "unknown" and is only sent again on request.

**Tech Stack:**
- Node.js 24 (type stripping, erasable TypeScript only), TypeScript 7 (type-check only), vitest 5.
- zod 4 (already a dependency), to validate provider answers.
- `node:http`/`node:https` (long requests), `node:child_process` (ffmpeg, no shell), `fs.openAsBlob`, `FormData`.
- No new npm dependencies, and no system installs: ffmpeg 7.1 is already on disk inside Python's imageio_ffmpeg package.

**Spec:** `docs/superpowers/specs/2026-10-19-wa-agent-design.md` §7.3, §7.4, §13 (Phase 2: STT bake-off).

**Requested by:** the Phase 2a build session (wa-agent-74, now wa-agent-f4). Approved by the user on 2026-10-22, with Sarvam mode **codemix only**.

---

## Decisions

1. **Providers and models.** All facts below come from official docs, checked 2026-10-22.

   | Provider | Voice notes | Meetings | Price per audio hour |
   |---|---|---|---|
   | Sarvam | `saaras:v4`, mode `codemix`, `hi-IN`, Batch API | same, `with_diarization: true` | ₹30 (₹36 with speaker labels) |
   | ElevenLabs | `scribe_v2`, `language_code=hin`, `tag_audio_events=false` | same, `diarize=true` | $0.22 |
   | OpenAI | `gpt-transcribe`, `languages[]=hi`, `languages[]=en` | `gpt-4o-transcribe-diarize`, `diarized_json`, `chunking_strategy=auto` | $0.27 / $0.36 |

   - **Sarvam:**
     - The sync REST API takes 30 seconds at most and has no speaker labels, so every Sarvam file goes through the Batch API: create job → get upload URL → PUT → start → poll → download.
     - The API key is sent only to `api.sarvam.ai`, never to the signed storage URLs.
     - Sarvam bills in rupees. The tool converts at `INR_PER_USD` (default 88).
   - **ElevenLabs:**
     - A meeting is sent whole (files of up to 10 hours are accepted), so speaker labels stay consistent.
     - Node's `fetch` gives up after 300 seconds without response headers, so all calls use `longFetch` (`node:https`), whose only limit is the caller's timeout.
     - The official SDK retries 408/429/5xx twice, and each retry is billed again, so plain HTTP is used, with no retries.
   - **OpenAI:**
     - `gpt-4o-transcribe-diarize` is OpenAI's only model with speaker labels. It **shuts down on 2027-02-26**, and nothing replaces it with labels. OpenAI can therefore only win voice notes long-term.
     - A request takes 25 MB, and the diarize model writes at most 2,000 output tokens per request. Meetings are therefore sent in 300-second parts. Speaker labels restart in every part and are shown as `p2:A` instead of being guessed across parts.
2. **One prepared format: mono 16 kHz MP3 at 64 kbit/s.**
   - MP3 is the only format that all three providers' docs list without contradiction. OpenAI's guide and reference disagree about `ogg`.
   - Every provider gets the same bytes, which keeps the comparison fair. A 90-minute meeting becomes about 43 MB.
   - The same step extracts the audio track from video recordings (spec §7.3).
   - The command is `ffmpeg -i <in> -vn -ac 1 -ar 16000 -c:a libmp3lame -b:a 64k`. It writes to a temporary name first, then renames.
3. **ffmpeg is found, never installed.**
   - The tool uses `FFMPEG_PATH` from `.env`, otherwise `ffmpeg` on PATH.
   - On this PC the existing binary is `C:\Users\Dell\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`.
   - There is no ffprobe, so durations are read from ffmpeg's `Duration:` line.
4. **Money and safety rules.**
   - Dry run by default; `--yes` is needed to send anything.
   - `--yes` also refuses to start unless:
     - every provider that has something to send has its key;
     - the estimate is within `--max-usd` (default $8);
     - `--confirm-privacy` is given (see the checklist in Task 13).
   - Before each slot, the runner checks the cap against what this run has spent plus the slot's estimate.
   - **No automatic retries of paid requests.** Each slot's outcome is one of:
     - **done:** a result was recorded;
     - **failed:** the provider answered with an error status, or its job failed;
     - **unknown:** no usable answer arrived. It is counted as spent and sent again only with `--retry-unknown`. A saved Sarvam job id is waited on again, which adds no new charge.
   - A 401, 402 or 403 stops that provider for the rest of the run.
   - **Idempotent ledger:**
     - An attempt file is written **before** the first paid request.
     - Each part's answer is saved as soon as it arrives.
     - The outcome file is written last.
     - A finished slot is never sent again. `--retry-failed` moves a failed outcome aside (it stays on disk) and sends again.
5. **Private data.**
   - The samples folder and the output folder must not be inside any git repository: the tool walks up the folders looking for `.git` and refuses if it finds one.
   - Transcript text is written only to `report.md`, `transcripts/*.txt` and the ledger, all in the output folder. It never goes to the console or a log.
   - Provider error bodies are reduced to short machine codes such as `invalid_api_key`. Free text is dropped, because it can echo keys or input.
6. **Report.** `report.md` contains:
   - a summary per provider and kind (files, audio, cost, cost per audio hour, processing time per audio minute);
   - a blank score sheet;
   - for each voice note, one table row per provider;
   - for each meeting, a stats table and a timeline with one row per minute and one column per provider.

   Full transcripts go to `transcripts/<sample>.<provider>.txt`. Costs are list price × audio length (billed seconds when the provider reports them). The report tells the owner to compare them with each provider's dashboard.
7. **Seam for Phase 2b.**
   - The adapters return `Segment[]` (`start`, `end`, `speaker`, `text`) plus a cost basis, as in spec §7.4.
   - `src/media/types.ts` currently declares `Transcriber` as returning `{ text, costUsd }`. Phase 2b proper will wrap the winning adapter in whichever shape it settles on.
   - This plan does not touch `src/media/`.
8. **Merge hygiene.**
   - Phase 2a keeps committing on `feat/phase-2a-media`. This branch touches only:
     - new files under `src/stt/`, `tests/stt/` and `scripts/`;
     - the new `docs/STT-BAKEOFF.md` and this plan;
     - `.env.example`, key names only, in its own commit.
   - `package.json`, `src/config/env.ts` and every Phase 2a file stay untouched. That is why the tool runs as `node scripts/stt-bakeoff.ts` with no npm script.

## Not in this plan

- The production `Transcriber`, the `STT_PROVIDER` setting, and plugging transcription into `extract.ts` (Phase 2b proper, after the owner picks a winner).
- Overlapping chunks and cross-part speaker matching for OpenAI (only worth building if OpenAI wins meetings, and its diarize model is going away).
- Any paid run. The owner approves each real run separately, after the privacy steps in `docs/STT-BAKEOFF.md`.

---

## Ground rules for whoever executes this plan

1. **Work only in `C:\Users\Dell\Desktop\WA_agent-stt`** on branch `feat/phase-2b-stt-bakeoff`. Never edit files in `C:\Users\Dell\Desktop\WA_agent` and never run a state-changing git command there. Never push, never amend, never merge.
2. **No paid calls, no network in tests.** Every test uses fakes or files it creates in a temp folder. The only socket in the tests is a loopback server on `127.0.0.1` in `tests/stt/http.test.ts`. Do not run `scripts/stt-bakeoff.ts --yes`.
3. **Secrets and private data.** Never print, log or commit `.env` values. Never create recordings or transcripts inside the repository. Logs and console lines carry ids, durations, counts, costs and error codes only.
4. **Memory is short on this PC.** Run only the test file you are working on, or `tests/stt/`, never the whole suite. Do not run local speech models.
5. **Commands.** Run tests from the uppercase path in PowerShell:
   `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/<file>`
   Type-check: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx tsc -p tsconfig.json`
   Commit with Bash: `git -C /c/Users/Dell/Desktop/WA_agent-stt add <files>` and `git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`
6. **Conventions.**
   - Erasable TypeScript only: no `enum`, no `namespace`, no parameter properties.
   - `#private` fields, `.ts` import suffixes, `import type` for types.
   - `noUncheckedIndexedAccess` is on.
   - Comments explain why, briefly, as in the rest of the codebase.

## File map

| File | Responsibility |
|---|---|
| `.env.example` | Adds the bake-off variable names (own commit) |
| `src/stt/types.ts` | `ProviderId`, `SampleKind`, `Segment`, `AudioPart`, `TranscribeOptions`, `ProviderResult`, `SttProvider` |
| `src/stt/prices.ts` | Model per provider and kind, list prices, `costUsd` |
| `src/stt/segments.ts` | Word timings → segments, merging parts, clock format, transcript text |
| `src/stt/http.ts` | Error classes, `send`/`requestJson`/`requestOk`, `parseAnswer`, `longFetch` |
| `src/stt/providers/sarvam.ts` | Sarvam Batch API adapter |
| `src/stt/providers/elevenlabs.ts` | ElevenLabs Scribe v2 adapter |
| `src/stt/providers/openai.ts` | OpenAI adapter (gpt-transcribe / diarize) |
| `src/stt/audio.ts` | ffmpeg: find, measure, convert to MP3, split into parts |
| `src/stt/bakeoff/env.ts` | Bake-off settings from `.env` (key names only in errors) |
| `src/stt/bakeoff/samples.ts` | Find recordings; refuse folders inside a git repository |
| `src/stt/bakeoff/ledger.ts` | Attempt / part / outcome files per slot |
| `src/stt/bakeoff/plan.ts` | What a run would do, its estimate, the dry-run listing |
| `src/stt/bakeoff/runner.ts` | Sends the plan slot by slot under the cap |
| `src/stt/bakeoff/report.ts` | `report.md` |
| `src/stt/bakeoff/checks.ts` | Reasons a real run must not start; the privacy checklist |
| `scripts/stt-bakeoff.ts` | Command-line wiring |
| `docs/STT-BAKEOFF.md` | Owner's runbook, including the must-do-before-upload privacy steps |
| `tests/stt/**` | One test file per module |

---

### Task 1: Bake-off variable names in `.env.example`

**Files:**
- Modify: `.env.example` (append at the end)

- [ ] **Step 1: Append the names**

Add these lines at the end of `.env.example`. Do not change any existing line.

```env

# Phase 2b STT bake-off only (scripts/stt-bakeoff.ts, docs/STT-BAKEOFF.md).
# Keys are server-side secrets: type them into .env yourself, never into chat or code.
SARVAM_API_KEY=
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
# Full path to ffmpeg.exe when ffmpeg is not on PATH.
FFMPEG_PATH=
# Folder holding voice-notes\ and meetings\ (default C:\stt-samples). Must be outside every git repository.
STT_SAMPLES_DIR=
# Rupees per US dollar, for Sarvam's rupee prices (default 88).
INR_PER_USD=
```

- [ ] **Step 2: Check that nothing else changed**

Run: `git -C /c/Users/Dell/Desktop/WA_agent-stt diff --stat`
Expected: `.env.example | 13 +` and nothing else.

- [ ] **Step 3: Commit (own commit, for an easy merge with Phase 2a)**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add .env.example
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "chore: STT bake-off variable names in .env.example" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared types and prices

**Files:**
- Create: `src/stt/types.ts`, `src/stt/prices.ts`
- Test: `tests/stt/prices.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/prices.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { costUsd, modelFor } from '../../src/stt/prices.ts';

describe('modelFor', () => {
  it('uses saaras:v4 with the rupee price for speaker labels on meetings', () => {
    expect(modelFor('sarvam', true)).toMatchObject({ model: 'saaras:v4', perHour: 36, currency: 'INR' });
    expect(modelFor('sarvam', false)).toMatchObject({ model: 'saaras:v4', perHour: 30, currency: 'INR' });
  });

  it('uses scribe_v2 at one price either way', () => {
    expect(modelFor('elevenlabs', true)).toMatchObject({ model: 'scribe_v2', perHour: 0.22, currency: 'USD' });
    expect(modelFor('elevenlabs', false).perHour).toBe(0.22);
  });

  it('switches OpenAI to the diarize model only for meetings', () => {
    expect(modelFor('openai', false)).toMatchObject({ model: 'gpt-transcribe', perHour: 0.27, currency: 'USD' });
    expect(modelFor('openai', true)).toMatchObject({ model: 'gpt-4o-transcribe-diarize', perHour: 0.36, currency: 'USD' });
  });
});

describe('costUsd', () => {
  it('prices dollars per hour of audio', () => {
    expect(costUsd(modelFor('elevenlabs', true), 1800, 88)).toBeCloseTo(0.11, 10);
  });

  it('converts rupee prices at the given rate', () => {
    // One hour with speaker labels: ₹36 at ₹90 to the dollar is $0.40.
    expect(costUsd(modelFor('sarvam', true), 3600, 90)).toBeCloseTo(0.4, 10);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/prices.test.ts`
Expected: FAIL, with `Failed to load url ../../src/stt/prices.ts` (or "Cannot find module").

- [ ] **Step 3: Write the types**

`src/stt/types.ts`:

```ts
export type ProviderId = 'sarvam' | 'elevenlabs' | 'openai';
export const PROVIDER_IDS: readonly ProviderId[] = ['sarvam', 'elevenlabs', 'openai'];

/** Voice notes are sent without speaker labels; meetings with speaker labels (diarization) on. */
export type SampleKind = 'voice' | 'meeting';

/** One stretch of speech, in seconds from the start of the audio. speaker is null when the provider gave none. */
export interface Segment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
}

/** Audio as sent to a provider: a mono 16 kHz MP3 made by src/stt/audio.ts. offset is where it starts in the whole file. */
export interface AudioPart {
  path: string;
  seconds: number;
  offset: number;
}

export interface TranscribeOptions {
  diarize: boolean;
  /** A provider job id saved by an earlier run whose answer never arrived: wait for that job instead of sending again. */
  resumeJobId?: string;
  /** Called once the provider has accepted the work and given it an id, before waiting for the result. */
  onJobId?: (id: string) => void;
}

export interface ProviderResult {
  model: string;
  /** Times relative to the start of the part that was sent. */
  segments: Segment[];
  /** Seconds the provider reports as billed, when it reports them. */
  billedSeconds: number | null;
  /** The provider's own JSON, kept only in the private output folder so the report can be rebuilt without paying again. */
  raw: unknown;
}

export interface SttProvider {
  readonly id: ProviderId;
  /** Longest audio one request may carry. Longer files are split into parts of at most this length. */
  readonly maxPartSeconds: number;
  transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult>;
}
```

- [ ] **Step 4: Write the prices**

`src/stt/prices.ts`:

```ts
import type { ProviderId } from './types.ts';

/** The day the prices below were read from the providers' pricing pages. Re-check before a large run. */
export const PRICES_CHECKED = '2026-10-22';

export interface ModelPrice {
  model: string;
  perHour: number;
  currency: 'USD' | 'INR';
  source: string;
}

/**
 * The model each provider is tested with, and its list price per hour of audio. Sarvam bills in rupees only.
 * OpenAI's only model with speaker labels, gpt-4o-transcribe-diarize, shuts down on 2027-02-26.
 */
export function modelFor(provider: ProviderId, diarize: boolean): ModelPrice {
  switch (provider) {
    case 'sarvam':
      return { model: 'saaras:v4', perHour: diarize ? 36 : 30, currency: 'INR', source: 'https://docs.sarvam.ai/api/getting-started/pricing' };
    case 'elevenlabs':
      return { model: 'scribe_v2', perHour: 0.22, currency: 'USD', source: 'https://elevenlabs.io/pricing/api' };
    case 'openai':
      return diarize
        ? { model: 'gpt-4o-transcribe-diarize', perHour: 0.36, currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing' }
        : { model: 'gpt-transcribe', perHour: 0.27, currency: 'USD', source: 'https://developers.openai.com/api/docs/pricing' };
  }
}

/** List-price cost in US dollars. Rupee prices are converted at inrPerUsd rupees to the dollar. */
export function costUsd(price: ModelPrice, seconds: number, inrPerUsd: number): number {
  const local = (price.perHour * seconds) / 3600;
  return price.currency === 'INR' ? local / inrPerUsd : local;
}
```

- [ ] **Step 5: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/prices.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/types.ts src/stt/prices.ts tests/stt/prices.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off types and list prices" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Segments

**Files:**
- Create: `src/stt/segments.ts`
- Test: `tests/stt/segments.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/segments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatClock, mergeParts, segmentsToText, wordsToSegments } from '../../src/stt/segments.ts';

const w = (text: string, start: number, end: number, speaker: string | null = 'speaker_0') => ({ text, start, end, speaker });

describe('wordsToSegments', () => {
  it('joins the words of one speaker into one segment', () => {
    expect(wordsToSegments([w('Kal', 0, 0.4), w('meeting', 0.5, 0.9), w('hai', 1, 1.2)])).toEqual([
      { start: 0, end: 1.2, speaker: 'speaker_0', text: 'Kal meeting hai' },
    ]);
  });

  it('starts a new segment when the speaker changes', () => {
    const segs = wordsToSegments([w('Haan', 0, 0.3, 'speaker_0'), w('Theek', 0.4, 0.7, 'speaker_1')]);
    expect(segs.map((s) => [s.speaker, s.text])).toEqual([
      ['speaker_0', 'Haan'],
      ['speaker_1', 'Theek'],
    ]);
  });

  it('starts a new segment after a pause longer than 1.5 seconds', () => {
    expect(wordsToSegments([w('a', 0, 1), w('b', 2.6, 3)])).toHaveLength(2);
    expect(wordsToSegments([w('a', 0, 1), w('b', 2.4, 3)])).toHaveLength(1);
  });

  it('keeps every segment within 30 seconds', () => {
    const words = Array.from({ length: 40 }, (_, i) => w(`w${i}`, i, i + 0.9));
    const segs = wordsToSegments(words);
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.end - s.start <= 30)).toBe(true);
  });

  it('returns nothing for no words', () => {
    expect(wordsToSegments([])).toEqual([]);
  });
});

describe('mergeParts', () => {
  it('keeps a single part as it is', () => {
    const seg = { start: 1, end: 2, speaker: 'A', text: 'x' };
    expect(mergeParts([{ offset: 0, segments: [seg] }])).toEqual([seg]);
  });

  it('shifts times by the part offset and marks speakers with the part number', () => {
    const merged = mergeParts([
      { offset: 0, segments: [{ start: 0, end: 5, speaker: 'A', text: 'one' }] },
      {
        offset: 300,
        segments: [
          { start: 2, end: 4, speaker: 'A', text: 'two' },
          { start: 4, end: 6, speaker: null, text: 'three' },
        ],
      },
    ]);
    expect(merged).toEqual([
      { start: 0, end: 5, speaker: 'p1:A', text: 'one' },
      { start: 302, end: 304, speaker: 'p2:A', text: 'two' },
      { start: 304, end: 306, speaker: null, text: 'three' },
    ]);
  });
});

describe('formatClock', () => {
  it('formats minutes, and hours when needed', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.4)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });
});

describe('segmentsToText', () => {
  it('writes one line per segment', () => {
    const text = segmentsToText([
      { start: 75, end: 80, speaker: 'A', text: 'Kal' },
      { start: 81, end: 82, speaker: null, text: 'ok' },
    ]);
    expect(text).toBe('[1:15] A: Kal\n[1:21] ok\n');
  });

  it('is empty for no segments', () => {
    expect(segmentsToText([])).toBe('');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/segments.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/segments.ts`:

```ts
import type { Segment } from './types.ts';

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  speaker: string | null;
}

/**
 * Groups word timings into readable segments. A new segment starts when the speaker changes, after a pause longer than
 * maxGapSeconds, or when the current one would grow past maxSegmentSeconds.
 */
export function wordsToSegments(words: readonly TimedWord[], maxGapSeconds = 1.5, maxSegmentSeconds = 30): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | undefined;
  for (const w of words) {
    if (cur && w.speaker === cur.speaker && w.start - cur.end <= maxGapSeconds && w.end - cur.start <= maxSegmentSeconds) {
      cur.end = w.end;
      cur.text += ` ${w.text}`;
    } else {
      cur = { start: w.start, end: w.end, speaker: w.speaker, text: w.text };
      out.push(cur);
    }
  }
  return out;
}

/**
 * Joins the answers for a file sent in parts. Times move by each part's offset. Speaker labels are only valid inside
 * one answer, so with more than one part they get the part number ("p2:A") instead of being guessed across parts.
 */
export function mergeParts(parts: readonly { offset: number; segments: readonly Segment[] }[]): Segment[] {
  const many = parts.length > 1;
  return parts.flatMap((p, i) =>
    p.segments.map((s) => ({
      start: s.start + p.offset,
      end: s.end + p.offset,
      speaker: s.speaker === null ? null : many ? `p${i + 1}:${s.speaker}` : s.speaker,
      text: s.text,
    })),
  );
}

/** 75.4 -> "1:15", 3725 -> "1:02:05". Whole seconds, rounded down. */
export function formatClock(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** One line per segment, "[1:15] A: text", without the speaker part when there is none. */
export function segmentsToText(segments: readonly Segment[]): string {
  return segments.map((s) => `[${formatClock(s.start)}] ${s.speaker === null ? '' : `${s.speaker}: `}${s.text}\n`).join('');
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/segments.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/segments.ts tests/stt/segments.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT segments from word timings and from audio parts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: HTTP layer

**Files:**
- Create: `src/stt/http.ts`
- Test: `tests/stt/http.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/http.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  errorCodes, longFetch, parseAnswer, requestJson, requestOk, SttHttpError, SttNoAnswerError, type HttpFetch,
} from '../../src/stt/http.ts';

const answer = (res: Response | Error): HttpFetch => async () => {
  if (res instanceof Error) throw res;
  return res;
};

describe('requestJson', () => {
  it('returns the JSON body of a 2xx answer', async () => {
    expect(await requestJson(answer(Response.json({ a: 1 })), 'https://x.test', {})).toEqual({ a: 1 });
  });

  it('turns an error status into SttHttpError carrying only short codes', async () => {
    const body = { error: { message: 'Incorrect API key provided: sk-abc', type: 'invalid_request_error', code: 'invalid_api_key' } };
    const err = await requestJson(answer(Response.json(body, { status: 401 })), 'https://x.test', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect((err as SttHttpError).status).toBe(401);
    expect((err as SttHttpError).detail).toBe('invalid_request_error,invalid_api_key');
    expect(String((err as Error).message)).not.toContain('sk-abc');
  });

  it('keeps the status when the error body is not JSON', async () => {
    const err = await requestJson(answer(new Response('<Error/>', { status: 500 })), 'https://x.test', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'SttHttpError', status: 500, detail: null });
  });

  it('reports a request that threw as no answer, with a code', async () => {
    const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
    await expect(requestJson(answer(timeout), 'https://x.test', {})).rejects.toMatchObject({ name: 'SttNoAnswerError', code: 'timeout' });
    const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' });
    await expect(requestJson(answer(reset), 'https://x.test', {})).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('reports an unreadable 2xx body as no answer', async () => {
    await expect(requestJson(answer(new Response('not json')), 'https://x.test', {})).rejects.toMatchObject({ code: 'unreadable_body' });
  });
});

describe('requestOk', () => {
  it('accepts an empty 2xx answer', async () => {
    await expect(requestOk(answer(new Response(null, { status: 201 })), 'https://x.test', {})).resolves.toBeUndefined();
  });
});

describe('errorCodes', () => {
  it('collects code, type and status strings up to three levels deep', () => {
    expect(errorCodes({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } })).toEqual(['invalid_api_key']);
  });

  it('ignores free text that does not look like a code', () => {
    expect(errorCodes({ error: { code: 'has spaces in it' } })).toEqual([]);
  });
});

describe('parseAnswer', () => {
  it('returns the parsed value or throws SttNoAnswerError with the given code', () => {
    const schema = z.object({ id: z.string() });
    expect(parseAnswer(schema, { id: 'a' }, 'bad')).toEqual({ id: 'a' });
    expect(() => parseAnswer(schema, { id: 1 }, 'bad_job')).toThrow(SttNoAnswerError);
  });
});

describe('longFetch', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/slow') return; // never answers
        if (req.url === '/empty') {
          res.writeHead(204);
          res.end();
          return;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          type: req.headers['content-type'] ?? null,
          length: req.headers['content-length'] ?? null,
          key: req.headers['x-key'] ?? null,
          hasModel: body.includes('name="model"'),
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('sends a multipart body with its boundary and length', async () => {
    const form = new FormData();
    form.append('model', 'm1');
    form.append('file', new Blob(['abc'], { type: 'audio/mpeg' }), 'a.mp3');
    const res = await longFetch(`${base}/echo`, { method: 'POST', headers: { 'x-key': 'k' }, body: form });
    expect(res.status).toBe(201);
    const echo = (await res.json()) as { method: string; type: string; length: string; key: string; hasModel: boolean };
    expect(echo).toMatchObject({ method: 'POST', key: 'k', hasModel: true });
    expect(echo.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(echo.length)).toBeGreaterThan(0);
  });

  it('returns an empty body for 204', async () => {
    const res = await longFetch(`${base}/empty`, { method: 'GET' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('stops waiting when the signal fires', async () => {
    await expect(longFetch(`${base}/slow`, { method: 'GET', signal: AbortSignal.timeout(100) })).rejects.toMatchObject({
      name: expect.stringMatching(/AbortError|TimeoutError/),
    });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/http.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/http.ts`:

```ts
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { z } from 'zod';

/** One HTTP call, replaceable in tests. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The provider answered with an error status: it refused or failed the work. detail holds short codes from the body only. */
export class SttHttpError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, detail: string | null = null) {
    super(`Provider answered HTTP ${status}`);
    this.name = 'SttHttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** The provider accepted a job and later reported that it failed. */
export class SttJobError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Provider job failed (${code})`);
    this.name = 'SttJobError';
    this.code = code;
  }
}

/** No usable answer (timeout, lost connection, unreadable reply). The provider may still have done, and billed, the work. */
export class SttNoAnswerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`No usable answer from the provider (${code})`);
    this.name = 'SttNoAnswerError';
    this.code = code;
  }
}

/** Short machine codes found in an error body ("invalid_api_key"). Free text is dropped: it can echo keys or input. */
export function errorCodes(body: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if ((k === 'code' || k === 'type' || k === 'status') && typeof v === 'string') {
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(v)) found.add(v);
      } else walk(v, depth + 1);
    }
  };
  walk(body, 0);
  return [...found].slice(0, 3);
}

function noAnswerCode(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'network';
}

/** Sends one request and returns the response when its status is 2xx. */
export async function send(http: HttpFetch, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await http(url, init);
  } catch (e) {
    throw new SttNoAnswerError(noAnswerCode(e));
  }
  if (!res.ok) {
    let codes: string[] = [];
    try {
      codes = errorCodes(await res.json());
    } catch {
      // Not JSON: there is nothing to keep.
    }
    throw new SttHttpError(res.status, codes.length > 0 ? codes.join(',') : null);
  }
  return res;
}

/** send(), then the JSON body. */
export async function requestJson(http: HttpFetch, url: string, init: RequestInit): Promise<unknown> {
  const res = await send(http, url, init);
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    throw new SttNoAnswerError(noAnswerCode(e) === 'timeout' ? 'timeout' : 'unreadable_body');
  }
}

/** send(), discarding the body. */
export async function requestOk(http: HttpFetch, url: string, init: RequestInit): Promise<void> {
  const res = await send(http, url, init);
  await res.body?.cancel();
}

/** Checks a provider answer against its expected shape. A mismatch counts as no usable answer. */
export function parseAnswer<T extends z.ZodType>(schema: T, value: unknown, code: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SttNoAnswerError(code);
  return result.data as z.output<T>;
}

function toResponse(res: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const status = res.statusCode ?? 502;
  const empty = status === 204 || status === 304 || body.length === 0;
  return new Response(empty ? null : new Uint8Array(body), { status, headers });
}

/**
 * HttpFetch on node:http(s). Node's fetch stops waiting after 300 s without response headers, and ElevenLabs answers a
 * long meeting only when it has finished. Here only init.signal, the caller's timeout, ends the wait.
 */
export const longFetch: HttpFetch = async (url, init) => {
  // Request serialises FormData and Blob bodies, including the multipart boundary.
  const req = new Request(url, init);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  const target = new URL(req.url);
  const transport = target.protocol === 'https:' ? httpsRequest : target.protocol === 'http:' ? httpRequest : null;
  if (!transport) throw new TypeError(`Unsupported protocol ${target.protocol}`);
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  if (body) headers['content-length'] = String(body.length);
  return await new Promise<Response>((resolve, reject) => {
    const r = transport(target, { method: req.method, headers, signal: init.signal ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      let ended = false;
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        ended = true;
        resolve(toResponse(res, Buffer.concat(chunks)));
      });
      res.on('error', reject);
      res.on('close', () => {
        if (!ended) reject(Object.assign(new Error('Response closed early'), { code: 'ECONNRESET' }));
      });
    });
    r.on('error', reject);
    r.end(body ?? undefined);
  });
};
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/http.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/http.ts tests/stt/http.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT HTTP layer with outcome classes and a long-wait fetch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sarvam adapter (Batch API)

**Files:**
- Create: `src/stt/providers/sarvam.ts`
- Test: `tests/stt/providers/sarvam.test.ts`

Facts used (docs.sarvam.ai, 2026-10-22):
- Endpoints, all under `https://api.sarvam.ai/speech-to-text/job/v1`:
  - `POST ''` → `{ job_id }`
  - `POST /upload-files` → `upload_urls[name].file_url`
  - `PUT <file_url>` with `x-ms-blob-type: BlockBlob`
  - `POST /{id}/start`
  - `GET /{id}/status` → `job_state`, `job_details[0].state`, `outputs[0].file_name`
  - `POST /download-files` → `download_urls[name].file_url`
  - `GET <file_url>` → the result JSON
- Job states: `Accepted`, `Pending`, `Running`, `Completed`, `Failed`, plus `PartiallyCompleted`. A file's state is `Success` on success.
- The result has `transcript`, `timestamps` (`words` or `chunks`, with start and end arrays) and `diarized_transcript.entries[]`.

- [ ] **Step 1: Write the failing test**

`tests/stt/providers/sarvam.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SttJobError, SttNoAnswerError, type HttpFetch } from '../../../src/stt/http.ts';
import { SarvamProvider } from '../../../src/stt/providers/sarvam.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

const JOBS = 'https://api.sarvam.ai/speech-to-text/job/v1';
const DIARIZED = {
  transcript: 'Kal ki meeting confirm hai? Haan, 4 baje.',
  diarized_transcript: {
    entries: [
      { transcript: 'Kal ki meeting confirm hai?', start_time_seconds: 0.5, end_time_seconds: 2.5, speaker_id: '0' },
      { transcript: 'Haan, 4 baje.', start_time_seconds: 2.8, end_time_seconds: 4, speaker_id: 1 },
    ],
  },
};

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeSarvam(opts: { states?: string[]; detailState?: string; result?: unknown; uploadUrl?: string } = {}) {
  const calls: Call[] = [];
  const states = [...(opts.states ?? ['Running', 'Completed'])];
  const http: HttpFetch = async (url, init) => {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : (init.body ?? null);
    calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body });
    if (url === JOBS) return Response.json({ job_id: 'job-1', job_state: 'Accepted' }, { status: 202 });
    if (url === `${JOBS}/upload-files`) {
      return Response.json({ job_id: 'job-1', upload_urls: { 'audio.mp3': { file_url: opts.uploadUrl ?? 'https://blob.example/up?sig=1' } } });
    }
    if (url.startsWith('https://blob.example/up')) return new Response(null, { status: 201 });
    if (url === `${JOBS}/job-1/start`) return Response.json({ job_id: 'job-1', job_state: 'Pending' });
    if (url === `${JOBS}/job-1/status`) {
      const state = states.length > 1 ? states.shift()! : states[0]!;
      return Response.json({ job_state: state, job_details: [{ state: opts.detailState ?? 'Success', outputs: [{ file_name: '0.json' }] }] });
    }
    if (url === `${JOBS}/download-files`) return Response.json({ download_urls: { '0.json': { file_url: 'https://blob.example/down?sig=2' } } });
    if (url.startsWith('https://blob.example/down')) return Response.json(opts.result ?? DIARIZED);
    return new Response(null, { status: 404 });
  };
  return { http, calls };
}

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-sarvam-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 4.2, offset: 0 };
});

function provider(http: HttpFetch): SarvamProvider {
  const clock = { t: 0 };
  return new SarvamProvider({
    apiKey: 'test-key',
    http,
    pollMs: 5_000,
    maxWaitMs: 60_000,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
}

describe('SarvamProvider', () => {
  it('runs the batch job and returns diarized segments', async () => {
    const { http, calls } = fakeSarvam();
    const r = await provider(http).transcribe(audio, { diarize: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`)).toEqual([
      `POST ${JOBS}`,
      `POST ${JOBS}/upload-files`,
      'PUT https://blob.example/up',
      `POST ${JOBS}/job-1/start`,
      `GET ${JOBS}/job-1/status`,
      `GET ${JOBS}/job-1/status`,
      `POST ${JOBS}/download-files`,
      'GET https://blob.example/down',
    ]);
    expect(calls[0]!.body).toEqual({
      job_parameters: { model: 'saaras:v4', mode: 'codemix', language_code: 'hi-IN', with_timestamps: true, with_diarization: true },
    });
    expect(r.model).toBe('saaras:v4');
    expect(r.billedSeconds).toBeNull();
    expect(r.segments).toEqual([
      { start: 0.5, end: 2.5, speaker: 'speaker_0', text: 'Kal ki meeting confirm hai?' },
      { start: 2.8, end: 4, speaker: 'speaker_1', text: 'Haan, 4 baje.' },
    ]);
    expect(r.raw).toEqual(DIARIZED);
  });

  it('sends the API key to Sarvam only, never to the storage links', async () => {
    const { http, calls } = fakeSarvam();
    await provider(http).transcribe(audio, { diarize: true });
    for (const c of calls) {
      expect(c.headers.get('api-subscription-key')).toBe(c.url.startsWith('https://api.sarvam.ai/') ? 'test-key' : null);
    }
  });

  it('uploads the audio with the blob headers', async () => {
    const { http, calls } = fakeSarvam();
    await provider(http).transcribe(audio, { diarize: true });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.headers.get('x-ms-blob-type')).toBe('BlockBlob');
    expect(put.headers.get('content-type')).toBe('audio/mpeg');
    expect(await (put.body as Blob).text()).toBe('fake mp3 bytes');
  });

  it('uses the timestamps when speaker labels are off', async () => {
    const result = { transcript: 'x', timestamps: { words: ['Kal milte hain', 'theek hai'], start_time_seconds: [0, 2], end_time_seconds: [1.8, 3] } };
    const { http, calls } = fakeSarvam({ result });
    const r = await provider(http).transcribe(audio, { diarize: false });
    expect((calls[0]!.body as { job_parameters: { with_diarization: boolean } }).job_parameters.with_diarization).toBe(false);
    expect(r.segments).toEqual([
      { start: 0, end: 1.8, speaker: null, text: 'Kal milte hain' },
      { start: 2, end: 3, speaker: null, text: 'theek hai' },
    ]);
  });

  it('falls back to the whole transcript without timestamps', async () => {
    const { http } = fakeSarvam({ result: { transcript: ' Sab theek. ' } });
    const r = await provider(http).transcribe(audio, { diarize: false });
    expect(r.segments).toEqual([{ start: 0, end: 4.2, speaker: null, text: 'Sab theek.' }]);
  });

  it('reports the job id once the job has started', async () => {
    const { http, calls } = fakeSarvam();
    const seen: { id: string; callsSoFar: number }[] = [];
    await provider(http).transcribe(audio, { diarize: true, onJobId: (id) => seen.push({ id, callsSoFar: calls.length }) });
    expect(seen).toEqual([{ id: 'job-1', callsSoFar: 4 }]);
  });

  it('waits on a saved job without uploading again', async () => {
    const { http, calls } = fakeSarvam();
    const seen: string[] = [];
    const r = await provider(http).transcribe(audio, { diarize: true, resumeJobId: 'job-1', onJobId: (id) => seen.push(id) });
    expect(calls.some((c) => c.method === 'PUT' || c.url === JOBS)).toBe(false);
    expect(seen).toEqual([]);
    expect(r.segments).toHaveLength(2);
  });

  it('throws SttJobError when the job fails', async () => {
    const { http } = fakeSarvam({ states: ['Failed'], detailState: 'API Error' });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttJobError);
    expect((err as SttJobError).code).toBe('api_error');
  });

  it('gives up after maxWaitMs and reports that no answer arrived', async () => {
    const { http } = fakeSarvam({ states: ['Running'] });
    const err = await provider(http).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttNoAnswerError);
    expect((err as SttNoAnswerError).code).toBe('job_wait_timeout');
  });

  it('refuses a storage link that is not https', async () => {
    const { http, calls } = fakeSarvam({ uploadUrl: 'http://blob.example/up' });
    await expect(provider(http).transcribe(audio, { diarize: true })).rejects.toMatchObject({ code: 'bad_storage_url' });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/sarvam.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/providers/sarvam.ts`:

```ts
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, requestOk, SttJobError, SttNoAnswerError, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import type { AudioPart, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../types.ts';

const JOBS = 'https://api.sarvam.ai/speech-to-text/job/v1';
/** The audio's name inside a job. Sarvam names the result after the input's position ("0.json"). */
const FILE_NAME = 'audio.mp3';

const JobSchema = z.object({ job_id: z.string().min(1) });
const SignedUrls = z.record(z.string(), z.object({ file_url: z.string() }));
const UploadSchema = z.object({ upload_urls: SignedUrls });
const DownloadSchema = z.object({ download_urls: SignedUrls });
const StatusSchema = z.object({
  job_state: z.string(),
  job_details: z
    .array(z.object({ state: z.string().nullish(), outputs: z.array(z.object({ file_name: z.string() })).nullish() }))
    .nullish(),
});
const ResultSchema = z.object({
  transcript: z.string().nullish(),
  timestamps: z
    .object({
      words: z.array(z.string()).nullish(),
      chunks: z.array(z.string()).nullish(),
      start_time_seconds: z.array(z.number()),
      end_time_seconds: z.array(z.number()),
    })
    .nullish(),
  diarized_transcript: z
    .object({
      entries: z.array(
        z.object({
          transcript: z.string(),
          start_time_seconds: z.number(),
          end_time_seconds: z.number(),
          speaker_id: z.union([z.string(), z.number()]),
        }),
      ),
    })
    .nullish(),
});
type SarvamResult = z.output<typeof ResultSchema>;

const FINISHED = new Set(['Completed', 'PartiallyCompleted', 'Failed']);
/** Failed status checks in a row that are tolerated. The job id is kept, so a later run can wait on the job again. */
const MAX_STATUS_MISSES = 5;

export interface SarvamOptions {
  apiKey: string;
  http?: HttpFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  /** Longest wait for one job's result. */
  maxWaitMs?: number;
}

/**
 * Sarvam saaras:v4 in codemix mode (Hindi in Devanagari, English words in Latin script), through the Batch API: the REST
 * API takes only 30 seconds of audio and has no speaker labels.
 */
export class SarvamProvider implements SttProvider {
  readonly id = 'sarvam' as const;
  /** A batch job takes files of up to 2 hours. */
  readonly maxPartSeconds = 7_200;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #maxWaitMs: number;

  constructor(opts: SarvamOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = opts.now ?? Date.now;
    this.#pollMs = opts.pollMs ?? 5_000;
    this.#maxWaitMs = opts.maxWaitMs ?? 3 * 3_600_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('sarvam', opts.diarize);
    let jobId = opts.resumeJobId;
    if (!jobId) {
      jobId = await this.#submit(audio, model, opts.diarize);
      opts.onJobId?.(jobId);
    }
    const outputName = await this.#waitForOutput(jobId);
    const raw = await this.#download(jobId, outputName);
    return { model, segments: toSegments(parseAnswer(ResultSchema, raw, 'unreadable_result'), audio.seconds), billedSeconds: null, raw };
  }

  async #submit(audio: AudioPart, model: string, diarize: boolean): Promise<string> {
    const params = { model, mode: 'codemix', language_code: 'hi-IN', with_timestamps: true, with_diarization: diarize };
    const { job_id: jobId } = parseAnswer(JobSchema, await this.#post('', { job_parameters: params }), 'unreadable_job');
    const urls = parseAnswer(UploadSchema, await this.#post('/upload-files', { job_id: jobId, files: [FILE_NAME] }), 'unreadable_upload_urls');
    // The signed storage link carries its own permission; the API key is never sent there.
    await requestOk(this.#http, storageUrl(urls.upload_urls[FILE_NAME]?.file_url), {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'audio/mpeg' },
      body: await openAsBlob(audio.path, { type: 'audio/mpeg' }),
      signal: AbortSignal.timeout(15 * 60_000),
    });
    await requestOk(this.#http, `${JOBS}/${jobId}/start`, { method: 'POST', headers: this.#headers(false), signal: AbortSignal.timeout(60_000) });
    return jobId;
  }

  async #waitForOutput(jobId: string): Promise<string> {
    const deadline = this.#now() + this.#maxWaitMs;
    let misses = 0;
    for (;;) {
      let status: z.output<typeof StatusSchema> | null = null;
      try {
        status = parseAnswer(StatusSchema, await this.#get(`/${jobId}/status`), 'unreadable_status');
        misses = 0;
      } catch {
        // A status check is free, so a few failures in a row are tolerated.
        if (++misses >= MAX_STATUS_MISSES) throw new SttNoAnswerError('status_unavailable');
      }
      if (status && FINISHED.has(status.job_state)) {
        const detail = status.job_details?.[0];
        const name = detail?.outputs?.[0]?.file_name;
        if (status.job_state === 'Failed' || detail?.state !== 'Success' || !name) {
          throw new SttJobError(codeOf(detail?.state ?? status.job_state));
        }
        return name;
      }
      if (this.#now() >= deadline) throw new SttNoAnswerError('job_wait_timeout');
      await this.#sleep(this.#pollMs);
    }
  }

  async #download(jobId: string, name: string): Promise<unknown> {
    const urls = parseAnswer(DownloadSchema, await this.#post('/download-files', { job_id: jobId, files: [name] }), 'unreadable_download_urls');
    return await requestJson(this.#http, storageUrl(urls.download_urls[name]?.file_url), { method: 'GET', signal: AbortSignal.timeout(5 * 60_000) });
  }

  #headers(json: boolean): Record<string, string> {
    return json ? { 'api-subscription-key': this.#key, 'content-type': 'application/json' } : { 'api-subscription-key': this.#key };
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return await requestJson(this.#http, `${JOBS}${path}`, {
      method: 'POST',
      headers: this.#headers(true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  }

  async #get(path: string): Promise<unknown> {
    return await requestJson(this.#http, `${JOBS}${path}`, { method: 'GET', headers: this.#headers(false), signal: AbortSignal.timeout(60_000) });
  }
}

/** Storage links come from Sarvam's answer; only https links are followed. */
function storageUrl(value: string | undefined): string {
  const url = value ? URL.parse(value) : null;
  if (!url || url.protocol !== 'https:') throw new SttNoAnswerError('bad_storage_url');
  return url.href;
}

/** "API Error" -> "api_error". */
function codeOf(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'failed';
}

/** Sarvam numbers speakers ("0", 1); a bare number would read like a time in the report. */
function speakerLabel(id: string | number): string {
  const s = String(id);
  return /^\d+$/.test(s) ? `speaker_${s}` : s;
}

function toSegments(r: SarvamResult, seconds: number): Segment[] {
  const entries = r.diarized_transcript?.entries ?? [];
  if (entries.length > 0) {
    return entries
      .map((e) => ({ start: e.start_time_seconds, end: e.end_time_seconds, speaker: speakerLabel(e.speaker_id), text: e.transcript.trim() }))
      .filter((s) => s.text !== '');
  }
  const t = r.timestamps;
  const texts = t?.words ?? t?.chunks ?? [];
  if (t && texts.length > 0) {
    return texts
      .map((text, i) => ({ start: t.start_time_seconds[i] ?? 0, end: t.end_time_seconds[i] ?? seconds, speaker: null, text: text.trim() }))
      .filter((s) => s.text !== '');
  }
  const text = (r.transcript ?? '').trim();
  return text ? [{ start: 0, end: seconds, speaker: null, text }] : [];
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/sarvam.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/providers/sarvam.ts tests/stt/providers/sarvam.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: Sarvam saaras:v4 batch adapter for the STT bake-off" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: ElevenLabs adapter

**Files:**
- Create: `src/stt/providers/elevenlabs.ts`
- Test: `tests/stt/providers/elevenlabs.test.ts`

Facts used (elevenlabs.io/docs, 2026-10-22):
- The request is `POST https://api.elevenlabs.io/v1/speech-to-text`, multipart, with the header `xi-api-key`.
- Fields: `model_id=scribe_v2`, `file`, `language_code`, `diarize`, `timestamps_granularity`, `tag_audio_events` (default true).
- The answer has `text`, `words[]` (`text`, `type` = `word` / `spacing` / `audio_event`, `start`, `end`, `speaker_id`) and `audio_duration_secs`.

- [ ] **Step 1: Write the failing test**

`tests/stt/providers/elevenlabs.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SttHttpError, type HttpFetch } from '../../../src/stt/http.ts';
import { ElevenLabsProvider } from '../../../src/stt/providers/elevenlabs.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

const ANSWER = {
  language_code: 'hin',
  language_probability: 0.97,
  text: 'Kal meeting hai. Haan theek.',
  audio_duration_secs: 4.2,
  words: [
    { text: 'Kal', start: 0, end: 0.3, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: ' ', start: 0.3, end: 0.35, type: 'spacing', speaker_id: 'speaker_0', logprob: 0 },
    { text: 'meeting', start: 0.35, end: 0.8, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: 'hai.', start: 0.85, end: 1.1, type: 'word', speaker_id: 'speaker_0', logprob: -0.1 },
    { text: 'Haan', start: 1.4, end: 1.7, type: 'word', speaker_id: 'speaker_1', logprob: -0.1 },
    { text: 'theek.', start: 1.75, end: 2.1, type: 'word', speaker_id: 'speaker_1', logprob: -0.1 },
  ],
};

function fake(res: () => Response) {
  const calls: { url: string; headers: Headers; form: FormData }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), form: init.body as FormData });
    return res();
  };
  return { http, calls };
}

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-eleven-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 4.2, offset: 0 };
});

describe('ElevenLabsProvider', () => {
  it('sends Scribe v2 with Hindi, word timings and no audio-event tags', async () => {
    const { http, calls } = fake(() => Response.json(ANSWER));
    await new ElevenLabsProvider({ apiKey: 'test-key', http }).transcribe(audio, { diarize: true });
    expect(calls).toHaveLength(1);
    const { url, headers, form } = calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(headers.get('xi-api-key')).toBe('test-key');
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('hin');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('false');
    expect((form.get('file') as File).name).toBe('audio.mp3');
  });

  it('groups words into segments by speaker and skips spacing', async () => {
    const { http } = fake(() => Response.json(ANSWER));
    const r = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true });
    expect(r.model).toBe('scribe_v2');
    expect(r.billedSeconds).toBe(4.2);
    expect(r.segments).toEqual([
      { start: 0, end: 1.1, speaker: 'speaker_0', text: 'Kal meeting hai.' },
      { start: 1.4, end: 2.1, speaker: 'speaker_1', text: 'Haan theek.' },
    ]);
  });

  it('sends diarize=false for voice notes', async () => {
    const { http, calls } = fake(() => Response.json(ANSWER));
    await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: false });
    expect(calls[0]!.form.get('diarize')).toBe('false');
  });

  it('falls back to the text when no word has timings', async () => {
    const { http } = fake(() => Response.json({ text: ' Theek hai ', words: [] }));
    const r = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: false });
    expect(r.segments).toEqual([{ start: 0, end: 4.2, speaker: null, text: 'Theek hai' }]);
    expect(r.billedSeconds).toBeNull();
  });

  it('throws SttHttpError on an error status and sends only once', async () => {
    const { http, calls } = fake(() => Response.json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, { status: 401 }));
    const err = await new ElevenLabsProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SttHttpError);
    expect(err).toMatchObject({ status: 401, detail: 'invalid_api_key' });
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/elevenlabs.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/providers/elevenlabs.ts`:

```ts
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import { wordsToSegments, type TimedWord } from '../segments.ts';
import type { AudioPart, ProviderResult, Segment, SttProvider, TranscribeOptions } from '../types.ts';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

const ResultSchema = z.object({
  text: z.string().nullish(),
  words: z
    .array(
      z.object({ text: z.string(), type: z.string(), start: z.number().nullish(), end: z.number().nullish(), speaker_id: z.string().nullish() }),
    )
    .nullish(),
  audio_duration_secs: z.number().nullish(),
});
type ElevenLabsResult = z.output<typeof ResultSchema>;

export interface ElevenLabsOptions {
  apiKey: string;
  http?: HttpFetch;
  timeoutMs?: number;
}

/**
 * ElevenLabs Scribe v2, one synchronous request per file. With language "hin", ElevenLabs keeps English words in Latin
 * script. Audio-event tags such as "(laughter)" are off. Nothing is retried, because each request is billed.
 */
export class ElevenLabsProvider implements SttProvider {
  readonly id = 'elevenlabs' as const;
  /** Files of up to 10 hours are accepted, so a meeting goes in whole and keeps one set of speaker labels. */
  readonly maxPartSeconds = 36_000;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: ElevenLabsOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('elevenlabs', opts.diarize);
    const form = new FormData();
    form.append('model_id', model);
    form.append('file', await openAsBlob(audio.path, { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('language_code', 'hin');
    form.append('diarize', String(opts.diarize));
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    const raw = await requestJson(this.#http, ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': this.#key },
      body: form,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const r = parseAnswer(ResultSchema, raw, 'unreadable_result');
    return { model, segments: toSegments(r, audio.seconds), billedSeconds: r.audio_duration_secs ?? null, raw };
  }
}

function toSegments(r: ElevenLabsResult, seconds: number): Segment[] {
  const words: TimedWord[] = (r.words ?? []).flatMap((w) =>
    w.type === 'word' && typeof w.start === 'number' && typeof w.end === 'number'
      ? [{ text: w.text, start: w.start, end: w.end, speaker: w.speaker_id ?? null }]
      : [],
  );
  if (words.length > 0) return wordsToSegments(words);
  const text = (r.text ?? '').trim();
  return text ? [{ start: 0, end: seconds, speaker: null, text }] : [];
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/elevenlabs.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/providers/elevenlabs.ts tests/stt/providers/elevenlabs.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: ElevenLabs Scribe v2 adapter for the STT bake-off" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: OpenAI adapter

**Files:**
- Create: `src/stt/providers/openai.ts`
- Test: `tests/stt/providers/openai.test.ts`

Facts used (developers.openai.com, 2026-10-22):
- The request is `POST https://api.openai.com/v1/audio/transcriptions`, multipart, with `Authorization: Bearer <key>`.
- `gpt-transcribe` takes `languages[]` (do not also send `language`), and its default answer is `{ text }`.
- `gpt-4o-transcribe-diarize`:
  - needs `chunking_strategy=auto` for audio over 30 s;
  - `response_format=diarized_json` answers `{ segments[{start,end,text,speaker}], usage:{type:'duration',seconds} }`.

- [ ] **Step 1: Write the failing test**

`tests/stt/providers/openai.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HttpFetch } from '../../../src/stt/http.ts';
import { OpenAiProvider } from '../../../src/stt/providers/openai.ts';
import type { AudioPart } from '../../../src/stt/types.ts';

function fake(answer: unknown) {
  const calls: { url: string; headers: Headers; form: FormData }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers), form: init.body as FormData });
    return Response.json(answer);
  };
  return { http, calls };
}

let audio: AudioPart;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stt-openai-'));
  const path = join(dir, 'a.mp3');
  writeFileSync(path, 'fake mp3 bytes');
  audio = { path, seconds: 42, offset: 0 };
});

describe('OpenAiProvider', () => {
  it('sends voice notes to gpt-transcribe with Hindi and English hints', async () => {
    const { http, calls } = fake({ text: ' Kal 4 baje call karte hain. ', languages: [{ code: 'hi' }] });
    const r = await new OpenAiProvider({ apiKey: 'test-key', http }).transcribe(audio, { diarize: false });
    const { url, headers, form } = calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(headers.get('authorization')).toBe('Bearer test-key');
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.getAll('languages[]')).toEqual(['hi', 'en']);
    expect(form.has('language')).toBe(false);
    expect(form.has('response_format')).toBe(false);
    expect((form.get('file') as File).name).toBe('audio.mp3');
    expect(r).toMatchObject({ model: 'gpt-transcribe', billedSeconds: null });
    expect(r.segments).toEqual([{ start: 0, end: 42, speaker: null, text: 'Kal 4 baje call karte hain.' }]);
  });

  it('sends meetings to the diarize model and keeps its speakers', async () => {
    const { http, calls } = fake({
      task: 'transcribe',
      duration: 27.4,
      text: 'A: Namaste\nB: Haan ji',
      segments: [
        { type: 'transcript.text.segment', id: 'seg_001', start: 0, end: 4.7, text: ' Namaste ', speaker: 'A' },
        { type: 'transcript.text.segment', id: 'seg_002', start: 4.7, end: 6, text: 'Haan ji', speaker: 'B' },
      ],
      usage: { type: 'duration', seconds: 27 },
    });
    const r = await new OpenAiProvider({ apiKey: 'k', http }).transcribe(audio, { diarize: true });
    const { form } = calls[0]!;
    expect(form.get('model')).toBe('gpt-4o-transcribe-diarize');
    expect(form.get('response_format')).toBe('diarized_json');
    expect(form.get('chunking_strategy')).toBe('auto');
    expect(form.has('languages[]')).toBe(false);
    expect(r.billedSeconds).toBe(27);
    expect(r.segments).toEqual([
      { start: 0, end: 4.7, speaker: 'A', text: 'Namaste' },
      { start: 4.7, end: 6, speaker: 'B', text: 'Haan ji' },
    ]);
  });

  it('caps each request at 5 minutes of audio', () => {
    expect(new OpenAiProvider({ apiKey: 'k' }).maxPartSeconds).toBe(300);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/openai.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/providers/openai.ts`:

```ts
import { openAsBlob } from 'node:fs';
import { z } from 'zod';
import { longFetch, parseAnswer, requestJson, type HttpFetch } from '../http.ts';
import { modelFor } from '../prices.ts';
import type { AudioPart, ProviderResult, SttProvider, TranscribeOptions } from '../types.ts';

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

const UsageSchema = z.object({ type: z.string(), seconds: z.number().nullish() }).nullish();
const TextSchema = z.object({ text: z.string(), usage: UsageSchema });
const DiarizedSchema = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), speaker: z.string().nullish() })),
  usage: UsageSchema,
});

export interface OpenAiOptions {
  apiKey: string;
  http?: HttpFetch;
  timeoutMs?: number;
}

/**
 * OpenAI transcription. Voice notes use gpt-transcribe with the hints "hi" and "en" for code-switched speech. Meetings
 * use gpt-4o-transcribe-diarize, OpenAI's only model with speaker labels, which shuts down on 2027-02-26.
 */
export class OpenAiProvider implements SttProvider {
  readonly id = 'openai' as const;
  /**
   * A request may carry 25 MB, and the diarize model writes at most 2,000 output tokens per request: 5 minutes of fast
   * Hinglish stays under both. Speaker labels restart in every part.
   */
  readonly maxPartSeconds = 300;
  readonly #key: string;
  readonly #http: HttpFetch;
  readonly #timeoutMs: number;

  constructor(opts: OpenAiOptions) {
    this.#key = opts.apiKey;
    this.#http = opts.http ?? longFetch;
    this.#timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  async transcribe(audio: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    const { model } = modelFor('openai', opts.diarize);
    const form = new FormData();
    form.append('model', model);
    form.append('file', await openAsBlob(audio.path, { type: 'audio/mpeg' }), 'audio.mp3');
    if (opts.diarize) {
      form.append('response_format', 'diarized_json');
      form.append('chunking_strategy', 'auto');
    } else {
      form.append('languages[]', 'hi');
      form.append('languages[]', 'en');
    }
    const raw = await requestJson(this.#http, ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#key}` },
      body: form,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (opts.diarize) {
      const r = parseAnswer(DiarizedSchema, raw, 'unreadable_result');
      const segments = r.segments
        .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker ?? null, text: s.text.trim() }))
        .filter((s) => s.text !== '');
      return { model, segments, billedSeconds: billedSeconds(r.usage), raw };
    }
    const r = parseAnswer(TextSchema, raw, 'unreadable_result');
    const text = r.text.trim();
    return { model, segments: text ? [{ start: 0, end: audio.seconds, speaker: null, text }] : [], billedSeconds: billedSeconds(r.usage), raw };
  }
}

function billedSeconds(usage: z.output<typeof UsageSchema>): number | null {
  return usage?.type === 'duration' && typeof usage.seconds === 'number' ? usage.seconds : null;
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/providers/openai.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/providers/openai.ts tests/stt/providers/openai.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: OpenAI transcription adapter for the STT bake-off" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: ffmpeg wrapper

**Files:**
- Create: `src/stt/audio.ts`
- Test: `tests/stt/audio.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/audio.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ffmpeg, findFfmpeg, parseDuration, type RunFile } from '../../src/stt/audio.ts';

const BANNER =
  "Input #0, ogg, from 'a.ogg':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 31 kb/s\n" +
  '  Stream #0:0: Audio: opus, 16000 Hz, mono\nAt least one output file must be specified\n';

function fakeRun(handler: (args: readonly string[]) => { code: number; stderr?: string }) {
  const calls: (readonly string[])[] = [];
  const run: RunFile = async (_file, args) => {
    calls.push(args);
    const r = handler(args);
    return { code: r.code, stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

const lastArg = (args: readonly string[]): string => args[args.length - 1]!;

describe('parseDuration', () => {
  it('reads hours, minutes and seconds', () => {
    expect(parseDuration(BANNER)).toBe(62.5);
    expect(parseDuration('  Duration: 01:30:00.00, start: 0')).toBe(5400);
  });

  it('is null when the duration is missing or N/A', () => {
    expect(parseDuration('  Duration: N/A, bitrate: N/A')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('Ffmpeg', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stt-audio-'));
  });

  it('measures a file from the input summary', async () => {
    const { run, calls } = fakeRun(() => ({ code: 1, stderr: BANNER }));
    expect(await new Ffmpeg('ffmpeg.exe', run).seconds('a.ogg')).toBe(62.5);
    expect(calls[0]).toEqual(['-hide_banner', '-nostdin', '-i', 'a.ogg']);
  });

  it('throws AudioError when there is no duration', async () => {
    const { run } = fakeRun(() => ({ code: 1, stderr: 'a.ogg: Invalid data found when processing input' }));
    await expect(new Ffmpeg('ffmpeg.exe', run).seconds('a.ogg')).rejects.toMatchObject({ name: 'AudioError', code: 'no_duration' });
  });

  it('converts to mono 16 kHz MP3 through a temporary file', async () => {
    const { run, calls } = fakeRun((args) => {
      writeFileSync(lastArg(args), 'mp3');
      return { code: 0 };
    });
    const out = join(dir, 'x.mp3');
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', out);
    const args = calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['-i', 'in.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k']));
    expect(lastArg(args)).toBe(`${out}.part.mp3`);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.part.mp3`)).toBe(false);
  });

  it('keeps an existing MP3 without running ffmpeg', async () => {
    const out = join(dir, 'x.mp3');
    writeFileSync(out, 'old');
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    await new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', out);
    expect(calls).toHaveLength(0);
    expect(readFileSync(out, 'utf8')).toBe('old');
  });

  it('throws when the conversion fails', async () => {
    const { run } = fakeRun(() => ({ code: 1 }));
    await expect(new Ffmpeg('ffmpeg.exe', run).toMp3('in.mp4', join(dir, 'y.mp3'))).rejects.toMatchObject({ code: 'convert_failed' });
  });

  it('returns a short file as one part without running ffmpeg', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    const input = { path: 'a.mp3', seconds: 200, offset: 0 };
    expect(await new Ffmpeg('ffmpeg.exe', run).split(input, join(dir, 'parts'), 300)).toEqual([input]);
    expect(calls).toHaveLength(0);
  });

  it('splits a long file and measures each part for exact offsets', async () => {
    const lengths: Record<string, string> = { 'part-000.mp3': '00:05:00.50', 'part-001.mp3': '00:02:10.00' };
    const { run, calls } = fakeRun((args) => {
      if (args.includes('segment')) {
        const pattern = lastArg(args);
        writeFileSync(pattern.replace('%03d', '000'), 'a');
        writeFileSync(pattern.replace('%03d', '001'), 'b');
        return { code: 0 };
      }
      return { code: 1, stderr: `  Duration: ${lengths[basename(lastArg(args))]}, start: 0` };
    });
    const ff = new Ffmpeg('ffmpeg.exe', run);
    const partsDir = join(dir, 'parts');
    const long = { path: 'long.mp3', seconds: 430, offset: 0 };
    expect(await ff.split(long, partsDir, 300)).toEqual([
      { path: join(partsDir, 'part-000.mp3'), seconds: 300.5, offset: 0 },
      { path: join(partsDir, 'part-001.mp3'), seconds: 130, offset: 300.5 },
    ]);
    expect(calls[0]).toEqual(expect.arrayContaining(['-i', 'long.mp3', '-f', 'segment', '-segment_time', '300', '-c', 'copy']));
    // A second call reuses the finished parts instead of cutting again.
    await ff.split(long, partsDir, 300);
    expect(calls.filter((a) => a.includes('segment'))).toHaveLength(1);
  });
});

describe('findFfmpeg', () => {
  it('uses FFMPEG_PATH when it starts', async () => {
    const { run, calls } = fakeRun(() => ({ code: 0 }));
    expect(await findFfmpeg('C:\\tools\\ffmpeg.exe', run)).toBe('C:\\tools\\ffmpeg.exe');
    expect(calls[0]).toEqual(['-hide_banner', '-version']);
  });

  it('falls back to ffmpeg on PATH', async () => {
    const { run } = fakeRun(() => ({ code: 0 }));
    expect(await findFfmpeg(undefined, run)).toBe('ffmpeg');
  });

  it('is null when ffmpeg does not start', async () => {
    const { run } = fakeRun(() => ({ code: -1 }));
    expect(await findFfmpeg(undefined, run)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/audio.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/audio.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AudioPart } from './types.ts';

/** Runs a program without a shell. Resolves with its exit code (-1 when it could not start or was stopped) and stderr. */
export type RunFile = (file: string, args: readonly string[], timeoutMs: number) => Promise<{ code: number; stderr: string }>;

export const runFile: RunFile = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, _stdout, stderr) => {
      resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stderr });
    });
  });

export class AudioError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`Audio step failed (${code})`);
    this.name = 'AudioError';
    this.code = code;
  }
}

/** "Duration: 00:01:02.50" in ffmpeg's input summary -> 62.5 seconds. Null when it is missing or "N/A". */
export function parseDuration(stderr: string): number | null {
  const m = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error'];

export class Ffmpeg {
  readonly #exe: string;
  readonly #run: RunFile;

  constructor(exe: string, run: RunFile = runFile) {
    this.#exe = exe;
    this.#run = run;
  }

  /** Length in seconds, read from ffmpeg's input summary, so ffprobe is not needed. */
  async seconds(input: string): Promise<number> {
    // With no output named, ffmpeg exits with an error, after printing the input summary.
    const { stderr } = await this.#run(this.#exe, ['-hide_banner', '-nostdin', '-i', input], 60_000);
    const seconds = parseDuration(stderr);
    if (seconds === null || !(seconds > 0)) throw new AudioError('no_duration');
    return seconds;
  }

  /**
   * Mono 16 kHz MP3 at 64 kbit/s, the one format all three providers document; the video track of a recording is
   * dropped. An existing output is kept, and a new one appears only when complete (written under a temporary name).
   */
  async toMp3(input: string, output: string): Promise<void> {
    if (existsSync(output)) return;
    const tmp = `${output}.part.mp3`;
    const args = [...QUIET, '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', tmp];
    const { code } = await this.#run(this.#exe, args, 60 * 60_000);
    if (code !== 0 || !existsSync(tmp)) throw new AudioError('convert_failed');
    renameSync(tmp, output);
  }

  /**
   * Cuts a prepared MP3 into parts of at most partSeconds without re-encoding, into its own folder, and measures every
   * part so the offsets are exact. A folder that was finished before is reused.
   */
  async split(input: AudioPart, dir: string, partSeconds: number): Promise<AudioPart[]> {
    if (input.seconds <= partSeconds) return [input];
    const finished = join(dir, '.done');
    if (!existsSync(finished)) {
      mkdirSync(dir, { recursive: true });
      const args = [...QUIET, '-y', '-i', input.path, '-f', 'segment', '-segment_time', String(partSeconds), '-c', 'copy', join(dir, 'part-%03d.mp3')];
      const { code } = await this.#run(this.#exe, args, 30 * 60_000);
      if (code !== 0) throw new AudioError('split_failed');
      writeFileSync(finished, '');
    }
    const files = readdirSync(dir).filter((f) => /^part-\d{3}\.mp3$/.test(f)).sort();
    if (files.length === 0) throw new AudioError('split_failed');
    const parts: AudioPart[] = [];
    let offset = input.offset;
    for (const f of files) {
      const path = join(dir, f);
      const seconds = await this.seconds(path);
      parts.push({ path, seconds, offset });
      offset += seconds;
    }
    return parts;
  }
}

/** The ffmpeg to use: FFMPEG_PATH when set, otherwise "ffmpeg" on PATH. Null when it does not start. */
export async function findFfmpeg(configured: string | undefined, run: RunFile = runFile): Promise<string | null> {
  const exe = configured ?? 'ffmpeg';
  const { code } = await run(exe, ['-hide_banner', '-version'], 15_000);
  return code === 0 ? exe : null;
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/audio.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/audio.ts tests/stt/audio.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: ffmpeg wrapper to measure, convert and split bake-off audio" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings and samples

**Files:**
- Create: `src/stt/bakeoff/env.ts`, `src/stt/bakeoff/samples.ts`
- Test: `tests/stt/bakeoff/env.test.ts`, `tests/stt/bakeoff/samples.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/stt/bakeoff/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { KEY_NAMES, parseBakeoffEnv } from '../../../src/stt/bakeoff/env.ts';

describe('parseBakeoffEnv', () => {
  it('treats every key as optional and defaults the rupee rate', () => {
    expect(parseBakeoffEnv({})).toEqual({ INR_PER_USD: 88 });
  });

  it('reads the bake-off settings and ignores everything else', () => {
    const env = parseBakeoffEnv({ SARVAM_API_KEY: 's', FFMPEG_PATH: 'C:\\f.exe', INR_PER_USD: '90', ANTHROPIC_API_KEY: 'other', EMPTY: '' });
    expect(env).toEqual({ SARVAM_API_KEY: 's', FFMPEG_PATH: 'C:\\f.exe', INR_PER_USD: 90 });
  });

  it('treats an empty value as unset', () => {
    expect(parseBakeoffEnv({ OPENAI_API_KEY: '' }).OPENAI_API_KEY).toBeUndefined();
  });

  it('names a bad setting without echoing its value', () => {
    expect(() => parseBakeoffEnv({ INR_PER_USD: 'secret-looking-value' })).toThrow(/INR_PER_USD/);
    expect(() => parseBakeoffEnv({ INR_PER_USD: 'secret-looking-value' })).not.toThrow(/secret-looking-value/);
  });

  it('maps each provider to its key name', () => {
    expect(KEY_NAMES).toEqual({ sarvam: 'SARVAM_API_KEY', elevenlabs: 'ELEVENLABS_API_KEY', openai: 'OPENAI_API_KEY' });
  });
});
```

`tests/stt/bakeoff/samples.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSamples, insideGitRepo } from '../../../src/stt/bakeoff/samples.ts';

describe('findSamples', () => {
  it('finds audio and video files in voice-notes and meetings, sorted, with unique ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-samples-'));
    mkdirSync(join(root, 'voice-notes', 'sub'), { recursive: true });
    mkdirSync(join(root, 'meetings'));
    for (const f of ['b.ogg', 'A note.opus', 'a-note.ogg', 'readme.txt', 'मीटिंग.OGG']) writeFileSync(join(root, 'voice-notes', f), 'x');
    writeFileSync(join(root, 'voice-notes', 'sub', 'hidden.ogg'), 'x');
    writeFileSync(join(root, 'meetings', 'Client Call 1.mp4'), 'x');
    expect(findSamples(root)).toEqual([
      { id: 'voice-a-note', kind: 'voice', path: join(root, 'voice-notes', 'A note.opus') },
      { id: 'voice-a-note-2', kind: 'voice', path: join(root, 'voice-notes', 'a-note.ogg') },
      { id: 'voice-b', kind: 'voice', path: join(root, 'voice-notes', 'b.ogg') },
      { id: 'voice-file', kind: 'voice', path: join(root, 'voice-notes', 'मीटिंग.OGG') },
      { id: 'meeting-client-call-1', kind: 'meeting', path: join(root, 'meetings', 'Client Call 1.mp4') },
    ]);
  });

  it('returns nothing when the folders are missing', () => {
    expect(findSamples(mkdtempSync(join(tmpdir(), 'stt-empty-')))).toEqual([]);
  });
});

describe('insideGitRepo', () => {
  it('is true for a folder below one holding .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-git-'));
    mkdirSync(join(root, 'repo', '.git'), { recursive: true });
    expect(insideGitRepo(join(root, 'repo', 'x', 'y'))).toBe(true);
  });

  it('is true for a worktree, whose .git is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'stt-wt-'));
    writeFileSync(join(root, '.git'), 'gitdir: elsewhere');
    expect(insideGitRepo(join(root, 'out'))).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(insideGitRepo(mkdtempSync(join(tmpdir(), 'stt-plain-')))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/env.test.ts tests/stt/bakeoff/samples.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the settings**

`src/stt/bakeoff/env.ts`:

```ts
import { z } from 'zod';
import type { ProviderId } from '../types.ts';

const BakeoffEnvSchema = z.object({
  SARVAM_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  FFMPEG_PATH: z.string().min(1).optional(),
  STT_SAMPLES_DIR: z.string().min(1).optional(),
  INR_PER_USD: z.coerce.number().positive().default(88),
});

export type BakeoffEnv = z.infer<typeof BakeoffEnvSchema>;

export const KEY_NAMES = {
  sarvam: 'SARVAM_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const satisfies Record<ProviderId, keyof BakeoffEnv>;

export function parseBakeoffEnv(source: Record<string, string | undefined>): BakeoffEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = BakeoffEnvSchema.safeParse(cleaned);
  if (!result.success) {
    // Variable names only. Never include values: they may be secrets.
    const names = [...new Set(result.error.issues.map((i) => i.path.map(String).join('.')))];
    throw new Error(`Invalid configuration in: ${names.join(', ')}`);
  }
  return result.data;
}

/** The bake-off settings from .env in the current folder (the worktree root), then from the process environment. */
export function loadBakeoffEnv(file = '.env'): BakeoffEnv {
  try {
    process.loadEnvFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return parseBakeoffEnv(process.env);
}
```

- [ ] **Step 4: Implement the samples**

`src/stt/bakeoff/samples.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { dirname, extname, join, parse, resolve } from 'node:path';
import type { SampleKind } from '../types.ts';

export interface Sample {
  /** Stable id built from the file name; names the sample's files in the output folder. */
  id: string;
  kind: SampleKind;
  path: string;
}

export const SAMPLE_FOLDERS: Record<SampleKind, string> = { voice: 'voice-notes', meeting: 'meetings' };

const MEDIA_EXTENSIONS = new Set(['.ogg', '.opus', '.oga', '.m4a', '.mp3', '.wav', '.aac', '.amr', '.flac', '.mp4', '.webm', '.mkv', '.mov']);

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'file';
}

/** Audio and video files directly inside <root>\voice-notes and <root>\meetings, sorted by name. Sub-folders are ignored. */
export function findSamples(root: string): Sample[] {
  const out: Sample[] = [];
  const used = new Set<string>();
  for (const kind of ['voice', 'meeting'] as const) {
    const dir = join(root, SAMPLE_FOLDERS[kind]);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && MEDIA_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const base = `${kind}-${slug(parse(name).name)}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      out.push({ id, kind, path: join(dir, name) });
    }
  }
  return out;
}

/** True when dir, or a folder above it, holds a .git entry: a repository, or a worktree (where .git is a file). */
export function insideGitRepo(dir: string): boolean {
  let p = resolve(dir);
  for (;;) {
    if (existsSync(join(p, '.git'))) return true;
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
}
```

- [ ] **Step 5: Run the tests to make sure they pass**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/env.test.ts tests/stt/bakeoff/samples.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/env.ts src/stt/bakeoff/samples.ts tests/stt/bakeoff/env.test.ts tests/stt/bakeoff/samples.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off settings, sample discovery and repository guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Ledger

**Files:**
- Create: `src/stt/bakeoff/ledger.ts`
- Test: `tests/stt/bakeoff/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/bakeoff/ledger.test.ts`:

```ts
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Ledger, type Attempt, type Outcome } from '../../../src/stt/bakeoff/ledger.ts';

let dir: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-ledger-'));
  ledger = new Ledger(dir);
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  sampleId: 'voice-a',
  provider: 'sarvam',
  model: 'saaras:v4',
  startedAt: '2026-10-22T10:00:00.000Z',
  jobIds: {},
  ...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  sampleId: 'voice-a',
  kind: 'voice',
  provider: 'sarvam',
  model: 'saaras:v4',
  status: 'done',
  audioSeconds: 42,
  billedSeconds: null,
  costUsd: 0.004,
  processingSeconds: 12.5,
  parts: 1,
  error: null,
  segments: [{ start: 0, end: 42, speaker: null, text: 'Kal milte hain' }],
  finishedAt: '2026-10-22T10:01:00.000Z',
  ...over,
});

describe('Ledger', () => {
  it('moves a slot from new to unknown to done', () => {
    expect(ledger.state('voice-a', 'sarvam')).toBe('new');
    ledger.begin(attempt());
    expect(ledger.state('voice-a', 'sarvam')).toBe('unknown');
    ledger.finish(outcome());
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
    expect(ledger.outcome('voice-a', 'sarvam')).toEqual(outcome());
  });

  it('reports a failed outcome as failed', () => {
    ledger.begin(attempt());
    ledger.finish(outcome({ status: 'failed', error: 'http_401', segments: [] }));
    expect(ledger.state('voice-a', 'sarvam')).toBe('failed');
  });

  it('keeps slots of different providers apart', () => {
    ledger.begin(attempt());
    expect(ledger.state('voice-a', 'openai')).toBe('new');
  });

  it('saves job ids on the attempt', () => {
    ledger.begin(attempt());
    ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1');
    expect(ledger.attempt('voice-a', 'sarvam')?.jobIds).toEqual({ '0': 'job-1' });
  });

  it('refuses a job id before the attempt exists', () => {
    expect(() => ledger.saveJobId('voice-a', 'sarvam', 0, 'job-1')).toThrow();
  });

  it('stores and returns each part answer', () => {
    const part = { model: 'm', segments: [], billedSeconds: 30, raw: { ok: true } };
    expect(ledger.part('voice-a', 'openai', 1)).toBeNull();
    ledger.savePart('voice-a', 'openai', 1, part);
    expect(ledger.part('voice-a', 'openai', 1)).toEqual(part);
  });

  it('moves a failed outcome aside on reopen and keeps it on disk', () => {
    ledger.begin(attempt());
    ledger.finish(outcome({ status: 'failed', error: 'http_500', segments: [] }));
    ledger.reopen('voice-a', 'sarvam');
    expect(ledger.outcome('voice-a', 'sarvam')).toBeNull();
    expect(readdirSync(join(dir, 'results', 'voice-a')).some((f) => f.startsWith('sarvam.failed-'))).toBe(true);
  });

  it('lists finished outcomes only', () => {
    ledger.begin(attempt());
    ledger.finish(outcome());
    ledger.begin(attempt({ sampleId: 'meeting-b', provider: 'openai' }));
    ledger.savePart('meeting-b', 'openai', 0, { model: 'm', segments: [], billedSeconds: null, raw: {} });
    expect(ledger.outcomes()).toEqual([outcome()]);
  });

  it('lists nothing before the first run', () => {
    expect(ledger.outcomes()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/ledger.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/bakeoff/ledger.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROVIDER_IDS, type ProviderId, type ProviderResult, type SampleKind, type Segment } from '../types.ts';

/** new: never sent. unknown: sent, and no outcome was recorded. done / failed: the outcome. */
export type SlotState = 'new' | 'done' | 'failed' | 'unknown';

/** Written before the first paid request of a slot, so a crash or a lost answer leaves evidence. */
export interface Attempt {
  sampleId: string;
  provider: ProviderId;
  model: string;
  startedAt: string;
  /** Provider job ids by part number, so a later run can wait on a job instead of paying twice. */
  jobIds: Record<string, string>;
}

export interface Outcome {
  sampleId: string;
  kind: SampleKind;
  provider: ProviderId;
  model: string;
  status: 'done' | 'failed';
  audioSeconds: number;
  billedSeconds: number | null;
  /** List-price cost; 0 for a failed slot (the provider's dashboard has the real figure). */
  costUsd: number;
  processingSeconds: number;
  parts: number;
  /** A short code such as "http_401 invalid_api_key"; never provider text. */
  error: string | null;
  segments: Segment[];
  finishedAt: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : null;
}

/**
 * The bake-off's state on disk, all inside the private output folder:
 * - results/<sample>/<provider>.attempt.json: written before sending;
 * - results/<sample>/<provider>.part-<n>.json: each part's answer, reused by a retry;
 * - results/<sample>/<provider>.json: the outcome.
 */
export class Ledger {
  readonly #dir: string;

  constructor(outDir: string) {
    this.#dir = join(outDir, 'results');
  }

  state(sampleId: string, provider: ProviderId): SlotState {
    const outcome = this.outcome(sampleId, provider);
    if (outcome) return outcome.status;
    return this.attempt(sampleId, provider) ? 'unknown' : 'new';
  }

  outcome(sampleId: string, provider: ProviderId): Outcome | null {
    return readJson(this.#file(sampleId, provider, '')) as Outcome | null;
  }

  attempt(sampleId: string, provider: ProviderId): Attempt | null {
    return readJson(this.#file(sampleId, provider, '.attempt')) as Attempt | null;
  }

  begin(attempt: Attempt): void {
    writeJson(this.#file(attempt.sampleId, attempt.provider, '.attempt'), attempt);
  }

  saveJobId(sampleId: string, provider: ProviderId, part: number, jobId: string): void {
    const attempt = this.attempt(sampleId, provider);
    if (!attempt) throw new Error('saveJobId called before begin');
    attempt.jobIds[String(part)] = jobId;
    this.begin(attempt);
  }

  part(sampleId: string, provider: ProviderId, n: number): ProviderResult | null {
    return readJson(this.#file(sampleId, provider, `.part-${n}`)) as ProviderResult | null;
  }

  savePart(sampleId: string, provider: ProviderId, n: number, result: ProviderResult): void {
    writeJson(this.#file(sampleId, provider, `.part-${n}`), result);
  }

  finish(outcome: Outcome): void {
    writeJson(this.#file(outcome.sampleId, outcome.provider, ''), outcome);
  }

  /** Moves a failed outcome aside, kept on disk as a record, so the slot can be sent again. */
  reopen(sampleId: string, provider: ProviderId): void {
    const path = this.#file(sampleId, provider, '');
    if (existsSync(path)) renameSync(path, this.#file(sampleId, provider, `.failed-${Date.now()}`));
  }

  outcomes(): Outcome[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => PROVIDER_IDS.map((p) => this.outcome(d.name, p)).filter((o): o is Outcome => o !== null));
  }

  #file(sampleId: string, provider: ProviderId, suffix: string): string {
    return join(this.#dir, sampleId, `${provider}${suffix}.json`);
  }
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/ledger.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/ledger.ts tests/stt/bakeoff/ledger.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off ledger with attempt, part and outcome files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Run plan and dry-run listing

**Files:**
- Create: `src/stt/bakeoff/plan.ts`
- Test: `tests/stt/bakeoff/plan.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/bakeoff/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SlotState } from '../../../src/stt/bakeoff/ledger.ts';
import { buildPlan, formatPlan, planTotalUsd, type PlanInput } from '../../../src/stt/bakeoff/plan.ts';
import type { Sample } from '../../../src/stt/bakeoff/samples.ts';

const voice: Sample = { id: 'voice-a', kind: 'voice', path: 'C:\\stt-samples\\voice-notes\\a.ogg' };
const meeting: Sample = { id: 'meeting-b', kind: 'meeting', path: 'C:\\stt-samples\\meetings\\b.mp4' };
const PROVIDERS = [
  { id: 'sarvam' as const, maxPartSeconds: 7200 },
  { id: 'elevenlabs' as const, maxPartSeconds: 36000 },
  { id: 'openai' as const, maxPartSeconds: 300 },
];

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    samples: [
      { sample: voice, seconds: 60 },
      { sample: meeting, seconds: 3600 },
    ],
    providers: PROVIDERS,
    stateOf: () => 'new',
    hasJobId: () => false,
    retryFailed: false,
    retryUnknown: false,
    inrPerUsd: 90,
    ...over,
  };
}

describe('buildPlan', () => {
  it('makes one item per sample and provider, with models, parts and speaker labels for meetings', () => {
    const items = buildPlan(input());
    expect(items.map((i) => [i.sample.id, i.provider, i.model, i.diarize, i.parts, i.action])).toEqual([
      ['voice-a', 'sarvam', 'saaras:v4', false, 1, 'send'],
      ['voice-a', 'elevenlabs', 'scribe_v2', false, 1, 'send'],
      ['voice-a', 'openai', 'gpt-transcribe', false, 1, 'send'],
      ['meeting-b', 'sarvam', 'saaras:v4', true, 1, 'send'],
      ['meeting-b', 'elevenlabs', 'scribe_v2', true, 1, 'send'],
      ['meeting-b', 'openai', 'gpt-4o-transcribe-diarize', true, 12, 'send'],
    ]);
  });

  it('estimates list prices and totals them', () => {
    const items = buildPlan(input());
    const meetingSarvam = items.find((i) => i.sample.id === 'meeting-b' && i.provider === 'sarvam')!;
    expect(meetingSarvam.estimateUsd).toBeCloseTo(0.4, 10); // ₹36 at ₹90/$
    // 60 s voice: sarvam ₹0.5/90 + elevenlabs 0.22/60 + openai 0.27/60; 1 h meeting: 0.4 + 0.22 + 0.36.
    expect(planTotalUsd(items)).toBeCloseTo(0.5 / 90 + 0.22 / 60 + 0.27 / 60 + 0.4 + 0.22 + 0.36, 10);
  });

  it('skips finished slots and sends failed or unanswered ones only when asked', () => {
    const states: Record<string, SlotState> = { sarvam: 'done', elevenlabs: 'failed', openai: 'unknown' };
    const only = { samples: [{ sample: voice, seconds: 60 }], stateOf: (_s: string, p: string) => states[p]! };
    expect(buildPlan(input(only)).map((i) => i.action)).toEqual(['skip', 'skip', 'skip']);
    expect(buildPlan(input({ ...only, retryFailed: true, retryUnknown: true })).map((i) => i.action)).toEqual(['skip', 'send', 'send']);
    expect(buildPlan(input(only)).every((i) => i.estimateUsd === 0)).toBe(true);
  });

  it('waits on a saved job for free instead of sending again', () => {
    const items = buildPlan(input({
      samples: [{ sample: meeting, seconds: 3600 }],
      stateOf: (_s, p) => (p === 'sarvam' ? 'unknown' : 'done'),
      hasJobId: (_s, p) => p === 'sarvam',
      retryUnknown: true,
    }));
    expect(items[0]).toMatchObject({ provider: 'sarvam', action: 'resume', estimateUsd: 0 });
  });
});

describe('formatPlan', () => {
  it('lists every slot, the files that would be uploaded and the estimate', () => {
    const text = formatPlan(buildPlan(input()));
    expect(text).toContain('meeting-b');
    expect(text).toContain('gpt-4o-transcribe-diarize in 12 parts');
    expect(text).toContain('Files whose audio would be uploaded (2):');
    expect(text).toContain('C:\\stt-samples\\meetings\\b.mp4');
    expect(text).toMatch(/Estimated cost: \$\d+\.\d{2} at list prices\./);
  });

  it('warns when an unanswered slot would be sent again', () => {
    const text = formatPlan(buildPlan(input({ samples: [{ sample: voice, seconds: 60 }], stateOf: () => 'unknown', retryUnknown: true })));
    expect(text).toContain('send again (an earlier attempt may already be billed)');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/plan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/bakeoff/plan.ts`:

```ts
import { costUsd, modelFor } from '../prices.ts';
import { formatClock } from '../segments.ts';
import type { ProviderId } from '../types.ts';
import type { SlotState } from './ledger.ts';
import type { Sample } from './samples.ts';

/** send: a new paid request. resume: wait on a saved provider job (no new charge). skip: nothing. */
export type Action = 'send' | 'resume' | 'skip';

export interface PlanItem {
  sample: Sample;
  /** Length of the original recording. */
  seconds: number;
  provider: ProviderId;
  model: string;
  diarize: boolean;
  parts: number;
  state: SlotState;
  action: Action;
  /** List-price estimate of what this run would send; 0 for skips and resumed jobs. */
  estimateUsd: number;
}

export interface PlanInput {
  samples: readonly { sample: Sample; seconds: number }[];
  providers: readonly { id: ProviderId; maxPartSeconds: number }[];
  stateOf: (sampleId: string, provider: ProviderId) => SlotState;
  /** True when an unanswered slot has a saved provider job id to wait on. */
  hasJobId: (sampleId: string, provider: ProviderId) => boolean;
  retryFailed: boolean;
  retryUnknown: boolean;
  inrPerUsd: number;
}

function actionFor(state: SlotState, input: PlanInput, sampleId: string, provider: ProviderId): Action {
  if (state === 'new' || (state === 'failed' && input.retryFailed)) return 'send';
  if (state === 'unknown' && input.retryUnknown) return input.hasJobId(sampleId, provider) ? 'resume' : 'send';
  return 'skip';
}

/** One item per sample and provider, in sample order. Meetings are sent with speaker labels on. */
export function buildPlan(input: PlanInput): PlanItem[] {
  const items: PlanItem[] = [];
  for (const { sample, seconds } of input.samples) {
    for (const p of input.providers) {
      const diarize = sample.kind === 'meeting';
      const price = modelFor(p.id, diarize);
      const state = input.stateOf(sample.id, p.id);
      const action = actionFor(state, input, sample.id, p.id);
      items.push({
        sample,
        seconds,
        provider: p.id,
        model: price.model,
        diarize,
        parts: Math.max(1, Math.ceil(seconds / p.maxPartSeconds)),
        state,
        action,
        estimateUsd: action === 'send' ? costUsd(price, seconds, input.inrPerUsd) : 0,
      });
    }
  }
  return items;
}

export function planTotalUsd(items: readonly PlanItem[]): number {
  return items.reduce((sum, i) => sum + i.estimateUsd, 0);
}

function actionText(i: PlanItem): string {
  if (i.action === 'skip') return `skip (${i.state})`;
  if (i.action === 'resume') return 'wait for the saved job (no new charge)';
  return i.state === 'unknown' ? 'send again (an earlier attempt may already be billed)' : 'send';
}

/** The dry-run listing: one line per sample and provider, then the files and the total. Never any content. */
export function formatPlan(items: readonly PlanItem[]): string {
  const lines = items.map((i) => {
    const parts = i.parts > 1 ? ` in ${i.parts} parts` : '';
    return `  ${i.sample.id.padEnd(34)} ${formatClock(i.seconds).padStart(8)}  ${i.provider.padEnd(10)} ${i.model}${parts}  $${i.estimateUsd.toFixed(3)}  ${actionText(i)}`;
  });
  const files = [...new Set(items.filter((i) => i.action !== 'skip').map((i) => i.sample.path))];
  return [
    ...lines,
    '',
    `Files whose audio would be uploaded (${files.length}):`,
    ...files.map((f) => `  ${f}`),
    '',
    `Estimated cost: $${planTotalUsd(items).toFixed(2)} at list prices.`,
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/plan.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/plan.ts tests/stt/bakeoff/plan.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off run plan with estimates and dry-run listing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Runner

**Files:**
- Create: `src/stt/bakeoff/runner.ts`
- Test: `tests/stt/bakeoff/runner.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/bakeoff/runner.test.ts`:

```ts
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AudioError } from '../../../src/stt/audio.ts';
import { Ledger } from '../../../src/stt/bakeoff/ledger.ts';
import type { PlanItem } from '../../../src/stt/bakeoff/plan.ts';
import { runPlan, type RunDeps } from '../../../src/stt/bakeoff/runner.ts';
import type { Sample } from '../../../src/stt/bakeoff/samples.ts';
import { SttHttpError, SttNoAnswerError } from '../../../src/stt/http.ts';
import { modelFor } from '../../../src/stt/prices.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider, TranscribeOptions } from '../../../src/stt/types.ts';

type Answer = (call: number, part: AudioPart, opts: TranscribeOptions) => Promise<ProviderResult>;

class FakeProvider implements SttProvider {
  readonly id: ProviderId;
  readonly maxPartSeconds: number;
  readonly calls: { part: AudioPart; opts: TranscribeOptions }[] = [];
  readonly #answer: Answer;

  constructor(id: ProviderId, maxPartSeconds: number, answer?: Answer) {
    this.id = id;
    this.maxPartSeconds = maxPartSeconds;
    this.#answer =
      answer ??
      (async (_call, part) => ({
        model: 'm',
        segments: [{ start: 0, end: part.seconds, speaker: 'A', text: `text of ${basename(part.path)}` }],
        billedSeconds: null,
        raw: {},
      }));
  }

  async transcribe(part: AudioPart, opts: TranscribeOptions): Promise<ProviderResult> {
    this.calls.push({ part, opts });
    return await this.#answer(this.calls.length, part, opts);
  }
}

const voice: Sample = { id: 'voice-a', kind: 'voice', path: 'C:\\s\\voice-notes\\a.ogg' };
const meeting: Sample = { id: 'meeting-b', kind: 'meeting', path: 'C:\\s\\meetings\\b.mp4' };

function item(sample: Sample, provider: ProviderId, over: Partial<PlanItem> = {}): PlanItem {
  const diarize = sample.kind === 'meeting';
  return {
    sample,
    seconds: sample.kind === 'meeting' ? 600 : 60,
    provider,
    model: modelFor(provider, diarize).model,
    diarize,
    parts: 1,
    state: 'new',
    action: 'send',
    estimateUsd: 0.01,
    ...over,
  };
}

let dir: string;
let ledger: Ledger;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-run-'));
  ledger = new Ledger(dir);
  lines = [];
});

const wholeFile = async (i: PlanItem): Promise<AudioPart[]> => [{ path: `${i.sample.id}.mp3`, seconds: i.seconds, offset: 0 }];

function deps(providers: SttProvider[], over: Partial<RunDeps> = {}): RunDeps {
  return {
    providers: new Map(providers.map((p) => [p.id, p])),
    ledger,
    partsFor: wholeFile,
    inrPerUsd: 90,
    maxUsd: 5,
    log: (l) => lines.push(l),
    now: () => 1_000,
    ...over,
  };
}

describe('runPlan', () => {
  it('sends each slot once and records the outcome with its list-price cost', async () => {
    const p = new FakeProvider('elevenlabs', 36_000);
    const sum = await runPlan([item(meeting, 'elevenlabs')], deps([p]));
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.opts.diarize).toBe(true);
    const o = ledger.outcome('meeting-b', 'elevenlabs')!;
    expect(o).toMatchObject({ status: 'done', model: 'scribe_v2', audioSeconds: 600, parts: 1, error: null });
    expect(o.costUsd).toBeCloseTo((0.22 * 600) / 3600, 10);
    expect(o.segments).toEqual([{ start: 0, end: 600, speaker: 'A', text: 'text of meeting-b.mp3' }]);
    expect(sum).toMatchObject({ done: 1, failed: 0, unknown: 0, skipped: 0, stoppedAtCap: false });
    expect(sum.spentUsd).toBeCloseTo(o.costUsd, 10);
    expect(lines.join('\n')).not.toContain('text of');
  });

  it('prices billed seconds when the provider reports them', async () => {
    const p = new FakeProvider('openai', 36_000, async () => ({ model: 'm', segments: [], billedSeconds: 300, raw: {} }));
    await runPlan([item(meeting, 'openai')], deps([p]));
    expect(ledger.outcome('meeting-b', 'openai')!.costUsd).toBeCloseTo((0.36 * 300) / 3600, 10);
  });

  it('does nothing for skipped items', async () => {
    const p = new FakeProvider('sarvam', 7_200);
    const sum = await runPlan([item(voice, 'sarvam', { action: 'skip', estimateUsd: 0 })], deps([p]));
    expect(p.calls).toHaveLength(0);
    expect(sum).toMatchObject({ done: 0, spentUsd: 0 });
  });

  it('stops before a slot would pass the spending cap', async () => {
    const p = new FakeProvider('elevenlabs', 36_000);
    const items = [item(voice, 'elevenlabs', { estimateUsd: 1 }), item(meeting, 'elevenlabs', { estimateUsd: 4 })];
    const sum = await runPlan(items, deps([p], { maxUsd: 4 }));
    expect(p.calls).toHaveLength(1);
    expect(sum.stoppedAtCap).toBe(true);
    expect(ledger.state('meeting-b', 'elevenlabs')).toBe('new');
  });

  it('records an error status as failed, never retries, and stops a provider whose key is refused', async () => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new SttHttpError(401, 'invalid_api_key');
    });
    const sum = await runPlan([item(voice, 'openai'), item(meeting, 'openai')], deps([p]));
    expect(p.calls).toHaveLength(1);
    expect(ledger.outcome('voice-a', 'openai')).toMatchObject({ status: 'failed', error: 'http_401 invalid_api_key', costUsd: 0 });
    expect(ledger.state('meeting-b', 'openai')).toBe('new');
    expect(sum).toMatchObject({ failed: 1, skipped: 1 });
    expect(lines.some((l) => l.includes('refused the key'))).toBe(true);
  });

  it('leaves a slot unknown when no answer arrives and counts it as spent', async () => {
    const p = new FakeProvider('openai', 300, async () => {
      throw new SttNoAnswerError('timeout');
    });
    const sum = await runPlan([item(voice, 'openai')], deps([p]));
    expect(ledger.state('voice-a', 'openai')).toBe('unknown');
    expect(sum.unknown).toBe(1);
    expect(sum.spentUsd).toBeCloseTo((0.27 * 60) / 3600, 10);
    expect(lines.some((l) => l.includes('--retry-unknown'))).toBe(true);
  });

  it('saves a job id and waits on it in a later run', async () => {
    const first = new FakeProvider('sarvam', 7_200, async (_c, _p, opts) => {
      opts.onJobId?.('job-9');
      throw new SttNoAnswerError('status_unavailable');
    });
    await runPlan([item(meeting, 'sarvam')], deps([first]));
    expect(ledger.attempt('meeting-b', 'sarvam')?.jobIds).toEqual({ '0': 'job-9' });

    const second = new FakeProvider('sarvam', 7_200);
    await runPlan([item(meeting, 'sarvam', { state: 'unknown', action: 'resume', estimateUsd: 0 })], deps([second]));
    expect(second.calls[0]!.opts.resumeJobId).toBe('job-9');
    expect(ledger.state('meeting-b', 'sarvam')).toBe('done');
  });

  it('reuses parts answered in an earlier run', async () => {
    const twoParts = async (): Promise<AudioPart[]> => [
      { path: 'p0.mp3', seconds: 300, offset: 0 },
      { path: 'p1.mp3', seconds: 100, offset: 300 },
    ];
    const first = new FakeProvider('openai', 300, async (call, part) => {
      if (call === 2) throw new SttNoAnswerError('timeout');
      return { model: 'm', segments: [{ start: 1, end: 2, speaker: 'A', text: part.path }], billedSeconds: 300, raw: {} };
    });
    await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2 })], deps([first], { partsFor: twoParts }));
    expect(ledger.state('meeting-b', 'openai')).toBe('unknown');

    const second = new FakeProvider('openai', 300, async (_c, part) => ({
      model: 'm',
      segments: [{ start: 1, end: 2, speaker: 'A', text: part.path }],
      billedSeconds: 100,
      raw: {},
    }));
    await runPlan([item(meeting, 'openai', { seconds: 400, parts: 2, state: 'unknown' })], deps([second], { partsFor: twoParts }));
    expect(second.calls.map((c) => c.part.path)).toEqual(['p1.mp3']);
    const o = ledger.outcome('meeting-b', 'openai')!;
    expect(o.billedSeconds).toBe(400);
    expect(o.segments).toEqual([
      { start: 1, end: 2, speaker: 'p1:A', text: 'p0.mp3' },
      { start: 301, end: 302, speaker: 'p2:A', text: 'p1.mp3' },
    ]);
  });

  it('fails a slot without sending when the audio cannot be split', async () => {
    const p = new FakeProvider('openai', 300);
    const partsFor = async (): Promise<AudioPart[]> => {
      throw new AudioError('split_failed');
    };
    await runPlan([item(meeting, 'openai')], deps([p], { partsFor }));
    expect(p.calls).toHaveLength(0);
    expect(ledger.outcome('meeting-b', 'openai')).toMatchObject({ status: 'failed', error: 'audio_split_failed' });
    expect(ledger.attempt('meeting-b', 'openai')).toBeNull();
  });

  it('sends a failed slot again on retry and keeps the old outcome on disk', async () => {
    ledger.finish({
      sampleId: 'voice-a', kind: 'voice', provider: 'sarvam', model: 'saaras:v4', status: 'failed', audioSeconds: 60,
      billedSeconds: null, costUsd: 0, processingSeconds: 1, parts: 1, error: 'http_500', segments: [], finishedAt: '2026-10-22T10:00:00.000Z',
    });
    const p = new FakeProvider('sarvam', 7_200);
    await runPlan([item(voice, 'sarvam', { state: 'failed' })], deps([p]));
    expect(ledger.state('voice-a', 'sarvam')).toBe('done');
    expect(readdirSync(join(dir, 'results', 'voice-a')).some((f) => f.startsWith('sarvam.failed-'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/bakeoff/runner.ts`:

```ts
import { AudioError } from '../audio.ts';
import { SttHttpError, SttJobError, SttNoAnswerError } from '../http.ts';
import { costUsd, modelFor } from '../prices.ts';
import { formatClock, mergeParts } from '../segments.ts';
import type { AudioPart, ProviderId, ProviderResult, SttProvider } from '../types.ts';
import type { Ledger, Outcome } from './ledger.ts';
import type { PlanItem } from './plan.ts';

export interface RunDeps {
  providers: ReadonlyMap<ProviderId, SttProvider>;
  ledger: Ledger;
  /** The sample's prepared MP3, cut into parts of at most maxSeconds. Local work, no cost. */
  partsFor: (item: PlanItem, maxSeconds: number) => Promise<AudioPart[]>;
  inrPerUsd: number;
  maxUsd: number;
  log: (line: string) => void;
  now?: () => number;
}

export interface RunSummary {
  spentUsd: number;
  done: number;
  failed: number;
  unknown: number;
  skipped: number;
  stoppedAtCap: boolean;
}

/** Statuses that show the key or account cannot be used: that provider gets nothing more in this run. */
const ACCOUNT_REFUSED = new Set([401, 402, 403]);

type SlotResult =
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'failed'; outcome: Outcome; status: number | null; sentSeconds: number }
  | { kind: 'unknown'; code: string; sentSeconds: number };

/**
 * Sends the plan one slot at a time. No paid request is retried here. Before each slot the cap is checked against what
 * this run has spent plus the slot's estimate. Lines logged carry ids, durations, costs and codes, never transcript text.
 */
export async function runPlan(items: readonly PlanItem[], deps: RunDeps): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const refused = new Set<ProviderId>();
  const sum: RunSummary = { spentUsd: 0, done: 0, failed: 0, unknown: 0, skipped: 0, stoppedAtCap: false };
  for (const item of items) {
    if (item.action === 'skip') continue;
    const label = `${item.sample.id} ${item.provider}`;
    if (refused.has(item.provider)) {
      sum.skipped++;
      deps.log(`skip     ${label}: the provider refused the key earlier in this run`);
      continue;
    }
    if (sum.spentUsd + item.estimateUsd > deps.maxUsd) {
      sum.stoppedAtCap = true;
      deps.log(`stopped  the next file would pass the $${deps.maxUsd.toFixed(2)} cap; nothing more was sent`);
      break;
    }
    const provider = deps.providers.get(item.provider);
    if (!provider) throw new Error(`No provider set up for ${item.provider}`);
    deps.log(`send     ${label} (${formatClock(item.seconds)}${item.parts > 1 ? `, ${item.parts} parts` : ''})`);
    const r = await runSlot(item, provider, deps, now);
    const price = modelFor(item.provider, item.diarize);
    if (r.kind === 'done') {
      sum.done++;
      sum.spentUsd += r.outcome.costUsd;
      deps.log(`done     ${label} in ${r.outcome.processingSeconds.toFixed(1)} s, about $${r.outcome.costUsd.toFixed(3)}`);
    } else if (r.kind === 'failed') {
      sum.failed++;
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      if (r.status !== null && ACCOUNT_REFUSED.has(r.status)) refused.add(item.provider);
      deps.log(`failed   ${label}: ${r.outcome.error ?? 'error'}`);
    } else {
      sum.unknown++;
      // Counted as spent: the provider may have done and billed the work.
      sum.spentUsd += costUsd(price, r.sentSeconds, deps.inrPerUsd);
      deps.log(`unknown  ${label}: no answer (${r.code}). Not sent again; check the provider's dashboard, then use --retry-unknown.`);
    }
  }
  return sum;
}

async function runSlot(item: PlanItem, provider: SttProvider, deps: RunDeps, now: () => number): Promise<SlotResult> {
  const { ledger } = deps;
  const { sample } = item;
  const started = now();
  const base: Omit<Outcome, 'status' | 'processingSeconds' | 'error' | 'finishedAt'> = {
    sampleId: sample.id,
    kind: sample.kind,
    provider: item.provider,
    model: item.model,
    audioSeconds: item.seconds,
    billedSeconds: null,
    costUsd: 0,
    parts: item.parts,
    segments: [],
  };
  const failed = (error: string, status: number | null, sentSeconds: number): SlotResult => {
    const outcome: Outcome = { ...base, status: 'failed', processingSeconds: (now() - started) / 1000, error, finishedAt: new Date(now()).toISOString() };
    ledger.finish(outcome);
    return { kind: 'failed', outcome, status, sentSeconds };
  };

  if (item.state === 'failed') ledger.reopen(sample.id, item.provider);
  let parts: AudioPart[];
  try {
    parts = await deps.partsFor(item, provider.maxPartSeconds);
  } catch (e) {
    return failed(e instanceof AudioError ? `audio_${e.code}` : 'audio_error', null, 0);
  }
  // An unanswered slot keeps its attempt, with any saved job ids; anything else starts a fresh one.
  if (item.state !== 'unknown' || !ledger.attempt(sample.id, item.provider)) {
    ledger.begin({ sampleId: sample.id, provider: item.provider, model: item.model, startedAt: new Date(now()).toISOString(), jobIds: {} });
  }
  const jobIds = ledger.attempt(sample.id, item.provider)?.jobIds ?? {};
  let sentSeconds = 0;
  try {
    const results: ProviderResult[] = [];
    for (const [n, part] of parts.entries()) {
      const cached = ledger.part(sample.id, item.provider, n);
      if (cached) {
        results.push(cached);
        continue;
      }
      const resumeJobId = jobIds[String(n)];
      if (!resumeJobId) sentSeconds += part.seconds;
      const result = await provider.transcribe(part, {
        diarize: item.diarize,
        resumeJobId,
        onJobId: (id) => ledger.saveJobId(sample.id, item.provider, n, id),
      });
      ledger.savePart(sample.id, item.provider, n, result);
      results.push(result);
    }
    const billed = results.every((r) => r.billedSeconds !== null) ? results.reduce((t, r) => t + (r.billedSeconds ?? 0), 0) : null;
    const outcome: Outcome = {
      ...base,
      parts: parts.length,
      status: 'done',
      billedSeconds: billed,
      costUsd: costUsd(modelFor(item.provider, item.diarize), billed ?? item.seconds, deps.inrPerUsd),
      processingSeconds: (now() - started) / 1000,
      error: null,
      segments: mergeParts(parts.map((p, i) => ({ offset: p.offset, segments: results[i]!.segments }))),
      finishedAt: new Date(now()).toISOString(),
    };
    ledger.finish(outcome);
    return { kind: 'done', outcome };
  } catch (e) {
    if (e instanceof SttHttpError) return failed(`http_${e.status}${e.detail ? ` ${e.detail}` : ''}`, e.status, sentSeconds);
    if (e instanceof SttJobError) return failed(`job_${e.code}`, null, sentSeconds);
    return { kind: 'unknown', code: e instanceof SttNoAnswerError ? e.code : e instanceof Error ? e.name : 'error', sentSeconds };
  }
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/runner.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/runner.ts tests/stt/bakeoff/runner.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off runner with spending cap and no paid retries" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Report

**Files:**
- Create: `src/stt/bakeoff/report.ts`
- Test: `tests/stt/bakeoff/report.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/bakeoff/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Outcome } from '../../../src/stt/bakeoff/ledger.ts';
import { buildReport, cell, type ReportInput } from '../../../src/stt/bakeoff/report.ts';

const at = (start: number, speaker: string | null, text: string) => ({ start, end: start + 2, speaker, text });

function outcome(over: Partial<Outcome> & Pick<Outcome, 'sampleId' | 'kind' | 'provider'>): Outcome {
  return {
    model: 'm',
    status: 'done',
    audioSeconds: 60,
    billedSeconds: null,
    costUsd: 0.01,
    processingSeconds: 3,
    parts: 1,
    error: null,
    segments: [],
    finishedAt: '2026-10-22T10:00:00.000Z',
    ...over,
  };
}

function report(over: Partial<ReportInput> = {}): string {
  return buildReport({ generatedAt: '2026-10-22T10:00:00.000Z', inrPerUsd: 88, samples: [], outcomes: [], unknown: [], ...over });
}

describe('cell', () => {
  it('keeps a table cell on one line and escapes pipes and HTML', () => {
    expect(cell('a | b\n<script>&')).toBe('a \\| b &lt;script&gt;&amp;');
  });
});

describe('buildReport', () => {
  it('warns that the report is private', () => {
    expect(report()).toContain('> Private: this file contains client conversations.');
  });

  it('summarises cost per audio hour and processing time per audio minute', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 1800 }],
      outcomes: [outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'elevenlabs', model: 'scribe_v2', audioSeconds: 1800, costUsd: 0.11, processingSeconds: 90 })],
    });
    expect(text).toContain('| elevenlabs | meetings | scribe_v2 | 1 | 0 | 0 | 30:00 | $0.110 | $0.220 | 3.0 s |');
  });

  it('counts slots without an answer in the summary', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 60 }],
      unknown: [{ sampleId: 'voice-a', provider: 'sarvam' }],
    });
    expect(text).toContain('| sarvam | voice notes | – | 0 | 0 | 1 | 0:00 | $0.000 | – | – |');
  });

  it('shows every provider for each voice note', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [
        outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'sarvam', segments: [at(0, null, 'Kal 4 baje')] }),
        outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai', status: 'failed', error: 'http_401 invalid_api_key' }),
      ],
      unknown: [{ sampleId: 'voice-a', provider: 'elevenlabs' }],
    });
    expect(text).toContain('### voice-a (0:42)');
    expect(text).toContain('| sarvam | 3.0 s | $0.010 | Kal 4 baje |');
    expect(text).toContain("| elevenlabs | – | – | no answer: check the provider's dashboard |");
    expect(text).toContain('| openai | – | – | failed (http_401 invalid_api_key) |');
  });

  it('lays meetings out on a timeline with one column per provider that finished', () => {
    const text = report({
      samples: [{ id: 'meeting-b', kind: 'meeting', seconds: 120 }],
      outcomes: [
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'sarvam', segments: [at(5, 'speaker_0', 'Namaste'), at(70, 'speaker_1', 'Budget final?')] }),
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'elevenlabs', segments: [at(10, 'speaker_0', 'Namaste ji')] }),
        outcome({ sampleId: 'meeting-b', kind: 'meeting', provider: 'openai', status: 'failed', error: 'job_failed' }),
      ],
    });
    expect(text).toContain('| sarvam | 2 | 2 | 3.0 s | $0.010 |');
    expect(text).toContain('| openai | – | – | – | failed (job_failed) |');
    expect(text).toContain('| Time | sarvam | elevenlabs |');
    expect(text).toContain('| 0:00 | **speaker_0:** Namaste | **speaker_0:** Namaste ji |');
    expect(text).toContain('| 1:00 | **speaker_1:** Budget final? |  |');
  });

  it('includes a blank score sheet row per provider', () => {
    const text = report({
      samples: [{ id: 'voice-a', kind: 'voice', seconds: 42 }],
      outcomes: [outcome({ sampleId: 'voice-a', kind: 'voice', provider: 'openai' })],
    });
    expect(text).toContain('## Score sheet');
    expect(text).toContain('| openai |  |  |  |  |  |');
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/report.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`src/stt/bakeoff/report.ts`:

```ts
import { PRICES_CHECKED } from '../prices.ts';
import { formatClock } from '../segments.ts';
import { PROVIDER_IDS, type ProviderId, type SampleKind, type Segment } from '../types.ts';
import type { Outcome } from './ledger.ts';

export interface ReportInput {
  generatedAt: string;
  inrPerUsd: number;
  samples: readonly { id: string; kind: SampleKind; seconds: number }[];
  outcomes: readonly Outcome[];
  /** Slots that were sent without an answer arriving. */
  unknown: readonly { sampleId: string; provider: ProviderId }[];
}

/** Meeting timelines group segments into rows of this many seconds. */
const ROW_SECONDS = 60;

/** One Markdown table cell: a single line, with pipes escaped and HTML neutralised. */
export function cell(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .trim();
}

const money = (usd: number): string => `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
const said = (s: Segment): string => (s.speaker === null ? s.text : `**${s.speaker}:** ${s.text}`);

/** The owner's report: summary, blank score sheet, voice notes side by side, meeting timelines. */
export function buildReport(input: ReportInput): string {
  const providers = PROVIDER_IDS.filter((p) => input.outcomes.some((o) => o.provider === p) || input.unknown.some((u) => u.provider === p));
  const find = (sampleId: string, p: ProviderId): Outcome | undefined => input.outcomes.find((o) => o.sampleId === sampleId && o.provider === p);
  const kindOf = (sampleId: string): SampleKind | undefined => input.samples.find((s) => s.id === sampleId)?.kind;
  /** null when the slot is done; otherwise what to show instead of a result. */
  const status = (sampleId: string, p: ProviderId): string | null => {
    const o = find(sampleId, p);
    if (o?.status === 'done') return null;
    if (o?.status === 'failed') return `failed (${cell(o.error ?? 'error')})`;
    return input.unknown.some((u) => u.sampleId === sampleId && u.provider === p) ? "no answer: check the provider's dashboard" : 'not run';
  };

  const out: string[] = [
    '# STT bake-off report',
    '',
    `Generated ${input.generatedAt}. List prices checked ${PRICES_CHECKED}; Sarvam's rupee prices are converted at ₹${input.inrPerUsd} to $1.`,
    "Costs are list price × audio length. Compare them with each provider's dashboard after the run.",
    '',
    '> Private: this file contains client conversations. Keep it outside the repository and do not share it.',
    '',
    '## Summary',
    '',
    '| Provider | Files | Model | Done | Failed | No answer | Audio done | Cost | Cost per audio hour | Processing per audio minute |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const p of providers) {
    for (const kind of ['voice', 'meeting'] as const) {
      const mine = input.outcomes.filter((o) => o.provider === p && o.kind === kind);
      const done = mine.filter((o) => o.status === 'done');
      const noAnswer = input.unknown.filter((u) => u.provider === p && kindOf(u.sampleId) === kind).length;
      if (mine.length === 0 && noAnswer === 0) continue;
      const audio = done.reduce((t, o) => t + o.audioSeconds, 0);
      const cost = done.reduce((t, o) => t + o.costUsd, 0);
      const processing = done.reduce((t, o) => t + o.processingSeconds, 0);
      const models = [...new Set(mine.map((o) => o.model))].join(', ') || '–';
      const perHour = audio > 0 ? money((cost * 3600) / audio) : '–';
      const perMinute = audio > 0 ? `${((processing * 60) / audio).toFixed(1)} s` : '–';
      out.push(
        `| ${p} | ${kind === 'voice' ? 'voice notes' : 'meetings'} | ${models} | ${done.length} | ${mine.length - done.length} | ${noAnswer} | ${formatClock(audio)} | ${money(cost)} | ${perHour} | ${perMinute} |`,
      );
    }
  }

  out.push(
    '',
    '## Score sheet',
    '',
    'Fill this in by hand after reading the transcripts. 5 = names, numbers, dates, amounts and task words all right; 3 = the meaning is clear but there are several mistakes; 1 = unusable.',
    '',
    '| Provider | Hinglish accuracy, voice notes (1–5) | Hinglish accuracy, meetings (1–5) | Speaker separation, meetings (1–5) | Cost per audio hour | Notes |',
    '|---|---|---|---|---|---|',
    ...providers.map((p) => `| ${p} |  |  |  |  |  |`),
  );

  const voice = input.samples.filter((s) => s.kind === 'voice');
  if (voice.length > 0) out.push('', '## Voice notes');
  for (const s of voice) {
    out.push('', `### ${s.id} (${formatClock(s.seconds)})`, '', '| Provider | Processing | Cost | Transcript |', '|---|---|---|---|');
    for (const p of providers) {
      const o = find(s.id, p);
      const st = status(s.id, p);
      out.push(o && st === null ? `| ${p} | ${o.processingSeconds.toFixed(1)} s | ${money(o.costUsd)} | ${cell(o.segments.map(said).join(' '))} |` : `| ${p} | – | – | ${st} |`);
    }
  }

  const meetings = input.samples.filter((s) => s.kind === 'meeting');
  if (meetings.length > 0) out.push('', '## Meetings');
  for (const s of meetings) {
    out.push('', `### ${s.id} (${formatClock(s.seconds)})`, '', '| Provider | Speakers found | Segments | Processing | Cost |', '|---|---|---|---|---|');
    const finished: Outcome[] = [];
    for (const p of providers) {
      const o = find(s.id, p);
      const st = status(s.id, p);
      if (o && st === null) {
        finished.push(o);
        const speakers = new Set(o.segments.flatMap((x) => (x.speaker === null ? [] : [x.speaker]))).size;
        out.push(`| ${p} | ${speakers} | ${o.segments.length} | ${o.processingSeconds.toFixed(1)} s | ${money(o.costUsd)} |`);
      } else {
        out.push(`| ${p} | – | – | – | ${st} |`);
      }
    }
    if (finished.length === 0) continue;
    const last = Math.max(s.seconds, ...finished.flatMap((o) => o.segments.map((x) => x.start + 1)));
    out.push(
      '',
      `Timeline, one row per minute. Speaker labels are each provider's own; "p2:A" is speaker A in part 2 of a file sent in parts.`,
      '',
      `| Time | ${finished.map((o) => o.provider).join(' | ')} |`,
      `|---|${finished.map(() => '---|').join('')}`,
    );
    for (let t = 0; t < last; t += ROW_SECONDS) {
      const texts = finished.map((o) => cell(o.segments.filter((x) => x.start >= t && x.start < t + ROW_SECONDS).map(said).join(' ')));
      out.push(`| ${formatClock(t)} | ${texts.join(' | ')} |`);
    }
  }

  out.push('', 'Full transcripts, one line per segment: transcripts/<file>.<provider>.txt in this folder.', '');
  return out.join('\n');
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/report.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/report.ts tests/stt/bakeoff/report.test.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off Markdown report with score sheet and timelines" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Pre-send checks and the command

**Files:**
- Create: `src/stt/bakeoff/checks.ts`, `scripts/stt-bakeoff.ts`
- Test: `tests/stt/bakeoff/checks.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/stt/bakeoff/checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PRIVACY_CHECKLIST, refusals } from '../../../src/stt/bakeoff/checks.ts';
import type { BakeoffEnv } from '../../../src/stt/bakeoff/env.ts';
import type { PlanItem } from '../../../src/stt/bakeoff/plan.ts';
import type { ProviderId } from '../../../src/stt/types.ts';

const KEYS: BakeoffEnv = { SARVAM_API_KEY: 'secret-s', ELEVENLABS_API_KEY: 'secret-e', OPENAI_API_KEY: 'secret-o', INR_PER_USD: 88 };

function item(provider: ProviderId, over: Partial<PlanItem> = {}): PlanItem {
  return {
    sample: { id: 'voice-a', kind: 'voice', path: 'C:\\stt-samples\\voice-notes\\a.ogg' },
    seconds: 60,
    provider,
    model: 'm',
    diarize: false,
    parts: 1,
    state: 'new',
    action: 'send',
    estimateUsd: 1,
    ...over,
  };
}

const ok = { maxUsd: 8, confirmedPrivacy: true };

describe('refusals', () => {
  it('allows a run with keys, the privacy confirmation and an estimate under the cap', () => {
    expect(refusals([item('sarvam'), item('openai')], KEYS, ok)).toEqual([]);
  });

  it('names each missing key by its variable, only for providers with something to send', () => {
    const env: BakeoffEnv = { INR_PER_USD: 88 };
    const out = refusals([item('sarvam'), item('openai', { action: 'skip', estimateUsd: 0 })], env, ok);
    expect(out).toEqual(['SARVAM_API_KEY is not set in .env.']);
  });

  it('refuses an estimate above the cap', () => {
    expect(refusals([item('sarvam', { estimateUsd: 9 })], KEYS, ok)).toEqual(['The estimate ($9.00) is above --max-usd ($8.00).']);
  });

  it('refuses without the privacy confirmation and lists the checklist', () => {
    const out = refusals([item('elevenlabs')], KEYS, { maxUsd: 8, confirmedPrivacy: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('--confirm-privacy');
    for (const line of PRIVACY_CHECKLIST) expect(out[0]).toContain(line);
  });

  it('refuses when there is nothing to send', () => {
    expect(refusals([item('sarvam', { action: 'skip', estimateUsd: 0 })], KEYS, ok)[0]).toMatch(/^Nothing to send/);
  });

  it('never repeats a key value', () => {
    const out = refusals([item('sarvam', { estimateUsd: 99 })], KEYS, { maxUsd: 8, confirmedPrivacy: false }).join('\n');
    expect(out).not.toMatch(/secret-/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/checks.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the checks**

`src/stt/bakeoff/checks.ts`:

```ts
import { KEY_NAMES, type BakeoffEnv } from './env.ts';
import { planTotalUsd, type PlanItem } from './plan.ts';

/** What the owner confirms with --confirm-privacy before any recording leaves the PC. */
export const PRIVACY_CHECKLIST = [
  'ElevenLabs: profile > Terms and privacy > Data use: "Improve the models for everyone" is OFF and saved with "Update your choice".',
  'Sarvam: training on your data is opted out, and the workspace data retention is set to 0 days (by the workspace Owner).',
  "Every meeting recording has its participants' consent, and you may share these voice notes with all three providers.",
];

/** Reasons a real run must not start; empty means it may. Keys are only checked for presence, never read out. */
export function refusals(items: readonly PlanItem[], env: BakeoffEnv, opts: { maxUsd: number; confirmedPrivacy: boolean }): string[] {
  const out: string[] = [];
  const sending = items.filter((i) => i.action !== 'skip');
  if (sending.length === 0) {
    out.push('Nothing to send: every slot already has a result (see --retry-failed and --retry-unknown, or use --report-only).');
    return out;
  }
  const total = planTotalUsd(items);
  if (total > opts.maxUsd) out.push(`The estimate ($${total.toFixed(2)}) is above --max-usd ($${opts.maxUsd.toFixed(2)}).`);
  for (const p of new Set(sending.map((i) => i.provider))) {
    if (!env[KEY_NAMES[p]]) out.push(`${KEY_NAMES[p]} is not set in .env.`);
  }
  if (!opts.confirmedPrivacy) {
    out.push(`Add --confirm-privacy once all of these are true:\n${PRIVACY_CHECKLIST.map((l) => `      - ${l}`).join('\n')}`);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/bakeoff/checks.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the command**

`scripts/stt-bakeoff.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Ffmpeg, findFfmpeg } from '../src/stt/audio.ts';
import { refusals } from '../src/stt/bakeoff/checks.ts';
import { KEY_NAMES, loadBakeoffEnv } from '../src/stt/bakeoff/env.ts';
import { Ledger } from '../src/stt/bakeoff/ledger.ts';
import { buildPlan, formatPlan } from '../src/stt/bakeoff/plan.ts';
import { buildReport } from '../src/stt/bakeoff/report.ts';
import { runPlan } from '../src/stt/bakeoff/runner.ts';
import { findSamples, insideGitRepo, type Sample } from '../src/stt/bakeoff/samples.ts';
import { ElevenLabsProvider } from '../src/stt/providers/elevenlabs.ts';
import { OpenAiProvider } from '../src/stt/providers/openai.ts';
import { SarvamProvider } from '../src/stt/providers/sarvam.ts';
import { segmentsToText } from '../src/stt/segments.ts';
import { PROVIDER_IDS, type AudioPart, type ProviderId, type SttProvider } from '../src/stt/types.ts';

// The error's type and code only: messages can carry paths, keys or transcript text.
function fatal(err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  process.stderr.write(`Stopped: ${err instanceof Error ? err.name : 'error'}${typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''}\n`);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const USAGE = `STT bake-off (docs/STT-BAKEOFF.md). Without --yes this is a dry run: nothing is converted or sent.

  node scripts/stt-bakeoff.ts [options]

  --samples <dir>       folder with voice-notes\\ and meetings\\ (default STT_SAMPLES_DIR or C:\\stt-samples)
  --out <dir>           output folder (default <samples>\\bakeoff-out)
  --providers <list>    comma list of ${PROVIDER_IDS.join(', ')} (default all)
  --only <sample-id>    only this sample; repeat for more
  --yes                 really convert and send
  --confirm-privacy     you completed the privacy checklist (required with --yes)
  --max-usd <n>         spending cap for this run in dollars (default 8)
  --retry-failed        send slots that failed before again
  --retry-unknown       retry slots that got no answer (Sarvam waits on the saved job; others send again)
  --report-only         rebuild report.md and the transcripts from saved results
`;

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    samples: { type: 'string' },
    out: { type: 'string' },
    providers: { type: 'string', default: PROVIDER_IDS.join(',') },
    only: { type: 'string', multiple: true },
    yes: { type: 'boolean', default: false },
    'confirm-privacy': { type: 'boolean', default: false },
    'max-usd': { type: 'string', default: '8' },
    'retry-failed': { type: 'boolean', default: false },
    'retry-unknown': { type: 'boolean', default: false },
    'report-only': { type: 'boolean', default: false },
  },
});

function stop(message: string): never {
  console.log(message);
  process.exit(1);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const env = loadBakeoffEnv();
const samplesDir = resolve(values.samples ?? env.STT_SAMPLES_DIR ?? 'C:\\stt-samples');
const outDir = resolve(values.out ?? join(samplesDir, 'bakeoff-out'));
for (const [label, dir] of [['Samples folder', samplesDir], ['Output folder', outDir]] as const) {
  if (insideGitRepo(dir)) stop(`${label} ${dir} is inside a git repository. Recordings and transcripts must stay outside it.`);
}

const requested = values.providers.split(',').map((s) => s.trim()).filter((s) => s !== '');
const isProviderId = (s: string): s is ProviderId => (PROVIDER_IDS as readonly string[]).includes(s);
const providerIds: ProviderId[] = requested.filter(isProviderId);
if (providerIds.length === 0 || providerIds.length !== requested.length) stop(`--providers takes a comma list of: ${PROVIDER_IDS.join(', ')}`);
const maxUsd = Number(values['max-usd']);
if (!(maxUsd > 0)) stop('--max-usd must be a positive number of dollars.');

const exe = await findFfmpeg(env.FFMPEG_PATH);
if (!exe) stop('ffmpeg was not found. Set FFMPEG_PATH in .env (see docs/STT-BAKEOFF.md).');
const ffmpeg = new Ffmpeg(exe);

const only = values.only ?? [];
const samples: Sample[] = findSamples(samplesDir).filter((s) => only.length === 0 || only.includes(s.id));
if (samples.length === 0) {
  stop(`No audio files found in ${join(samplesDir, 'voice-notes')} or ${join(samplesDir, 'meetings')}${only.length > 0 ? ' matching --only' : ''}.`);
}

const ledger = new Ledger(outDir);
const measured: { sample: Sample; seconds: number }[] = [];
for (const sample of samples) measured.push({ sample, seconds: await ffmpeg.seconds(sample.path) });

function writeReport(): string {
  const ids = new Set(samples.map((s) => s.id));
  const outcomes = ledger.outcomes().filter((o) => ids.has(o.sampleId));
  mkdirSync(join(outDir, 'transcripts'), { recursive: true });
  for (const o of outcomes) {
    if (o.status === 'done') writeFileSync(join(outDir, 'transcripts', `${o.sampleId}.${o.provider}.txt`), segmentsToText(o.segments));
  }
  const unknown = samples.flatMap((s) => PROVIDER_IDS.filter((p) => ledger.state(s.id, p) === 'unknown').map((p) => ({ sampleId: s.id, provider: p })));
  const path = join(outDir, 'report.md');
  writeFileSync(path, buildReport({
    generatedAt: new Date().toISOString(),
    inrPerUsd: env.INR_PER_USD,
    samples: measured.map((m) => ({ id: m.sample.id, kind: m.sample.kind, seconds: m.seconds })),
    outcomes,
    unknown,
  }));
  return path;
}

if (values['report-only']) {
  console.log(`Report: ${writeReport()}`);
  process.exit(0);
}

function makeProvider(id: ProviderId): SttProvider {
  // An empty key is only possible in a dry run: refusals() stops a real run first.
  const apiKey = env[KEY_NAMES[id]] ?? '';
  switch (id) {
    case 'sarvam':
      return new SarvamProvider({ apiKey });
    case 'elevenlabs':
      return new ElevenLabsProvider({ apiKey });
    case 'openai':
      return new OpenAiProvider({ apiKey });
  }
}
const providers = new Map(providerIds.map((id) => [id, makeProvider(id)] as const));

const items = buildPlan({
  samples: measured,
  providers: [...providers.values()],
  stateOf: (s, p) => ledger.state(s, p),
  hasJobId: (s, p) => Object.keys(ledger.attempt(s, p)?.jobIds ?? {}).length > 0,
  retryFailed: values['retry-failed'],
  retryUnknown: values['retry-unknown'],
  inrPerUsd: env.INR_PER_USD,
});
console.log(`STT bake-off: ${samples.length} file(s), providers ${providerIds.join(', ')}. Output folder: ${outDir}\n`);
console.log(formatPlan(items));

if (!values.yes) {
  console.log('\nDry run: nothing was converted or sent. Add --yes --confirm-privacy to send.');
  process.exit(0);
}
const problems = refusals(items, env, { maxUsd, confirmedPrivacy: values['confirm-privacy'] });
if (problems.length > 0) stop(`\nNot sending:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

// Local and free: one mono 16 kHz MP3 per sample that has something to send.
const prepared = new Map<string, AudioPart>();
mkdirSync(join(outDir, 'prepared'), { recursive: true });
for (const { sample } of measured) {
  if (!items.some((i) => i.sample.id === sample.id && i.action !== 'skip')) continue;
  const path = join(outDir, 'prepared', `${sample.id}.mp3`);
  console.log(`prepare  ${sample.id}`);
  await ffmpeg.toMp3(sample.path, path);
  prepared.set(sample.id, { path, seconds: await ffmpeg.seconds(path), offset: 0 });
}

const summary = await runPlan(items, {
  providers,
  ledger,
  inrPerUsd: env.INR_PER_USD,
  maxUsd,
  log: (line) => console.log(line),
  partsFor: async (item, maxSeconds) => {
    const audio = prepared.get(item.sample.id);
    if (!audio) throw new Error(`No prepared audio for ${item.sample.id}`);
    return await ffmpeg.split(audio, join(outDir, 'prepared', `${item.sample.id}-parts-${maxSeconds}`), maxSeconds);
  },
});
const reportPath = writeReport();
console.log(
  `\nAbout $${summary.spentUsd.toFixed(2)} at list prices: ${summary.done} done, ${summary.failed} failed, ` +
    `${summary.unknown} without an answer, ${summary.skipped} skipped${summary.stoppedAtCap ? ', stopped at the spending cap' : ''}.`,
);
console.log(`Report: ${reportPath}`);
```

- [ ] **Step 6: Type-check**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx tsc -p tsconfig.json`
Expected: no output, exit code 0.

- [ ] **Step 7: Dry run on generated audio (no network, nothing sent)**

This makes two short test tones with ffmpeg in a temp folder outside the repository, then runs the tool without `--yes`, and then with `--yes` but no keys and no privacy flag. The last run must refuse.

```powershell
Set-Location C:\Users\Dell\Desktop\WA_agent-stt
$env:FFMPEG_PATH = 'C:\Users\Dell\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe'
$demo = Join-Path $env:TEMP 'stt-bakeoff-demo'
New-Item -ItemType Directory -Force (Join-Path $demo 'voice-notes'), (Join-Path $demo 'meetings') | Out-Null
& $env:FFMPEG_PATH -hide_banner -loglevel error -n -f lavfi -i 'sine=frequency=440:duration=20' -ac 1 -ar 16000 -c:a libopus (Join-Path $demo 'voice-notes\tone.ogg')
& $env:FFMPEG_PATH -hide_banner -loglevel error -n -f lavfi -i 'sine=frequency=330:duration=700' -ac 1 -ar 16000 -c:a aac (Join-Path $demo 'meetings\long tone.m4a')
node scripts/stt-bakeoff.ts --samples $demo
node scripts/stt-bakeoff.ts --samples $demo --yes
```

Expected:
- **First run:** six plan lines. They include `meeting-long-tone ... 11:40 ... gpt-4o-transcribe-diarize in 3 parts`. Then two file paths, an estimate below $0.25, and `Dry run: nothing was converted or sent.`
- **Second run:** the same listing, then `Not sending:` with `SARVAM_API_KEY is not set in .env.`, `ELEVENLABS_API_KEY ...`, `OPENAI_API_KEY ...` and the `--confirm-privacy` checklist. Exit code 1.
- `Test-Path (Join-Path $demo 'bakeoff-out\prepared')` is `False`: nothing was converted.

(`$env:FFMPEG_PATH` only lasts for this PowerShell process. The worktree has no `.env` yet, so the dry run reads the variable from the process.)

- [ ] **Step 8: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add src/stt/bakeoff/checks.ts tests/stt/bakeoff/checks.test.ts scripts/stt-bakeoff.ts
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "feat: STT bake-off command with dry run, pre-send checks and report" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Owner's runbook

**Files:**
- Create: `docs/STT-BAKEOFF.md`

- [ ] **Step 1: Write the runbook**

`docs/STT-BAKEOFF.md`:

````markdown
# STT bake-off: runbook

A one-off test that sends the same recordings to three speech-to-text services (Sarvam, ElevenLabs and OpenAI). It writes a side-by-side report that you score by hand. The winner becomes the agent's transcriber for voice notes and meetings (spec §7.4).

## What it costs

About **$3** for 10 voice notes and 3 one-hour meetings, and about $5 at most. The tool prints its estimate before sending anything. It stops before passing `--max-usd` (default $8), and it never sends the same file to the same service twice unless you ask.

| Service | Model | List price per audio hour |
|---|---|---|
| Sarvam | saaras:v4, codemix | ₹30, or ₹36 with speaker labels. ₹100 free credit on sign-up |
| ElevenLabs | Scribe v2 | $0.22. The free plan includes 4.5 hours |
| OpenAI | gpt-transcribe (voice notes), gpt-4o-transcribe-diarize (meetings) | $0.27 / $0.36. Needs prepaid credit |

Note: OpenAI's model with speaker labels shuts down on 26 February 2027. OpenAI can therefore only be a long-term choice for voice notes.

## Must do before the first upload

These steps protect client data. The tool refuses to send anything until you add `--confirm-privacy`, which means you have done all four.

1. **ElevenLabs:** turn off model training.
   - Click your profile icon (top right) and go to **Terms and privacy** > **Data use**.
   - Switch **"Improve the models for everyone"** OFF, then click **"Update your choice"**.
   - The switch only covers audio sent after the change, so do it before any upload.
2. **Sarvam:** opt out of training and set retention to 0 days.
   - Sarvam's privacy policy says it trains on uploaded content **unless you opt out**. Opt out in your account settings, or by email as the policy describes: https://sarvam.ai/privacy-policy
   - As the workspace Owner, set data retention to **No retention (0 days)**: https://docs.sarvam.ai/api/platform/data-retention. Until an Owner sets it, Sarvam keeps data indefinitely.
3. **OpenAI:** nothing to switch. OpenAI does not train on API audio, and its "Your data" page lists no retention for the transcription endpoint.
4. **Consent:** every meeting recording has its participants' consent, and you are allowed to share the voice notes with these three services.

## One-time setup

1. **Recordings.** Put them in a folder **outside** any project folder:
   - `C:\stt-samples\voice-notes\`: 5–10 WhatsApp voice notes in Hinglish, 5 seconds to 3 minutes each (.ogg or .opus as exported).
   - `C:\stt-samples\meetings\`: 2–3 Google Meet recordings, 30–90 minutes each, with 2–6 speakers (.mp4 as downloaded is fine).

   The tool refuses any folder inside a git repository.
2. **Keys.** Copy `.env.example` to `.env` in `C:\Users\Dell\Desktop\WA_agent-stt`. Open `.env` in Notepad and type in the three keys yourself. Never paste a key into a chat.
   - `SARVAM_API_KEY`: from the Sarvam dashboard.
   - `ELEVENLABS_API_KEY`: from ElevenLabs > Developers > API keys.
   - `OPENAI_API_KEY`: from the OpenAI platform > API keys (add prepaid credit first).
3. **ffmpeg.** Already on this PC, so nothing needs installing. In the same `.env`, set:
   `FFMPEG_PATH=C:\Users\Dell\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe`
4. Optional: `INR_PER_USD` (default 88) sets the rupee rate used for Sarvam's costs.

## Running it

Open PowerShell:

```powershell
Set-Location C:\Users\Dell\Desktop\WA_agent-stt

# 1. Dry run: lists every file, service, model and the estimate. Sends nothing.
node scripts/stt-bakeoff.ts

# 2. Try one short voice note first (use an id from the dry-run list).
node scripts/stt-bakeoff.ts --only voice-<name> --yes --confirm-privacy

# 3. Everything else. Finished results are never sent again.
node scripts/stt-bakeoff.ts --yes --confirm-privacy
```

Other options: `--providers sarvam,openai`, `--max-usd 5`, `--report-only` (rebuild the report from saved results), and `--help`.

Sarvam and ElevenLabs can take several minutes for a long meeting. The screen shows one line per file and service, with the processing time and cost, never the words.

## If something goes wrong

- **`failed ... http_401`**: the key is wrong or has no credit. That service is skipped for the rest of the run. Fix `.env`, then run again with `--retry-failed`.
- **`unknown ... no answer`**: the request was sent, but no answer came back (timeout or network). The service may still have charged for it.
  - Check that service's dashboard first, then run with `--retry-unknown`.
  - Sarvam then waits for the job it already has, with no new charge. ElevenLabs and OpenAI send the file again and may charge again.
- **`stopped ... cap`**: the next file would pass `--max-usd`. Raise the cap only if you mean to.

## Reading and scoring

Open `C:\stt-samples\bakeoff-out\report.md`, for example in VS Code, using the Markdown preview.
- **Summary:** the cost per audio hour and the speed of each service.
- **Score sheet:** fill it in yourself, scoring 1–5 for Hinglish accuracy (names, numbers, dates, amounts and task words) and for speaker separation in meetings.
- **Voice notes:** the three transcripts of each voice note, side by side.
- **Meetings:** a minute-by-minute timeline per service. Full transcripts are in `transcripts\`.

Compare the costs with each service's dashboard. The report uses list prices.

## Afterwards

- Tell the agent's builder which service won and why. Phase 2b then sets `STT_PROVIDER`.
- `C:\stt-samples\bakeoff-out` holds client conversations. Delete it, and the recordings, once the decision is made. Never copy it into a project folder.
- Revoke the API keys of the services you did not choose.
````

- [ ] **Step 2: Commit**

```bash
git -C /c/Users/Dell/Desktop/WA_agent-stt add docs/STT-BAKEOFF.md
git -C /c/Users/Dell/Desktop/WA_agent-stt commit -m "docs: STT bake-off runbook with must-do privacy steps" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Final verification

- [ ] **Step 1: All bake-off tests**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx vitest run tests/stt/`
Expected: PASS, 14 files and 105 tests (prices 5, segments 10, http 12, sarvam 10, elevenlabs 5, openai 3, audio 12, env 5, samples 5, ledger 9, plan 6, runner 10, report 7, checks 6; adjust if a task added more).

- [ ] **Step 2: Type-check**

Run: `Set-Location C:\Users\Dell\Desktop\WA_agent-stt; npx tsc -p tsconfig.json`
Expected: exit code 0.

- [ ] **Step 3: Nothing private or secret in the branch**

Run: `git -C /c/Users/Dell/Desktop/WA_agent-stt diff --stat feat/phase-2a-media...HEAD`
Expected: only the files in the file map. There must be no `.env`, no audio, no `bakeoff-out`, and `package.json` must be untouched.
Run: `git -C /c/Users/Dell/Desktop/WA_agent-stt diff feat/phase-2a-media...HEAD | grep -nE "sk-[A-Za-z0-9]{8,}|api-subscription-key: [A-Za-z0-9]|xi-api-key: [A-Za-z0-9]"`
Expected: no output.

- [ ] **Step 4: The dry run from Task 14, Step 7, still behaves the same.**

- [ ] **Step 5: Clean up the demo tones** (`$env:TEMP\stt-bakeoff-demo` holds only the generated tones). Remove that folder after listing it and confirming it contains only `voice-notes\tone.ogg` and `meetings\long tone.m4a`.
