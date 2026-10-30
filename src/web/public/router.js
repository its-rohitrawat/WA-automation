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

/**
 * The sidebar for this session: NAV, with the platform screens when `platform` is true.
 * @param {boolean} platform
 * @returns {[string, [string, string, string][]][]}
 */
export function navFor(platform) {
  return platform ? NAV.map(([group, items]) => [group, group === 'System' ? [...PLATFORM_NAV, ...items] : items]) : NAV;
}

/** @type {Map<string, { group: string, label: string, icon: string }>} */
export const SCREENS = new Map(NAV.flatMap(([group, items]) => items.map(([id, label, ic]) => [id, { group, label, icon: ic }])));

/**
 * Adds the platform screens to SCREENS (and so to parsePath), or takes them out. Called once the session is known.
 * @param {boolean} on
 */
export function showPlatform(on) {
  for (const [id, label, ic] of PLATFORM_NAV) {
    if (on) SCREENS.set(id, { group: 'System', label, icon: ic });
    else SCREENS.delete(id);
  }
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
