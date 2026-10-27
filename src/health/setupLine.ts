import type { GatewayState } from '../wa/gateway.ts';

/**
 * The health line while something is not set up, or null. It ranks above every other line: nothing else can work yet.
 * The texts point to the dashboard, which is on whenever setup mode can happen.
 */
export function setupLine(wa: GatewayState, googleConnected: boolean): { ok: false; text: string } | null {
  if (wa === 'not_linked') return { ok: false, text: "❌ WhatsApp is not linked. Open the dashboard → Connections and link the founder's phone." };
  if (wa === 'linking') return { ok: false, text: "⏳ WhatsApp is being linked from the dashboard. Reading resumes once the founder's phone has scanned the code." };
  if (!googleConnected) return { ok: false, text: '❌ Google is not connected. Open the dashboard → Connections and connect Google.' };
  return null;
}
