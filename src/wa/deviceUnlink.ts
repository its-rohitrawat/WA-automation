// Unlinking a reading phone (lane C, change 7; the owner confirmed it on the dashboard): WhatsApp is asked to log the
// agent's linked device out, so it leaves that phone's Linked devices. It reaches no chat and no other person. Here: one
// request, for one phone's own socket while open, once, with a 10 s limit; nothing here retries. This is the one module in
// src that names Baileys' method for it (tests/wa/sendScan.test.ts keeps every other module from naming it).

/** The part of a Baileys socket this module uses. */
export interface DeviceUnlinkSocket {
  logout(msg?: string): Promise<void>;
}

/** How long the unlink waits for WhatsApp to take it before it goes on without it. */
export const UNLINK_TIMEOUT_MS = 10_000;

/** The socket as a DeviceUnlinkSocket, when it has the method; null for a socket that cannot (a test fake). */
export function asDeviceUnlinkSocket(sock: object): DeviceUnlinkSocket | null {
  return typeof (sock as Partial<DeviceUnlinkSocket>).logout === 'function' ? (sock as DeviceUnlinkSocket) : null;
}

/**
 * Asks WhatsApp to unlink this device: true when it took it; false when the request failed or no answer came in time.
 * Never throws, and never passes the error on (it can carry the request).
 */
export async function unlinkDevice(sock: DeviceUnlinkSocket, timeoutMs = UNLINK_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([sock.logout().then(() => true as const), late]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
