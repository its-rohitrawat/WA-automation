import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';
import { VOICE_PROBLEM_LINES, voiceFailedLine } from '../../src/health/health.ts';

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

  // Phase 2b final review: failed local notes are visible (the Health line) and recoverable (--failed).
  const setup = read('docs/SETUP.md');
  const between = (from: string, to: string) => setup.slice(setup.indexOf(from), setup.indexOf(to, setup.indexOf(from) + 1));

  it('lists the could-not-transcribe line as the code writes it, in both tables, after low disk in the main one', () => {
    const core = voiceFailedLine(2).replace(/^⚠️ 2 /, '(number) ');
    expect(core).toBe('(number) voice notes could not be transcribed on this computer. See docs/SETUP.md, Voice notes');
    expect(voiceFailedLine(1)).toBe('⚠️ 1 voice note could not be transcribed on this computer. See docs/SETUP.md, Voice notes');
    expect(setup).not.toContain('could not be transcribed by the local engine');
    const statusLines = between('\n### Voice note status lines\n', '\n## ');
    expect(statusLines.split('\n').filter((l) => l.startsWith(`| ${core} |`))).toHaveLength(1);
    const main = between('\n## What the status line means\n', '\n### ').split('\n');
    const lowDisk = main.findIndex((l) => l.startsWith('| Low disk: '));
    const voiceRows = main.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith('| Voice notes are not being transcribed: (reason) |') || l.startsWith(`| ${core} |`));
    expect(voiceRows).toHaveLength(2);
    for (const [, i] of voiceRows) expect(i).toBeGreaterThan(lowDisk);
    const report = main.findIndex((l) => l.startsWith('| Morning report: '));
    expect(report).toBeGreaterThan(0);
    expect(report).toBeLessThan(voiceRows[0]![1]);
  });

  // Phase 2b final polish: notes waiting on a refused key give up after 24 hours, so that line sits above the budget line.
  it('lists the key-refused line in the main table after the file lines and before the budget line, and says so', () => {
    const main = between('\n## What the status line means\n', '\n### ');
    const rows = main.split('\n');
    const refused = rows.findIndex((l) => l.startsWith('| Voice notes are not being transcribed: the speech-to-text key was refused. |'));
    const upload = rows.findIndex((l) => l.startsWith('| (number) files could not be uploaded to Drive.'));
    const budget = rows.findIndex((l) => l.startsWith("| (number) shared files waiting for today's AI budget"));
    expect(upload).toBeGreaterThan(0);
    expect(refused).toBe(upload + 1);
    expect(budget).toBe(refused + 1);
    expect(rows.find((l) => l.startsWith('| Voice notes are not being transcribed: (reason) |'))).not.toContain('key was refused');
    expect(main).toContain('The key-refused line comes before the budget line');
    const statusLines = between('\n### Voice note status lines\n', '\n## ');
    expect(statusLines).toContain('The key-refused line comes before the budget line');
    expect(statusLines).toContain('then the not-set-up and ffmpeg lines, then the could-not-transcribe line');
  });

  // Phase 2b final polish: the tries as the code makes them, in plain words.
  it('describes the tries as the code makes them: 3 for the engine, none for ffmpeg, 24 hours for stops', () => {
    const main = between('\n## What the status line means\n', '\n### ');
    const failed = between('\n### Voice notes the local engine could not transcribe\n', '\n### ');
    const statusLines = between('\n### Voice note status lines\n', '\n## ');
    for (const text of [main, failed, statusLines]) {
      expect(text).not.toContain('failed every try in the local engine (or in ffmpeg)');
      expect(text).not.toContain('after its 3 tries');
      expect(text).not.toContain('failed all 3 tries');
    }
    for (const text of [failed, statusLines]) {
      expect(text).toContain('3 tries');
      expect(text).toContain('not tried again');
      expect(text).toContain('24 hours');
    }
  });

  it('documents transcribe-voice --failed: the dry run, --yes, local only, never paid failures', () => {
    const failed = between('\n### Voice notes the local engine could not transcribe\n', '\n### ');
    expect(failed).toContain('npm run cli -- transcribe-voice --failed');
    expect(failed).toContain('npm run cli -- transcribe-voice --failed --yes');
    expect(failed).toContain('`Cost: $0 (local engine on this computer).`');
    expect(failed).toContain('only with `VOICE_STT_PROVIDER=local`');
    expect(failed).toContain('With a paid provider, these notes stay failed');
    expect(failed).toContain('never queued again');
    const commands = between('\n## Everyday commands (run in the waagent window)\n', '\n## ');
    expect(commands).toContain('| `npm run cli -- transcribe-voice --failed` |');
  });

  it('says to restart the service after changing the voice settings, next to transcribe-voice and --failed (final polish)', () => {
    const restart = 'After changing `VOICE_STT_PROVIDER` or the `STT_LOCAL_*` settings, restart the service before running this command.';
    expect(between('\n### Voice notes saved earlier\n', '\n### ')).toContain(restart);
    expect(between('\n### Voice notes the local engine could not transcribe\n', '\n### ')).toContain(restart);
  });

  it('says a running backlog note can delay a new one by up to STT_LOCAL_TIMEOUT_SECONDS, and no longer "after any new files"', () => {
    const earlier = between('\n### Voice notes saved earlier\n', '\n### ');
    expect(earlier).not.toContain('after any new files');
    expect(earlier).toContain('up to `STT_LOCAL_TIMEOUT_SECONDS`');
    expect(earlier).toContain('naming the setting');
  });

  it('SETUP-mac says a note over the timeout is stopped and tried again, never given up', () => {
    const mac = read('docs/SETUP-mac.md');
    const line = mac.split('\n').find((l) => l.includes('`STT_LOCAL_TIMEOUT_SECONDS` (default 1800'))!;
    expect(line).toContain('is stopped and tried again, 3 tries in all');
    expect(line).not.toContain('given up');
    expect(mac).toContain('transcribe-voice --failed');
  });

  it('the amendment no longer claims a health line that did not exist: it names the line and --failed', () => {
    const amendment = read('docs/superpowers/plans/phase-2b-amendments/2026-10-26-local-stt.md');
    expect(amendment).not.toContain('After the 3 attempts the file fails and the health line shows it.');
    expect(amendment).toContain('could not be transcribed on this computer');
    expect(amendment).toContain('transcribe-voice --failed');
    expect(amendment).toContain('### Final polish');
  });
});
