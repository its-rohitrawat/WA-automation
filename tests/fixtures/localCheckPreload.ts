// Test preload for scripts/stt-local-check.ts (tests/scripts/sttLocalCheck.test.ts), loaded with node --import.
// 1. No .env file is ever read: loadEnv takes a missing file as none, so the settings come from the child's env only.
// 2. On Windows a script cannot be run as a program without a shell, so the fake engine (a .mjs file named in
//    STT_LOCAL_BIN) is run through this node instead, with the same arguments and options. Elsewhere it runs itself.
import { createRequire, syncBuiltinESMExports } from 'node:module';

process.loadEnvFile = () => {
  throw Object.assign(new Error('no .env in this test'), { code: 'ENOENT' });
};

if (process.platform === 'win32') {
  const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  const real = childProcess.execFile as (...a: unknown[]) => unknown;
  (childProcess as { execFile: unknown }).execFile = (file: string, args: string[], ...rest: unknown[]) =>
    file.endsWith('.mjs') ? real(process.execPath, [file, ...args], ...rest) : real(file, args, ...rest);
  syncBuiltinESMExports();
}
