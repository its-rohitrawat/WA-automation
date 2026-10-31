// Real addresses for the dashboard's screens: /dashboard/<screen> (and /dashboard/clients/groups). pushState on
// navigation, popstate for the browser's back button.

/**
 * The sidebar: [group, [[screen, label, icon]]].
 * @type {[string, [string, string, string][]][]}
 */
export const NAV = ([
  ['Workspace', [['overview', 'Overview', 'dash'], ['clients', 'Clients', 'users'], ['tasks', 'Tasks', 'task'], ['meetings', 'Meetings', 'video'], ['activity', 'Activity', 'act'], ['tracker', 'Tracker', 'xls']]],
  ['System', [['connections', 'Connections', 'plug'], ['usage', 'AI usage', 'ai'], ['automations', 'Automations', 'flow'], ['audit', 'Audit logs', 'audit'], ['settings', 'Settings', 'settings']]],
]);

/**
 * The founder's platform screens (SaaS S5), at the start of System. Only when the server says the platform is on (GET
 * /dashboard/api/me's `platform`, true only when the platform routes are mounted): otherwise neither the entries nor
 * their addresses exist, so nothing opens a screen whose API is not there.
 * @type {[string, string, string][]}
 */
export const PLATFORM_NAV = [['customers', 'Customers', 'store'], ['invite', 'Invite a customer', 'mail']];

/** A customer's first Workspace entry (SaaS S5, hookup 5.1). Never the founder's. @type {[string, string, string]} */
export const ONBOARDING_NAV = ['onboarding', 'Getting started', 'flash'];

/** A member's switch between its workspaces, at the start of System: only with 2 or more. @type {[string, string, string]} */
export const WORKSPACES_NAV = ['workspaces', 'Switch workspace', 'brief'];

/** The founder's own screens a customer never sees (plan S4.8 step 4); Customers and Invite are the founder's too. */
const FOUNDER_ONLY = new Set(['connections', 'usage']);

/** A customer's screens that stay locked until their workspace is active (plan S4.8 step 4). */
export const LOCKED_UNTIL_ACTIVE = new Set(['clients', 'tasks', 'meetings', 'tracker']);

/**
 * Who is signed in, as GET /dashboard/api/me says: `role` 'owner' is a customer's owner; anything else is the founder
 * (on SQLite every session is the founder's). `platform`: the platform routes are mounted. `workspaces`: how many
 * workspaces a customer's member can switch between.
 * @typedef {{ role?: string, platform?: boolean, workspaces?: number }} Session
 */

/**
 * The sidebar for this session. The founder: NAV, with Customers and Invite when the platform is on. A customer:
 * Getting started first, then their Workspace, and System without the founder's own screens (with Switch workspace
 * first for a member of several).
 * @param {Session} s
 * @returns {[string, [string, string, string][]][]}
 */
export function navFor(s) {
  if (s.role === 'owner') {
    const system = (/** @type {[string, string, string][]} */ items) => {
      const own = items.filter(([id]) => !FOUNDER_ONLY.has(id));
      return (s.workspaces ?? 1) > 1 ? [WORKSPACES_NAV, ...own] : own;
    };
    return NAV.map(([group, items]) => [group, group === 'Workspace' ? [ONBOARDING_NAV, ...items] : system(items)]);
  }
  return s.platform ? NAV.map(([group, items]) => [group, group === 'System' ? [...PLATFORM_NAV, ...items] : items]) : NAV;
}

/** @type {Map<string, { group: string, label: string, icon: string }>} */
export const SCREENS = new Map(NAV.flatMap(([group, items]) => items.map(([id, label, ic]) => [id, { group, label, icon: ic }])));

/**
 * Makes SCREENS (and so parsePath) exactly this session's screens: an address of a screen it does not have opens the
 * overview. Called once the session is known.
 * @param {Session} s
 */
export function showScreens(s) {
  SCREENS.clear();
  for (const [group, items] of navFor(s)) for (const [id, label, ic] of items) SCREENS.set(id, { group, label, icon: ic });
}

/**
 * The screen (and optional sub-screen) an address asks for; overview for /dashboard and anything unknown.
 * @param {string} pathname
 * @returns {{ screen: string, sub: string | null }}
 */
export function parsePath(pathname) {
  const parts = pathname.replace(/^\/dashboard\/?/, '').split('/').filter(Boolean);
  const screen = parts[0] && SCREENS.has(parts[0]) ? parts[0] : 'overview';
  const sub = screen === 'clients' && parts[1] === 'groups' ? 'groups' : null;
  return { screen, sub };
}

/** @param {string} screen @param {string | null} [sub] */
export function pathFor(screen, sub = null) {
  if (screen === 'overview') return '/dashboard';
  return `/dashboard/${screen}${sub ? '/' + sub : ''}`;
}

/**
 * Goes to a screen: a new history entry unless `replace`. `query` ("?status=overdue") is added to the address; without
 * one, the same screen's address is left as it is (its own filters stay).
 * @param {string} screen @param {string | null} sub @param {{ replace?: boolean, query?: string }} [opts]
 */
export function navigate(screen, sub, opts = {}) {
  const path = pathFor(screen, sub);
  const url = path + (opts.query ?? '');
  if (opts.query ? location.pathname + location.search === url : location.pathname === path) return;
  if (opts.replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

/** Calls fn with the screen on the browser's back and forward buttons. @param {(r: { screen: string, sub: string | null }) => void} fn */
export function onPopState(fn) {
  addEventListener('popstate', () => fn(parsePath(location.pathname)));
}
