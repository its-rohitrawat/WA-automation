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

/** @type {Map<string, { group: string, label: string, icon: string }>} */
export const SCREENS = new Map(NAV.flatMap(([group, items]) => items.map(([id, label, ic]) => [id, { group, label, icon: ic }])));

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
 * Goes to a screen: a new history entry unless `replace`. @param {string} screen @param {string | null} sub
 * @param {{ replace?: boolean }} [opts]
 */
export function navigate(screen, sub, opts = {}) {
  const path = pathFor(screen, sub);
  if (location.pathname === path) return;
  if (opts.replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
}

/** Calls fn with the screen on the browser's back and forward buttons. @param {(r: { screen: string, sub: string | null }) => void} fn */
export function onPopState(fn) {
  addEventListener('popstate', () => fn(parsePath(location.pathname)));
}
