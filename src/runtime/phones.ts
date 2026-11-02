import { maskNumber } from '../config/env.ts';
import type { ClientConfig } from '../config/groups.ts';
import { ControlError, type Audit } from '../control/errors.ts';
import { founderGateway } from '../setupMode.ts';
import type { Db } from '../store/db.ts';
import type { Clock } from '../util/clock.ts';
import type { Logger } from '../util/logger.ts';
import { AllowList } from '../wa/allowlist.ts';
import {
  openPhoneSession, phoneIdOf, phoneName, phoneNumberIn, phoneSessionKey, SessionDecryptError, useEncryptedAuthState,
  type EncryptedAuth, type PhoneId, type ReadingPhone, type SessionHome,
} from '../wa/authState.ts';
import type { GatewayLike } from '../wa/gateway.ts';
import { founderLinkDriver, type LinkDriver } from '../wa/linkSession.ts';
import { unlinkPhone, type UnlinkResult } from '../wa/phoneControl.ts';
import { PhoneList, type PhoneEntry } from '../wa/phoneList.ts';
import { phoneOfConfig, PhoneSet } from '../wa/phoneSet.ts';
import type { SwitchableGateway } from '../wa/switchableGateway.ts';
import type { PhoneRoutesDeps, PhoneRow } from '../web/routes/whatsapp.ts';

// A workspace's reading phones in its runtime (lane C, change 7, task 9; the design's "How a runtime holds N gateways").
// Phone 1 is the session and auth the runtime opened as before, so it starts exactly as it did: no relink. Phones 2 to 5
// come from the phone list (kv wa_phones), each on its own session and subkey. All of them sit in one PhoneSet, which is
// the gateway the app gets. Linking, adding, renaming, unlinking and removing a phone change only that phone.

/** One reading phone's parts in the runtime. */
interface Slot {
  id: PhoneId;
  name: ReadingPhone;
  sessionDb: Db;
  /** Phones 2 to 5: their session is this runtime's to close. Phone 1's is the runtime's own. */
  ownsDb: boolean;
  allow: AllowList;
  switchable: SwitchableGateway;
  /** The number it is linked to, read at start and after each link; undefined when not linked. */
  number: string | undefined;
}

export interface WorkspacePhonesDeps {
  /** The workspace's tracker Db: its kv (the phone list) and session_reset_at. */
  db: Db;
  sessions: SessionHome;
  /** The workspace key: the master key (founder) or the customer's data key. */
  key: Buffer;
  clock: Clock;
  log: Logger;
  /** Phone 1 as the runtime opened it: today's session, its auth, and whether it is linked (setup mode when not). */
  phone1: { sessionDb: Db; auth: EncryptedAuth; linked: boolean };
  configs: readonly ClientConfig[];
  /** A reading phone's gateway on its own allow-list and auth (Baileys in production; a test's fakes). */
  buildGateway: (allow: AllowList, auth: EncryptedAuth, onQr?: (qr: string) => void) => GatewayLike;
  /** Writes one audit row inside the change's transaction (the dashboard's audit log); a no-op without one. */
  audit: Audit;
}

export interface WorkspacePhones {
  /** The app's one gateway. */
  readonly set: PhoneSet;
  readonly list: PhoneList;
  /** The link driver of a reading phone in the list; undefined for one not added (the route answers 404). */
  driver(target: ReadingPhone): LinkDriver | undefined;
  /** Every reading phone's linked number (the spare refuses each of them). */
  numbers(): string[];
  /**
   * Open chat's "connected": for a group, its own phone is open (another phone being up does not count); asked without
   * a group, any phone is open.
   */
  connected(groupId?: string): boolean;
  /**
   * What Open chat takes of WhatsApp, each through the group's own phone only: whether it is connected, the send socket,
   * the members and the Delete chat socket (never another phone's).
   */
  readonly chat: {
    connected: (groupId?: string) => boolean;
    groupSocket: (groupId: string) => ReturnType<PhoneSet['groupSocket']>;
    groupMembers: (groupId: string) => ReturnType<PhoneSet['groupMembers']>;
    chatDeleteSocket: (groupId: string) => ReturnType<PhoneSet['chatDeleteSocket']>;
  };
  /** The approved groups changed: each phone's allow-list follows. */
  setConfigs(configs: readonly ClientConfig[]): void;
  /** The phone routes' deps (src/web/routes/whatsapp.ts PhoneRoutes). */
  readonly routes: PhoneRoutesDeps;
  /** Closes phones 2 to 5's sessions (after app.stop() has stopped their gateways). Phone 1's is the runtime's. */
  close(): Promise<void>;
}

const digitsOf = (auth: EncryptedAuth | undefined): string | undefined => auth?.state.creds.me?.id?.split(/[:@]/)[0];

export async function workspacePhones(d: WorkspacePhonesDeps): Promise<WorkspacePhones> {
  let configs = d.configs;
  const groupsOn = (id: PhoneId) => configs.filter((c) => phoneOfConfig(c) === id).length;
  const list = await PhoneList.open({ db: d.db, clock: d.clock, groupsOn });
  const set = new PhoneSet({ clock: d.clock });
  set.setConfigs(configs);
  const slots = new Map<PhoneId, Slot>();

  /**
   * A phone's slot: phone 1 from the runtime's own session; 2 to 5 opened here. A session this key cannot open is not
   * linked. An unlinked phone (`active` false) builds no gateway, even with rows left from a clear that failed: it holds
   * none until a new link.
   */
  async function open(id: PhoneId, active = true): Promise<Slot> {
    const allow = new AllowList([]);
    if (id === 1) {
      const p = d.phone1;
      const linked = p.linked && active;
      return {
        id, name: 'founder', sessionDb: p.sessionDb, ownsDb: false, allow, number: linked ? digitsOf(p.auth) : undefined,
        switchable: founderGateway({ linked, build: () => d.buildGateway(allow, p.auth) }),
      };
    }
    const name = phoneName(id);
    const sessionDb = await openPhoneSession(d.sessions, name);
    let auth: EncryptedAuth | undefined;
    try {
      auth = await useEncryptedAuthState(sessionDb, phoneSessionKey(d.key, name));
    } catch (err) {
      if (!(err instanceof SessionDecryptError)) throw err;
      d.log.error({ phone: id }, 'a reading phone’s session cannot be opened with this key; it waits for a new link');
    }
    const linked = active && auth?.hasSession === true;
    return {
      id, name, sessionDb, ownsDb: true, allow, number: linked ? digitsOf(auth) : undefined,
      switchable: founderGateway({ linked, build: () => d.buildGateway(allow, auth!) }),
    };
  }

  const join = (s: Slot, label: string) => set.add({ id: s.id, label, gateway: s.switchable, allow: s.allow });

  for (const p of list.list()) {
    const s = await open(p.id, p.state === 'active');
    slots.set(p.id, s);
    if (p.state === 'active') join(s, p.label);
  }

  /** A link on this phone: today's QR flow on its own session, key and switchable; a number in use is refused. */
  function linkDriver(s: Slot): LinkDriver {
    const inner = founderLinkDriver({
      sessionDb: s.sessionDb, trackerDb: d.db, key: phoneSessionKey(d.key, s.name), switchable: s.switchable, log: d.log,
      buildGateway: (auth, onQr) => d.buildGateway(s.allow, auth, onQr),
      resetKey: s.id === 1 ? 'session_reset_at' : `session_reset_at:${s.name}`,
      refuse: (n) => ([...slots.values()].some((o) => o.id !== s.id && o.number === n) ? 'number_in_use' : undefined),
    });
    return {
      run: async (hooks, signal) => {
        const entry = list.get(s.id);
        // An unlinked phone is out of the set: it joins for the link, and leaves again if the link is not kept.
        const rejoined = entry?.state === 'unlinked' && !set.phones().some((p) => p.id === s.id);
        if (rejoined) join(s, entry!.label);
        const outcome = await inner.run(hooks, signal);
        if (outcome.ok) {
          await list.activate(s.id);
          s.number = (await phoneNumberIn(d.sessions, d.key, s.name).catch(() => undefined)) ?? s.number;
        } else if (rejoined) {
          await set.remove(s.id);
        }
        return outcome;
      },
    };
  }

  const routes: PhoneRoutesDeps = {
    list: (): PhoneRow[] => {
      const live = new Map(set.phones().map((p) => [p.id, p.status.state]));
      return list.list().map((p) => {
        const s = slots.get(p.id);
        return {
          id: p.id, label: p.label, state: p.state, number: s?.number ? maskNumber(s.number) : null,
          status: p.state === 'active' ? (live.get(p.id) ?? null) : null, groups: groupsOn(p.id),
        };
      });
    },
    add: async (label, actor) => {
      const entry = await list.add(label, actor, d.audit);
      const s = await open(entry.id);
      slots.set(entry.id, s);
      join(s, entry.label);
      return entry;
    },
    rename: async (id, label, actor) => {
      const entry = await list.rename(id, label, actor, d.audit);
      set.rename(id, entry.label);
      return entry;
    },
    unlink: async (id, actor): Promise<UnlinkResult> => {
      const s = slots.get(id);
      if (!s || list.get(id) === undefined) return Promise.reject(notFound());
      const r = await unlinkPhone({ id, actor, audit: d.audit, list, set, gateway: s.switchable, sessionDb: s.sessionDb, number: s.number, log: d.log });
      s.number = undefined;
      return r;
    },
    remove: async (id, actor): Promise<PhoneEntry> => {
      const entry = await list.remove(id, actor, d.audit);
      const s = slots.get(id);
      slots.delete(id);
      await set.remove(id);
      if (s?.ownsDb) await s.sessionDb.close().catch(() => undefined);
      return entry;
    },
  };

  const connected = (groupId?: string) => (groupId !== undefined ? set.isOpenFor(groupId) : set.phones().some((p) => p.status.state === 'open'));
  return {
    set,
    list,
    chat: {
      connected,
      groupSocket: (groupId) => set.groupSocket(groupId),
      groupMembers: (groupId) => set.groupMembers(groupId),
      chatDeleteSocket: (groupId) => set.chatDeleteSocket(groupId),
    },
    driver: (target) => {
      const id = phoneIdOf(target);
      const s = slots.get(id);
      return s && list.get(id) ? linkDriver(s) : undefined;
    },
    numbers: () => [...slots.values()].map((s) => s.number).filter((n): n is string => n !== undefined),
    connected,
    setConfigs: (next) => {
      configs = next;
      set.setConfigs(next);
    },
    routes,
    close: async () => {
      for (const s of slots.values()) if (s.ownsDb) await s.sessionDb.close().catch(() => undefined);
    },
  };
}

/** The phone list's own 404, for a phone that is not there. */
function notFound(): ControlError {
  return new ControlError(404, 'There is no such phone.');
}
