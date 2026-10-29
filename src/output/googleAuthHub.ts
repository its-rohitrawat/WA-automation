import { auth } from '@googleapis/drive';
import { txSync, type Db } from '../store/db.ts';
import { getKv } from '../store/kv.ts';
import type { Logger } from '../util/logger.ts';
import {
  MAIN_ACCOUNT, meetingAccounts, saveGrantedScopes, saveMeetingAccount, saveTokenIssuer, TokenDecryptError, tokenIssuerKey, TokenStore,
  type OAuth2Client, type TokenIssuer,
} from './googleAuth.ts';

export type { TokenIssuer };

// One Google OAuth client per account label ('main', then the meeting accounts), replaceable in place (D3). The Drive
// publisher, the media uploader and meetings read their client through a getter, so a reconnect from the dashboard
// applies to the next call without a restart.
//
// Each refresh token belongs to the OAuth client that issued it: 'desktop' (google-auth on the Mac, the only kind until
// the dashboard) or 'web' (the dashboard's reconnect). The issuer is kept in kv google_client:<label>; a missing value
// means desktop, so the tokens stored before the dashboard keep working. Tokens are encrypted by TokenStore as before.

/** An OAuth client's id and secret, from .env (main.ts reads them; nothing here does). */
export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/** Why an account has no client: no token stored, a token this key cannot read, or its issuing client not configured. */
export type AccountProblem = 'not_connected' | 'unreadable' | 'no_client';

/** A Google call for an account that has no usable client. */
export class GoogleNotConnectedError extends Error {
  readonly code = 'google_not_connected';
  readonly label: string;
  constructor(label: string) {
    super(`Google account ${label} is not connected`);
    this.name = 'GoogleNotConnectedError';
    this.label = label;
  }
}

export interface GoogleAuthHubOptions {
  db: Db;
  key: Buffer;
  credentials: { desktop?: OAuthCredentials; web?: OAuthCredentials };
  /** Test seam; default builds an OAuth2 client from the credentials. */
  newClient?: (c: OAuthCredentials) => OAuth2Client;
  log?: Logger;
}

interface Account {
  client: OAuth2Client | undefined;
  issuer: TokenIssuer;
  problem: AccountProblem | null;
}

export class GoogleAuthHub {
  readonly #db: Db;
  readonly #key: Buffer;
  readonly #credentials: GoogleAuthHubOptions['credentials'];
  readonly #newClient: (c: OAuthCredentials) => OAuth2Client;
  readonly #accounts = new Map<string, Account>();
  readonly #listeners = new Set<(label: string) => void>();
  readonly #log: Logger | undefined;

  constructor(o: GoogleAuthHubOptions) {
    this.#log = o.log;
    this.#db = o.db;
    this.#key = o.key;
    this.#credentials = o.credentials;
    this.#newClient = o.newClient ?? ((c) => new auth.OAuth2(c.clientId, c.clientSecret));
    for (const label of [MAIN_ACCOUNT, ...meetingAccounts(o.db)]) {
      const account = this.#load(label);
      if (account) this.#accounts.set(label, account);
    }
  }

  /** Labels with a stored token (usable or not), main first, then in the order they were added. */
  labels(): string[] {
    return [...this.#accounts.keys()];
  }

  /** The account's current client, or undefined when it has none. */
  client(label: string): OAuth2Client | undefined {
    return this.#accounts.get(label)?.client;
  }

  /** A getter for consumers: always the current client; throws GoogleNotConnectedError when there is none. */
  getter(label: string): () => OAuth2Client {
    return () => {
      const c = this.client(label);
      if (!c) throw new GoogleNotConnectedError(label);
      return c;
    };
  }

  /** The client that issued the account's token (desktop when unknown). */
  issuer(label: string): TokenIssuer {
    return this.#accounts.get(label)?.issuer ?? 'desktop';
  }

  problem(label: string): AccountProblem | null {
    const a = this.#accounts.get(label);
    return a ? a.problem : 'not_connected';
  }

  /**
   * A new sign-in for the account. In one transaction: the refresh token (encrypted, as google-auth stores it), the
   * client that issued it, the scopes Google granted, and, for a meeting account, its place in the account list. Only
   * after that commits is the account's client replaced and are the listeners told, so a meetings rebuild sees the new
   * scopes and label. Throws, changing nothing, when the issuing client is not configured or the write fails. Checking
   * that the scopes are the required ones is the caller's job (as runLoopbackConsent does for google-auth).
   */
  setToken(label: string, refreshToken: string, issuer: TokenIssuer, scope: string): void {
    tokenIssuerKey(label); // checks the label before anything else
    const creds = this.#credentials[issuer];
    if (!creds) {
      throw new Error(issuer === 'web' ? 'The dashboard Google client is not set up on the Mac.' : 'The Google client is not set up on the Mac.');
    }
    const client = this.#newClient(creds);
    client.setCredentials({ refresh_token: refreshToken });
    txSync(this.#db, () => {
      if (label === MAIN_ACCOUNT) {
        new TokenStore(this.#db, this.#key).save(refreshToken);
        saveGrantedScopes(this.#db, scope);
      } else {
        saveMeetingAccount(this.#db, this.#key, label, refreshToken, scope, issuer); // token, scopes, issuer and list entry
      }
      if (label === MAIN_ACCOUNT) saveTokenIssuer(this.#db, MAIN_ACCOUNT, issuer);
    });
    this.#accounts.set(label, { client, issuer, problem: null });
    for (const fn of [...this.#listeners]) {
      try {
        fn(label);
      } catch (err) {
        // One faulty listener must not stop the others. Only the label and the error's type are logged.
        this.#log?.error({ account: label, code: (err as Error | null)?.name ?? 'Error' }, 'Google account change listener failed');
      }
    }
  }

  /** Called with the label after every setToken. Returns a function that unsubscribes. */
  onChange(fn: (label: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #load(label: string): Account | undefined {
    const stored = getKv(this.#db, tokenIssuerKey(label));
    const issuer: TokenIssuer = stored === 'web' ? 'web' : 'desktop';
    let token: string | undefined;
    try {
      token = new TokenStore(this.#db, this.#key, label === MAIN_ACCOUNT ? undefined : label).load();
    } catch (e) {
      if (!(e instanceof TokenDecryptError)) throw e;
      return { client: undefined, issuer, problem: 'unreadable' };
    }
    if (!token) return undefined;
    const creds = this.#credentials[issuer];
    if (!creds) return { client: undefined, issuer, problem: 'no_client' };
    const client = this.#newClient(creds);
    client.setCredentials({ refresh_token: token });
    return { client, issuer, problem: null };
  }
}
