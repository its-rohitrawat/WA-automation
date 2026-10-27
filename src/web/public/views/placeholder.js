// Screens that are not built yet: a calm panel instead of an empty page.
import { esc, icon } from '../dom.js';

/** @param {{ label: string, icon: string }} screen */
export function renderPlaceholder(screen) {
  return `<section class="card soon"><div><div class="ic">${icon(screen.icon, 28)}</div>
    <h2>${esc(screen.label)}</h2><p>Coming in the next update. The agent keeps working in the meantime; this screen will show it here.</p></div></section>`;
}
