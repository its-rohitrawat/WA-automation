// Screens drawn by other modules plug in here: a screen module adds a mount function under its screen name, and the
// shell calls it whenever that screen is shown. Screens not in the map show the "Coming in the next update" panel.

/**
 * What the shell gives a screen when it is shown.
 * - view: the element to draw into. Every value from the agent goes in through esc() or textContent.
 * - sub: the sub-screen (for example 'groups' for /dashboard/clients/groups), else null.
 * - live(): false once the owner has left this visit of the screen; check it before drawing after any await.
 * - status(): the latest agent status (readStatus shape), or null before the first answer.
 * - onStatus(fn): fn runs after each status refresh, while this visit lasts.
 * - poll(fn, ms): runs fn now and every ms while the tab is visible; stopped by the shell when the screen changes.
 * - redraw(html): replaces the view's markup and keeps keyboard focus on the same control.
 * - go(screen, sub): moves to another screen (a new history entry).
 * @typedef {{
 *   view: HTMLElement,
 *   sub: string | null,
 *   live: () => boolean,
 *   status: () => ReturnType<typeof import('../contract.js').readStatus> | null,
 *   onStatus: (fn: () => void) => void,
 *   poll: (fn: () => unknown, ms: number) => void,
 *   redraw: (html: string) => void,
 *   go: (screen: string, sub: string | null) => void,
 * }} ScreenCtx
 */

/**
 * Screen name to mount function. A mount may return a cleanup function, which runs when the owner leaves the screen.
 * @type {Map<string, (ctx: ScreenCtx) => (void | (() => void))>}
 */
export const SCREEN_MOUNTS = new Map();
