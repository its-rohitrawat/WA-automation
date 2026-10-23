import { open, rm } from 'node:fs/promises';
import {
  DownloadTooBigError,
  GoogleNoAccessError,
  type ConferenceRef,
  type DriveVideoInfo,
  type InviteInfo,
  type MeetingsGoogleApi,
  type RecordingRef,
} from '../../src/meetings/googleApi.ts';

export type MeetingsMethod = keyof MeetingsGoogleApi;

export interface FakeMeetingFile {
  info: DriveVideoInfo;
  bytes: Buffer;
}

/**
 * Meet, Calendar and Drive in memory. Answers are copies, so a caller cannot change the stored state. Like the real
 * client, a call on a stopped signal throws the signal's reason, and download writes real bytes with 'wx', stops at
 * maxBytes and leaves no file behind on any failure.
 */
export class FakeMeetingsApi implements MeetingsGoogleApi {
  /** listConferences returns those whose startTime is in [from, to), in this order. */
  conferences: ConferenceRef[] = [];
  /** Conference name → its recordings (missing: none). */
  recordings = new Map<string, RecordingRef[]>();
  /** Conference name → signed-in display names (missing: none). */
  signedInNames = new Map<string, string[]>();
  /** Space name → meeting code (missing: null). */
  codes = new Map<string, string | null>();
  /** Meeting code → invite (missing: null). The ±3 h window is not checked. */
  invites = new Map<string, InviteInfo>();
  /** Drive file id → its info and bytes (missing: GoogleNoAccessError http_404). */
  files = new Map<string, FakeMeetingFile>();
  /** Every call in order, including the ones that failed. args leave out the signal. */
  calls: { method: MeetingsMethod; args: unknown[] }[] = [];
  /** When set, the next call (any method) throws this once. */
  failNextWith: unknown;
  /** Every call of a method listed here throws its error, until the entry is deleted. */
  failWith = new Map<MeetingsMethod, unknown>();
  /** When set, every call waits for it (a slow or hung Google). A stop through the signal ends the wait. */
  gate: Promise<void> | undefined;

  /** The calls of one method, as their args. */
  callsOf(method: MeetingsMethod): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  async listConferences(fromIso: string, toIso: string, signal: AbortSignal): Promise<ConferenceRef[]> {
    await this.#enter('listConferences', [fromIso, toIso], signal);
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    return this.conferences.filter((c) => Date.parse(c.startTime) >= from && Date.parse(c.startTime) < to).map((c) => ({ ...c }));
  }

  async listRecordings(conference: string, signal: AbortSignal): Promise<RecordingRef[]> {
    await this.#enter('listRecordings', [conference], signal);
    return (this.recordings.get(conference) ?? []).map((r) => ({ ...r }));
  }

  async listSignedInNames(conference: string, signal: AbortSignal): Promise<string[]> {
    await this.#enter('listSignedInNames', [conference], signal);
    return [...(this.signedInNames.get(conference) ?? [])];
  }

  async meetingCode(space: string, signal: AbortSignal): Promise<string | null> {
    await this.#enter('meetingCode', [space], signal);
    return this.codes.get(space) ?? null;
  }

  async findInvite(code: string, startIso: string, signal: AbortSignal): Promise<InviteInfo | null> {
    await this.#enter('findInvite', [code, startIso], signal);
    const invite = this.invites.get(code);
    return invite ? { title: invite.title, attendees: invite.attendees.map((a) => ({ ...a })) } : null;
  }

  async videoInfo(fileId: string, signal: AbortSignal): Promise<DriveVideoInfo> {
    await this.#enter('videoInfo', [fileId], signal);
    const file = this.files.get(fileId);
    if (!file) throw new GoogleNoAccessError('http_404');
    return { ...file.info };
  }

  async download(fileId: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<number> {
    await this.#enter('download', [fileId, dest, maxBytes], signal, false);
    const fh = await open(dest, 'wx'); // an existing dest: EEXIST, and it is left alone
    let written = 0;
    try {
      await this.#wait(signal); // inside: a stop while the download hangs leaves no file
      const file = this.files.get(fileId);
      if (!file) throw new GoogleNoAccessError('http_404');
      if (file.bytes.length > maxBytes) throw new DownloadTooBigError();
      await fh.writeFile(file.bytes);
      await fh.sync();
      written = file.bytes.length;
    } catch (e) {
      await fh.close();
      await rm(dest, { force: true });
      throw e;
    }
    await fh.close();
    return written;
  }

  async #enter(method: MeetingsMethod, args: unknown[], signal: AbortSignal, waitForGate = true): Promise<void> {
    this.calls.push({ method, args });
    signal.throwIfAborted();
    if (this.failNextWith !== undefined) {
      const e = this.failNextWith;
      this.failNextWith = undefined;
      throw e;
    }
    if (this.failWith.has(method)) throw this.failWith.get(method);
    if (waitForGate) await this.#wait(signal);
  }

  async #wait(signal: AbortSignal): Promise<void> {
    const gate = this.gate;
    if (!gate) return;
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      gate.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }
}
