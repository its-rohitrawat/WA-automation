import { describe, expect, it } from 'vitest';
// Browser module; its JSDoc types are checked by tsconfig.web.json, so the import is untyped here.
// @ts-expect-error -- browser module (see above)
import { sendingCard } from '../../src/web/public/views/settings.js';

describe('Settings: Sending from the dashboard (November release, change 3)', () => {
  it('has no ban-risk warning note, and keeps the switch, its limits and the audit line', () => {
    for (const on of [true, false, null]) {
      const html: string = sendingCard(on);
      expect(html).not.toMatch(/ban risk/i);
      expect(html).not.toContain('warn-note');
      expect(html).toContain('id="send-card"');
      expect(html).toContain('role="switch"');
      expect(html).toContain('aria-label="Allow sending from the dashboard"');
      expect(html).toContain('One message every 3 seconds to a group, 30 an hour in all.');
      expect(html).toContain('Every change here and every message sent is in Audit logs, without the message text.');
    }
  });

  it('shows the state, and disables the switch while the agent did not say', () => {
    expect(sendingCard(true)).toContain('aria-checked="true"');
    expect(sendingCard(true)).toContain('>On</span>');
    expect(sendingCard(false)).toContain('aria-checked="false"');
    expect(sendingCard(false)).toContain('>Off</span>');
    expect(sendingCard(null)).toContain('data-send-switch disabled');
  });
});
