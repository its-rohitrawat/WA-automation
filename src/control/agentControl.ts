import type { SpendView } from '../app.ts';
import type { Env } from '../config/env.ts';
import type { Health, HealthSnapshot } from '../health/health.ts';
import { MAIN_ACCOUNT, meetingAccounts } from '../output/googleAuth.ts';
import type { SenderStatus } from '../report/types.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import { istDate } from '../util/time.ts';
import type { GatewayStatus } from '../wa/gateway.ts';
import { overview, type Overview } from './queries.ts';
import { lastTrackerUpload } from './trackerQueries.ts';

// The dashboard's only way into the running agent (D1 Task 5, spec 4.2), read side. Everything here is read from the
// live health snapshot, the gateway and sender status and the database, and reduced to what the screens need: states,
// plain labels, counts and times. Never a token, a key, a heartbeat link, a full phone number or message text.

export type PartState = 'ok' | 'warn' | 'down' | 'off';

export interface StatusPart {
  key: 'whatsapp' | 'tracker' | 'meetings' | 'voice' | 'report' | 'spend';
  name: string;
  state: PartState;
  label: string;
}

export interface AgentStatus {
  at: string;
  up: boolean;
  line: { ok: boolean; text: string };
  parts: StatusPart[];
  /** The newest message the agent has stored, from any approved group; null before the first. */
  lastMessageAt: string | null;
  spentToday: number;
  capUsd: number;
}

export interface Connections {
  founder: { state: PartState; label: string; groups: number; lastActivityAt: string | null; device: string };
  spare: { state: PartState; label: string; device: string; recipientMasked: string | null };
  google: { label: string; email: string | null; usedFor: string[]; state: PartState; stateLabel: string }[];
  drive: { state: PartState; label: string; lastUploadAt: string | null };
  claude: { callsToday: number; spentToday: number; capUsd: number };
  monitoring: { on: boolean; lastBeatAt: string | null };
}

export interface AgentControlDeps {
  app: { health: Pick<Health, 'snapshot' | 'isUp' | 'downReason' | 'publishProblem'>; spend: SpendView };
  db: Db;
  /** The founder-number gateway: its status only. */
  gateway: { status(): GatewayStatus };
  env: Pick<Env, 'MEETINGS_ENABLED' | 'VOICE_STT_PROVIDER'>;
  clock: Clock;
  /**
   * The morning report's spare-number sender, when the report module is open. A function is read on each call: the
   * dashboard's live briefing opens, swaps and closes its sender while the service runs (undefined while none is open).
   */
  sender?: SenderView | (() => SenderView | undefined);
  /**
   * With the dashboard: whether the spare phone has a saved link, for while no sender is open (the briefing is off). Not
   * given: the spare phone shows as switched off then, as before.
   */
  spareLinked?: () => boolean;
  /** The uptime heartbeat, when HEARTBEAT_URL is set. */
  heartbeat?: { lastBeatAt(): Date | null };
}

type SenderView = { status(): SenderStatus; maskedRecipient(): string };

const FOUNDER_DEVICE = 'WA Agent - Tracker';
const SPARE_DEVICE = 'WA Agent - Morning report';
/** From this share of the daily cap on, the spend part warns. */
const NEAR_CAP = 0.8;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

export class AgentControl {
  readonly #d: AgentControlDeps;

  constructor(d: AgentControlDeps) {
    this.#d = d;
  }

  #whatsapp(): { state: PartState; label: string } {
    const s = this.#d.gateway.status();
    switch (s.state) {
      case 'logged_out':
        return { state: 'down', label: 'Unlinked from the phone' };
      case 'replaced':
        return { state: 'down', label: 'Taken over by another copy' };
      case 'forbidden':
        return { state: 'down', label: 'Refused by WhatsApp' };
      // Setup mode: no founder link yet. The front end keys its "Link the founder's phone" call to action on this label.
      case 'not_linked':
        return { state: 'down', label: 'Not linked' };
      case 'linking':
        return { state: 'warn', label: 'Linking from the dashboard' };
      case 'open':
        return s.credsSaveFailures > 0 ? { state: 'warn', label: 'The session could not be saved' } : { state: 'ok', label: 'Connected' };
      default:
        // Health counts a disconnect as down only past its grace period; until then it is reconnecting.
        if (this.#d.app.health.downReason() === 'whatsapp_disconnected') return { state: 'down', label: 'Disconnected' };
        return { state: 'warn', label: s.state === 'connecting' ? 'Connecting' : s.state === 'stopped' ? 'Starting' : 'Reconnecting' };
    }
  }

  /** The tracker upload's own state (Health.publishProblem), shown even while WhatsApp is down for another cause. */
  #tracker(snap: HealthSnapshot): { state: PartState; label: string } {
    switch (this.#d.app.health.publishProblem()) {
      case 'google_signin':
        return { state: 'down', label: 'Google sign-in expired' };
      case 'tracker_failing':
        return { state: 'down', label: 'Uploads failing for over an hour' };
      case 'failing':
        return { state: 'warn', label: 'Upload failing' };
      case null:
        // The audit log keeps the last upload across a restart; the snapshot's time lives in memory only.
        return { state: 'ok', label: lastTrackerUpload(this.#d.db, snap.lastPublishedAt) === null ? 'Waiting for the first upload' : 'Updated' };
    }
  }

  #meetings(snap: HealthSnapshot): { state: PartState; label: string } {
    const m = snap.meetings;
    if (!this.#d.env.MEETINGS_ENABLED || m === undefined) return { state: 'off', label: 'Switched off' };
    if (m.paused === 'google_auth' || m.paused === 'google_scopes') return { state: 'down', label: 'Paused: Google needs meeting access' };
    if (m.paused === 'no_ffmpeg') return { state: 'down', label: 'Paused: ffmpeg not found' };
    const lost = m.lostAccounts ?? [];
    if (lost.length > 0) return { state: 'warn', label: `Google sign-in lost for ${lost.join(', ')}` };
    if (m.stats.failed > 0) return { state: 'warn', label: `${plural(m.stats.failed, 'meeting')} could not be processed` };
    if (m.sttProvider === 'none' && m.stats.waiting > 0) return { state: 'warn', label: 'Waiting: speech-to-text is not set up' };
    if ((m.stats.deferred.stt_unavailable ?? 0) > 0) return { state: 'warn', label: 'Waiting: the speech-to-text key was refused' };
    return { state: 'ok', label: 'Working' };
  }

  #voice(snap: HealthSnapshot): { state: PartState; label: string } {
    if (this.#d.env.VOICE_STT_PROVIDER === 'none') return { state: 'off', label: 'Switched off' };
    if (snap.voiceProblem === 'no_ffmpeg') return { state: 'warn', label: 'ffmpeg not found' };
    if (snap.voiceProblem !== undefined) return { state: 'warn', label: 'The local speech engine is not set up' };
    if ((snap.media?.sttRefused ?? 0) > 0) return { state: 'warn', label: 'The speech-to-text key was refused' };
    const failed = snap.media?.voiceFailed ?? 0;
    if (failed > 0) return { state: 'warn', label: `${plural(failed, 'voice note')} could not be transcribed` };
    return { state: 'ok', label: 'Working' };
  }

  #report(snap: HealthSnapshot): { state: PartState; label: string } {
    const r = snap.report;
    if (r === undefined || r.text === 'Morning report: off') return { state: 'off', label: 'Off' };
    const label = capital(r.text.replace(/^Morning report:?\s*/, ''));
    return { state: r.warning ? 'warn' : 'ok', label };
  }

  #spend(): { state: PartState; label: string } {
    const { spend } = this.#d.app;
    if (spend.isPaused()) return { state: 'warn', label: 'Daily limit reached: AI work waits until midnight IST' };
    if (spend.spentToday() >= NEAR_CAP * spend.capUsd) return { state: 'warn', label: 'Near the daily limit' };
    return { state: 'ok', label: 'Within the daily limit' };
  }

  #lastMessageAt(): string | null {
    // The newest message time among the last 500 stored, found through the primary key (MAX(ts) over the whole table
    // would read a whole index on every poll). Not simply the last row: the catch-up after a reconnect stores older
    // messages last.
    return (this.#d.db.prepare('SELECT MAX(ts) AS ts FROM (SELECT ts FROM messages ORDER BY id DESC LIMIT 500)').get() as { ts: string | null }).ts;
  }

  status(): AgentStatus {
    const { health, spend } = this.#d.app;
    const snap = health.snapshot();
    const parts: StatusPart[] = [
      { key: 'whatsapp', name: 'WhatsApp', ...this.#whatsapp() },
      { key: 'tracker', name: 'Tracker on Drive', ...this.#tracker(snap) },
      { key: 'meetings', name: 'Meetings', ...this.#meetings(snap) },
      { key: 'voice', name: 'Voice notes', ...this.#voice(snap) },
      { key: 'report', name: 'Morning briefing', ...this.#report(snap) },
      { key: 'spend', name: 'Claude spend', ...this.#spend() },
    ];
    return {
      at: snap.at,
      up: health.isUp(),
      line: { ok: snap.line.ok, text: snap.line.text },
      parts,
      lastMessageAt: this.#lastMessageAt(),
      spentToday: spend.spentToday(),
      capUsd: spend.capUsd,
    };
  }

  overview(): Overview {
    return overview(this.#d.db, this.#d.clock.now(), this.#d.app.health.snapshot());
  }

  connections(): Connections {
    const { db, env, clock, heartbeat } = this.#d;
    const sender = typeof this.#d.sender === 'function' ? this.#d.sender() : this.#d.sender;
    const { health, spend } = this.#d.app;
    const snap = health.snapshot();
    const now = clock.now();
    const groups = (db.prepare('SELECT COUNT(*) AS n FROM clients WHERE active = 1').get() as { n: number }).n;
    const lost = new Set(snap.meetings?.lostAccounts ?? []);
    const signInExpired = health.publishProblem() === 'google_signin';
    const meetingAccess = snap.meetings?.paused === 'google_auth' || snap.meetings?.paused === 'google_scopes';
    const mainState = signInExpired
      ? { state: 'down' as const, stateLabel: 'Sign-in expired' }
      : meetingAccess ? { state: 'warn' as const, stateLabel: 'Needs meeting access' } : { state: 'ok' as const, stateLabel: 'Connected' };
    const google = [
      { label: MAIN_ACCOUNT, email: null, usedFor: ['Tracker on Drive', ...(env.MEETINGS_ENABLED ? ['Meetings'] : [])], ...mainState },
      ...meetingAccounts(db).map((label) => ({
        label, email: null, usedFor: ['Meetings'],
        ...(lost.has(label) ? { state: 'down' as const, stateLabel: 'Sign-in lost' } : { state: 'ok' as const, stateLabel: 'Connected' }),
      })),
    ];
    const calls = (db.prepare("SELECT COUNT(*) AS n FROM spend WHERE day = ? AND kind = 'ai'").get(istDate(now)) as { n: number }).n;
    const beat = heartbeat?.lastBeatAt() ?? null;
    return {
      founder: { ...this.#whatsapp(), groups, lastActivityAt: this.#lastMessageAt(), device: FOUNDER_DEVICE },
      spare: sender ? { ...spareState(sender.status()), device: SPARE_DEVICE, recipientMasked: sender.maskedRecipient() }
        : this.#d.spareLinked
          ? { ...(this.#d.spareLinked() ? { state: 'ok' as const, label: 'Linked' } : { state: 'warn' as const, label: 'Not linked' }), device: SPARE_DEVICE, recipientMasked: null }
          : { state: 'off', label: 'Switched off', device: SPARE_DEVICE, recipientMasked: null },
      google,
      drive: { ...this.#tracker(snap), lastUploadAt: lastTrackerUpload(db, snap.lastPublishedAt) },
      claude: { callsToday: calls, spentToday: spend.spentToday(), capUsd: spend.capUsd },
      monitoring: { on: heartbeat !== undefined, lastBeatAt: beat === null ? null : beat.toISOString() },
    };
  }
}

function spareState(s: SenderStatus): { state: PartState; label: string } {
  switch (s.state) {
    case 'idle':
      return { state: 'ok', label: 'Linked' };
    case 'connecting':
    case 'open':
      return { state: 'ok', label: 'Connected' };
    case 'not_linked':
      return { state: 'warn', label: 'Not linked' };
    case 'unreadable':
      return { state: 'down', label: 'Its saved session cannot be read' };
    case 'unavailable':
      return { state: 'down', label: 'Its session file could not be opened' };
    case 'self_send':
      return { state: 'down', label: "Linked to the founder's own number" };
    case 'logged_out':
      return { state: 'down', label: 'Logged out' };
    case 'forbidden':
      return { state: 'down', label: 'Refused by WhatsApp' };
    case 'replaced':
      return { state: 'down', label: 'Taken over by another session' };
  }
}
