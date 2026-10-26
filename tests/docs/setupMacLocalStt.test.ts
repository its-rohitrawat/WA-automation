import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

describe('SETUP-mac.md: voice notes, local speech-to-text', () => {
  const setup = read('docs/SETUP-mac.md');
  const start = setup.indexOf('\n## 8. Voice notes: local speech-to-text\n');
  const end = setup.indexOf('\n## ', start + 1);
  const section = setup.slice(start, end);
  const amendment = read('docs/superpowers/plans/phase-2b-amendments/2026-10-26-local-stt.md');

  it('has the section', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  });

  it('says it is off until VOICE_STT_PROVIDER=local, and that the service wiring comes later', () => {
    expect(section).toContain('It is **off** until you set `VOICE_STT_PROVIDER=local`.');
    expect(section).toContain('**In this version the service does not use it yet.**');
    expect(parseEnv({}).VOICE_STT_PROVIDER).toBe('none');
  });

  it('pins transcribe.cpp v0.4.1, builds with cmake, and Whisper without Metal', () => {
    expect(section).toContain('git clone --branch v0.4.1 --depth 1 https://github.com/handy-computer/transcribe.cpp.git');
    expect(section).toContain('cmake -B build -DCMAKE_BUILD_TYPE=Release');
    expect(section).toContain('cmake -B build -DGGML_METAL=OFF');
    expect(section).toContain('cmake --build build -j --config Release');
  });

  it('lists every model file of the amendment with its address and SHA-256, and checks it with shasum', () => {
    const rows = [...amendment.matchAll(/^\| \S+(?: \(smaller\))? \| `([^`]+)` \/ `([^`]+)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)];
    // The repeated repos are written "same repo" there.
    const sameRepo = [...amendment.matchAll(/^\| \S+ \(smaller\) \| same repo \/ `([^`]+)` \| [^|]+ \| `([0-9a-f]{64})` \|$/gm)];
    expect(rows.length).toBe(3);
    expect(sameRepo.length).toBe(2);
    for (const [, repo, file, sha] of rows) {
      expect(section).toContain(`https://huggingface.co/${repo!}/resolve/main/${file!}`);
      expect(section).toContain(`\`${sha!}\``);
    }
    for (const [, file, sha] of sameRepo) {
      expect(section).toContain(`/resolve/main/${file!}`);
      expect(section).toContain(`\`${sha!}\``);
    }
    expect(section).toContain('shasum -a 256');
  });

  it('makes the test WAV with ffmpeg and runs the check, then restarts the service', () => {
    expect(section).toContain('-ar 16000 -ac 1 -c:a pcm_s16le');
    expect(section).toContain('npm run stt:local-check -- ');
    expect(section).toContain('sudo launchctl kickstart -k system/com.wa-agent');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['stt:local-check']).toBe('node scripts/stt-local-check.ts');
  });

  it('sets the four settings', () => {
    for (const s of ['VOICE_STT_PROVIDER=local', 'STT_LOCAL_ENGINE=voxtral', 'STT_LOCAL_BIN=/', 'STT_LOCAL_MODEL=/']) expect(section).toContain(s);
  });
});
