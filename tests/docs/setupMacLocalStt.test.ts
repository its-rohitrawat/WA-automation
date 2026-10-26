import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { VOICE_PROBLEM_LINES } from '../../src/health/health.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/** The model rows of the amendment's table: repo, file and SHA-256, with "same repo" read as the row above's. */
function amendmentModels(amendment: string): { repo: string; file: string; sha: string }[] {
  const rows: { repo: string; file: string; sha: string }[] = [];
  let repo = '';
  for (const m of amendment.matchAll(/^\| \S+(?: \(smaller\))? \| (?:`([^`]+)`|same repo) \/ `([^`]+)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)) {
    repo = m[1] ?? repo;
    rows.push({ repo, file: m[2]!, sha: m[3]! });
  }
  return rows;
}

/** The fenced sh blocks of a text, in order. */
const shBlocks = (text: string): string[] => [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);

describe('SETUP-mac.md: voice notes, local speech-to-text', () => {
  const setup = read('docs/SETUP-mac.md');
  const start = setup.indexOf('\n## 8. Voice notes: local speech-to-text\n');
  const end = setup.indexOf('\n## ', start + 1);
  const section = setup.slice(start, end);
  const amendment = read('docs/superpowers/plans/phase-2b-amendments/2026-10-26-local-stt.md');
  const sub = (heading: string): string => {
    const at = section.indexOf(`\n### ${heading}\n`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const next = section.indexOf('\n### ', at + 1);
    return section.slice(at, next < 0 ? undefined : next);
  };

  it('has the section', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  });

  it('says it is off until VOICE_STT_PROVIDER=local, and that the service then transcribes voice notes after a restart', () => {
    expect(section).toMatch(/\*\*off\*\*[^\n]*`VOICE_STT_PROVIDER=local`/);
    expect(section).toContain('The service transcribes voice notes once `VOICE_STT_PROVIDER=local` is set and the service is restarted.');
    for (const stale of ['does not use it yet', 'later update', 'as the service will']) expect(section).not.toContain(stale);
    expect(section).toContain('as the service does.');
    expect(parseEnv({}).VOICE_STT_PROVIDER).toBe('none');
  });

  it('after the restart: new notes are transcribed, transcribe-voice (dry run, then --yes) for older ones, status for the Health line', () => {
    const restart = sub('Then restart the service');
    expect(restart).toContain('new voice notes are transcribed');
    expect(restart).toContain('`npm run cli -- transcribe-voice`');
    expect(restart).toContain('a dry run');
    expect(restart).toContain('`npm run cli -- transcribe-voice --yes`');
    expect(restart).toContain('`npm run cli -- status`');
    expect(restart).toContain('the local speech engine is not set up');
    expect(restart).toContain('ffmpeg not found');
  });

  it('pins transcribe.cpp v0.4.1 and a whisper.cpp release, and builds both with cmake on all cores', () => {
    const build = shBlocks(sub('Build the engine (about 15 minutes)'));
    const transcribe = build.find((b) => b.includes('transcribe.cpp.git'));
    const whisper = build.find((b) => b.includes('whisper.cpp.git'));
    expect(transcribe).toMatch(/git clone --branch v0\.4\.1 /);
    expect(transcribe).toContain('-DCMAKE_BUILD_TYPE=Release');
    expect(transcribe).toMatch(/^cmake --build build -j$/m);
    expect(whisper).toMatch(/git clone --branch v\d+\.\d+\.\d+ /);
    expect(whisper).toContain('-DGGML_METAL=OFF');
    expect(whisper).toMatch(/^cmake --build build -j --config Release$/m);
    // The amendment names the same builds.
    const tag = /--branch (v\d+\.\d+\.\d+)/.exec(whisper!)![1]!;
    expect(amendment).toContain(`--branch ${tag}`);
    expect(amendment).toContain('cmake --build build -j`');
  });

  it('lists every model file of the amendment in one row with its address and SHA-256, and checks it with shasum', () => {
    const models = amendmentModels(amendment);
    expect(models).toHaveLength(5);
    const tableRows = section.split('\n').filter((l) => /^\| `[^`]+` (?:\(smaller\) )?\| `[^`]+\.(?:gguf|bin)` \|/.test(l));
    expect(tableRows).toHaveLength(models.length);
    for (const { repo, file, sha } of models) {
      const row = tableRows.find((l) => l.includes(`| \`${file}\` |`));
      expect(row, file).toBeDefined();
      expect(row).toContain(`| \`https://huggingface.co/${repo}/resolve/main/${file}\` |`);
      expect(row).toContain(`| \`${sha}\` |`);
    }
    expect(section).toContain('shasum -a 256');
  });

  it('opens .env and runs the check from the app folder', () => {
    const settings = shBlocks(sub('Settings (waagent window)'));
    expect(settings[0]!.split('\n')[0]).toBe('cd /opt/wa-agent');
    expect(settings[0]).toContain('nano .env');
    const check = shBlocks(sub('Test it on real notes (waagent window)')).find((b) => b.includes('npm run stt:local-check'));
    expect(check!.split('\n')[0]).toBe('cd /opt/wa-agent');
  });

  // Amendment L2: the check takes any audio file and converts it itself, as the service does.
  it('runs the check on the voice note itself, which the check converts with ffmpeg, then restarts the service', () => {
    expect(section).toMatch(/The check takes any audio file/);
    expect(section).toMatch(/converts the file with ffmpeg to the 16 kHz mono WAV/);
    expect(section).toContain('npm run stt:local-check -- ~/stt-check/note1.opus');
    expect(section).not.toContain('ffmpeg -i ');
    expect(section).toContain('Mean volume');
    expect(section).toContain('sudo launchctl kickstart -k system/com.wa-agent');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['stt:local-check']).toBe('node scripts/stt-local-check.ts');
  });

  it('sets the four settings', () => {
    for (const s of ['VOICE_STT_PROVIDER=local', 'STT_LOCAL_ENGINE=voxtral', 'STT_LOCAL_BIN=/', 'STT_LOCAL_MODEL=/']) expect(section).toContain(s);
  });
});

describe('SETUP.md: the voice-note Health lines match the code', () => {
  it('lists every voice problem line exactly (without the ⚠️), each in its own row of "Voice note status lines"', () => {
    const setup = read('docs/SETUP.md');
    const start = setup.indexOf('\n### Voice note status lines\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const section = setup.slice(start, setup.indexOf('\n#', start + 1));
    const rows = section.split('\n').filter((l) => l.startsWith('| Voice notes are not being transcribed: '));
    const lines = Object.values(VOICE_PROBLEM_LINES).map((l) => l.replace(/^⚠️ /, ''));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(rows.filter((r) => r.startsWith(`| ${line} |`)), line).toHaveLength(1);
    // Plus the key-refused line, which is not a start-up problem.
    expect(rows).toHaveLength(lines.length + 1);
  });
});
