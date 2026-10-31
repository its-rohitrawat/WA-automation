import { FOUNDER_TENANT_ID } from './env.ts';

// The one rule for a customer's id wherever it names a folder or a scope (isolation review F6, 30 Oct): an RFC 4122 UUID
// (versions 1 to 8) that is not the founder's. The founder's own data stays under DATA_DIR itself, never under
// DATA_DIR/tenants, so a folder named after the founder's id there is refused like any other stranger.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a customer's id: a lower-case UUID, never the founder's. */
export function isCustomerId(id: string): boolean {
  return UUID.test(id) && id !== FOUNDER_TENANT_ID;
}
