// Screens that are not built yet: a calm panel instead of an empty page.
import { esc, icon } from '../dom.js';

/**
 * A customer's screen before their workspace is running (503 workspace_starting): a calm note, never an error. The
 * shell opens the screen again by itself.
 * @param {{ label: string, icon: string }} screen
 */
export function renderStarting(screen) {
  return `<section class="card soon starting"><div><div class="ic">${icon(screen.icon, 28)}</div>
    <h2>Your workspace is starting</h2><p>${esc(screen.label)} opens here in a moment, as soon as your workspace is up. No need to reload.</p></div></section>`;
}

/** @param {{ label: string, icon: string }} screen */
export function renderPlaceholder(screen) {
  return `<section class="card soon"><div><div class="ic">${icon(screen.icon, 28)}</div>
    <h2>${esc(screen.label)}</h2><p>Coming in the next update. The agent keeps working in the meantime; this screen will show it here.</p></div></section>`;
}
