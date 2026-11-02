// Open chat (owner request, 29 Oct 2026): a client's WhatsApp group as the agent stored it, in a phone-like sheet over
// the Clients screen. Bubbles with day separators, names and times; photos, files and voice notes as tags (with the
// transcript when there is one); older messages as you scroll up; new ones with the Clients screen's poll.
// Sending is text only, and only after the confirm dialog showed the exact text and the group: the agent sends it from
// the founder's WhatsApp, once (the uuid made here makes a repeated request find the first one). Every text from the
// agent is shown through esc(): group messages are untrusted.
import { ApiError, get, post } from '../api.js';
import { readChat, readMembers, readSendResult } from '../contract.js';
import { $, esc, icon, toast } from '../dom.js';
import { clock } from '../format.js';
import { closeDrawer, openChatLayer, openDrawerElement } from './drawer.js';
import { confirmDialog } from './ui.js';

const PAGE = 50;
const TEXT_MAX = 4096;
/** Near the end of the list: new messages keep it scrolled to the end. */
const STICK_PX = 80;
const IST = 'Asia/Kolkata';
/** A computer: a mouse or trackpad that can hover. */
const desk = matchMedia('(hover: hover) and (pointer: fine)');

/** @typedef {ReturnType<typeof readChat>} ChatData */
/** @typedef {ChatData['messages'][number]} Msg */
/**
 * A dashboard message. Sent from here: `shown` is the text as typed ("@Name") and `picks` its tags, to put back in the box
 * when the agent refuses it.
 * @typedef {ChatData['outbox'][number] & { local?: 'inflight' | 'lost', reason?: string, shown?: string, picks?: [string, string][] }} Out
 */

/** @typedef {ReturnType<typeof readMembers>['members'][number]} Member */

/**
 * The open chat, or null. Tagging (November release): `names` are the agent's names for the tags on the pages shown;
 * `members` the group's members (read when the picker or the group info first needs them) and `labels` the name each
 * shows as in the composer ("@Label"); `picks` the members tagged in the draft, by label.
 * @type {{ code: string, el: HTMLElement, messages: Map<number, Msg>, outbox: Map<string, Out>, hasOlder: boolean,
 *   loadingOlder: boolean, sendingOn: boolean, connected: boolean, groupName: string, clientName: string, replyTo: Msg | null,
 *   draft: string, armed: boolean, onBack: () => void, names: Record<string, string>, members: Member[] | null,
 *   reading: Promise<{ name: string, members: Member[] } | { name: string, note: string }> | null,
 *   failed: { note: string, at: number } | null, labels: Map<string, string>, picks: Map<string, string>,
 *   picker: { start: number, query: string, active: number } | null } | null}
 */
let chat = null;

const KIND_LABEL = /** @type {Record<string, string>} */ ({
  image: 'Photo', video: 'Video', document: 'File', sticker: 'Sticker', audio: 'Audio file', voice: 'Voice note', location: 'Location',
  contact: 'Contact', poll: 'Poll', event: 'Event', other: 'Message',
});
const KIND_ICON = /** @type {Record<string, string>} */ ({ image: 'eye', video: 'video', document: 'doc', sticker: 'spark', audio: 'mic', voice: 'mic' });

/** The India date of a time, "YYYY-MM-DD". @param {string | null} iso */
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: IST }) : '');

/** "Today", "Yesterday", or "Mon 26 Oct" (with the year when it is not this year). @param {string} d YYYY-MM-DD */
function dayLabel(d) {
  const today = day(new Date().toISOString());
  const yesterday = day(new Date(Date.now() - 86_400_000).toISOString());
  if (d === today) return 'Today';
  if (d === yesterday) return 'Yesterday';
  const at = new Date(`${d}T12:00:00+05:30`);
  return at.toLocaleDateString('en-GB', { timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', ...(d.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) });
}

/** One of 8 name colours, the same for a name every time. @param {string} name */
function tone(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `n${h % 8}`;
}

/** "0:42". @param {number} s */
const duration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** A photo, file or voice note as a tag. @param {string} kind @param {number | null} seconds */
function kindTag(kind, seconds) {
  if (kind === 'text') return '';
  const label = KIND_LABEL[kind] ?? 'Message';
  return `<span class="ch-tag">${icon(KIND_ICON[kind] ?? 'file', 14)}${esc(seconds !== null ? `${label} · ${duration(seconds)}` : label)}</span>`;
}

/** @param {{ sender: string, text: string, kind: string } | null} q */
function quoteBlock(q) {
  if (!q) return '';
  const text = q.text || (q.kind !== 'text' ? KIND_LABEL[q.kind] ?? 'Message' : '');
  return `<div class="ch-quote"><b class="${tone(q.sender)}">${esc(q.sender)}</b><span>${esc(text)}</span></div>`;
}

/** A tag in a message's text, as the agent finds it (src/wa/groupMembers.ts mentionTags). */
const TAG = /(?<![\p{L}\p{N}_])@(\d{5,20})(?!\d)/gu;

/**
 * A message's text, its tags ("@<digits>") highlighted: as "@Name" when the agent knows the member, else as the text has
 * it (the bubble adds no number). Every piece goes through esc(). @param {string} text
 */
function richText(text) {
  const names = chat?.names ?? {};
  let out = '';
  let last = 0;
  for (const m of text.matchAll(TAG)) {
    const at = m.index ?? 0;
    const tag = m[1] ?? '';
    out += `${esc(text.slice(last, at))}<span class="ch-at">@${esc(Object.hasOwn(names, tag) ? names[tag] : tag)}</span>`;
    last = at + m[0].length;
  }
  return out + esc(text.slice(last));
}

/** A stored message. `showName`: the first of a run by one sender (in a group, names show on others' messages only). @param {Msg} m @param {boolean} showName */
function bubble(m, showName) {
  if (m.deleted) {
    return `<div class="ch-row ${m.mine ? 'out' : 'in'}"><div class="ch-bub ch-gone">${icon('close', 13)}<i>This message was deleted</i><span class="ch-meta">${esc(clock(m.at))}</span></div></div>`;
  }
  const name = !m.mine && showName ? `<b class="ch-name ${tone(m.sender)}">${esc(m.sender)}</b>` : '';
  const transcript = m.transcript ? `<p class="ch-tr">${esc(m.transcript)}</p>` : '';
  const text = m.text ? `<p>${richText(m.text)}</p>` : '';
  const replyBtn = chat?.sendingOn ? `<button class="ch-reply" type="button" data-reply="${m.id}" aria-label="Reply to ${esc(m.sender)}">${icon('undo', 14)}</button>` : '';
  return `<div class="ch-row ${m.mine ? 'out' : 'in'}" data-msg="${m.id}"><div class="ch-bub">${name}${quoteBlock(m.quote)}${kindTag(m.kind, m.seconds)}${transcript}${text}
    <span class="ch-meta">${m.edited ? 'edited · ' : ''}${esc(clock(m.at))}</span></div>${replyBtn}</div>`;
}

/** What a dashboard message's state says, in words and an icon. @param {Out} o */
function outState(o) {
  if (o.local === 'lost' || o.state === 'unknown') return { cls: 'warn', ic: 'alert', words: 'Not sure it was sent, check WhatsApp' };
  if (o.state === 'failed') return { cls: 'bad', ic: 'alert', words: o.reason ? `Not sent: ${o.reason}` : 'Not sent' };
  if (o.state === 'sent') return { cls: 'ok', ic: 'tick', words: 'Sent' };
  return { cls: 'wait', ic: 'clock', words: 'Sending…' };
}

/** A message sent (or being sent) from here that the chat shows on its own. @param {Out} o */
function outBubble(o) {
  const s = outState(o);
  return `<div class="ch-row out ch-own ${s.cls}" data-out="${esc(o.uuid)}"><div class="ch-bub">${quoteBlock(o.quote)}<p>${richText(o.text)}</p>
    <span class="ch-meta">${esc(clock(o.at))} <span class="ch-state">${icon(s.ic, 13)}${esc(s.words)}</span></span></div></div>`;
}

/** The messages in time order with day separators, then the dashboard's own ones still to show. */
function listHtml() {
  if (!chat) return '';
  const msgs = [...chat.messages.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id - b.id);
  let lastDay = '';
  let lastSender = '';
  const parts = [];
  for (const m of msgs) {
    const d = day(m.at);
    if (d !== lastDay) {
      parts.push(`<div class="ch-day" role="separator"><span>${esc(dayLabel(d))}</span></div>`);
      lastDay = d;
      lastSender = '';
    }
    const who = m.mine ? '' : m.sender;
    parts.push(bubble(m, who !== lastSender));
    lastSender = who;
  }
  const own = [...chat.outbox.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  if (own.length) {
    const d = day(own[0]?.at ?? null);
    if (d !== lastDay) parts.push(`<div class="ch-day" role="separator"><span>${esc(dayLabel(d))}</span></div>`);
    for (const o of own) parts.push(outBubble(o));
  }
  if (parts.length === 0) parts.push('<p class="ch-empty">No messages stored for this group yet.</p>');
  return parts.join('');
}

/** The composer, or why there is none. */
function footHtml() {
  if (!chat) return '';
  if (!chat.sendingOn) {
    return `<div class="ch-off">${icon('lock', 16)}<span>Sending is off. Turn on <b>Allow sending from the dashboard</b> in Settings to reply from here.</span>
      <button class="btn btn-ghost btn-sm" type="button" data-go="settings">Settings</button></div>`;
  }
  if (!chat.connected) return `<div class="ch-off">${icon('wifi', 16)}<span>WhatsApp isn't connected, so nothing can be sent right now.</span></div>`;
  const r = chat.replyTo;
  const reply = r
    ? `<div class="ch-replying"><div class="grow-1">${quoteBlock({ sender: r.sender, text: r.text, kind: r.kind })}</div>
        <button class="icon-btn" type="button" data-reply-cancel aria-label="Cancel the reply">${icon('close', 15)}</button></div>`
    : '';
  return `${reply}<div class="ch-pick" id="ch-pick" role="listbox" aria-label="Tag a member" hidden></div>
    <form class="ch-compose" data-compose><label class="sr-only" for="ch-text">Message to ${esc(chat.groupName)}. Type @ to tag a member.</label>
    <textarea id="ch-text" rows="1" maxlength="${TEXT_MAX}" placeholder="Message" autocomplete="off" aria-autocomplete="list" aria-controls="ch-pick">${esc(chat.draft)}</textarea>
    <button class="ch-send" type="submit" aria-label="Send">${icon('arrowR', 20)}</button></form>
    <p class="ch-note">Sent from the founder's WhatsApp to everyone in the group, after you confirm.</p>`;
}

/** Redraws the list (keeping the place, or the end when it was at the end) and, when asked, the foot. @param {{ foot?: boolean, toEnd?: boolean }} [o] */
function draw(o = {}) {
  if (!chat) return;
  const body = /** @type {HTMLElement} */ ($('.ch-body', chat.el));
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < STICK_PX;
  const fromEnd = body.scrollHeight - body.scrollTop;
  $('.ch-list', chat.el).innerHTML = listHtml();
  $('.ch-older', chat.el).hidden = !chat.hasOlder;
  // The foot first: its height changes the list's, and the list's place is set after.
  if (o.foot) {
    const typing = document.activeElement?.id === 'ch-text';
    chat.picker = null; // a new box: no picker open in it
    $('.ch-foot', chat.el).innerHTML = footHtml();
    grow();
    if (typing) /** @type {HTMLElement | null} */ (chat.el.querySelector('#ch-text'))?.focus({ preventScroll: true });
  }
  if (o.toEnd || atEnd) body.scrollTop = body.scrollHeight;
  else body.scrollTop = body.scrollHeight - fromEnd;
}

/** The text box grows with its lines, up to a few. */
function grow() {
  const t = /** @type {HTMLTextAreaElement | null} */ (chat?.el.querySelector('#ch-text') ?? null);
  if (!t) return;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}

/** Takes the agent's page into the chat. The dashboard's own messages are the agent's list, plus the ones still in flight here. @param {ChatData} d @param {boolean} newest */
function take(d, newest) {
  if (!chat) return;
  for (const m of d.messages) chat.messages.set(m.id, m);
  Object.assign(chat.names, d.names);
  if (!newest) {
    chat.hasOlder = d.hasOlder;
    return;
  }
  if (chat.messages.size <= d.messages.length) chat.hasOlder = d.hasOlder;
  const footChanged = chat.sendingOn !== d.sendingOn || chat.connected !== d.connected;
  chat.sendingOn = d.sendingOn;
  chat.connected = d.connected;
  chat.groupName = d.client.groupName;
  const next = new Map(d.outbox.map((x) => [x.uuid, /** @type {Out} */ (x)]));
  for (const [uuid, o] of chat.outbox) if (o.local && !next.has(uuid)) next.set(uuid, o);
  chat.outbox = next;
  return footChanged;
}

/** Loads the newest page (on open and with the poll). */
async function loadNewest(first = false) {
  const c = chat;
  if (!c) return;
  try {
    const d = readChat(await get(`/clients/${encodeURIComponent(c.code)}/chat?limit=${PAGE}`));
    if (chat !== c) return;
    const footChanged = take(d, true);
    draw({ foot: first || footChanged, toEnd: first });
    if (first) {
      $('.ch-who', c.el).textContent = c.groupName;
      // Only now, at the end of the list: scrolling up near the top loads the page before.
      c.armed = true;
    }
  } catch (e) {
    if (chat !== c) return;
    if (first) $('.ch-list', c.el).innerHTML = `<p class="ch-empty">${esc(e instanceof ApiError ? e.message : 'The chat could not be loaded.')}</p>`;
  }
}

/** Loads the page before the oldest message shown. */
async function loadOlder() {
  const c = chat;
  if (!c || c.loadingOlder || !c.hasOlder) return;
  const oldest = [...c.messages.values()].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id - b.id)[0];
  if (!oldest) return;
  c.loadingOlder = true;
  $('.ch-older', c.el).textContent = 'Loading older messages…';
  try {
    const d = readChat(await get(`/clients/${encodeURIComponent(c.code)}/chat?limit=${PAGE}&before=${oldest.id}`));
    if (chat !== c) return;
    take(d, false);
    draw();
  } catch {
    toast('Older messages could not be loaded.', false);
  } finally {
    c.loadingOlder = false;
    if (chat === c) $('.ch-older', c.el).textContent = 'Load older messages';
  }
}

/** Asks, then sends. The text and the reply stay in the box until the owner confirms. */
async function send() {
  const c = chat;
  if (!c) return;
  const box = /** @type {HTMLTextAreaElement | null} */ (c.el.querySelector('#ch-text'));
  const shown = box?.value ?? '';
  if (!shown.trim()) return;
  hidePicker(c);
  // The confirm shows the message as the members read it ("@Name"); WhatsApp gets its own form ("@<digits>").
  const { text, tagged } = toWhatsApp(shown, c.picks);
  if (text.length > TEXT_MAX) return toast(`A message can be at most ${TEXT_MAX} characters.`, false);
  const yes = await confirmDialog({
    eyebrow: 'Send from WhatsApp',
    title: `Send this from your WhatsApp to ${c.groupName}?`,
    text: `Everyone in the group sees it, from the founder’s number.${tagged.length ? ` It tags ${tagged.join(', ')} on their phones.` : ''} It cannot be taken back from here.`,
    quote: shown,
    yes: 'Send',
  });
  if (!yes || chat !== c) return;
  const uuid = crypto.randomUUID();
  const r = c.replyTo;
  /** @type {Out} */
  const out = {
    uuid, at: new Date().toISOString(), text, state: 'sending', quote: r ? { sender: r.sender, text: r.text, kind: r.kind } : null, local: 'inflight',
    shown, picks: [...c.picks],
  };
  c.outbox.set(uuid, out);
  c.replyTo = null;
  c.draft = '';
  c.picks = new Map();
  draw({ foot: true, toEnd: true });
  await deliver(c, out, r ? r.id : null, 0);
}

/**
 * Posts one confirmed message. A refusal (nothing was sent) puts the text back in the box. No answer at all: the same
 * uuid is asked again, which can only find the first request, never send twice; still nothing: "not sure".
 * @param {NonNullable<typeof chat>} c @param {Out} out @param {number | null} replyTo @param {number} tries
 */
async function deliver(c, out, replyTo, tries) {
  try {
    const r = readSendResult(await post(`/clients/${encodeURIComponent(c.code)}/chat/send`, { uuid: out.uuid, text: out.text, replyTo, confirm: true }));
    if (chat !== c) return;
    c.outbox.set(out.uuid, r.message);
    if (r.message.state === 'failed') toast('The message was not sent: WhatsApp isn’t connected.', false);
    if (r.message.state === 'unknown') toast('Not sure the message was sent. Check WhatsApp before sending it again.', false);
  } catch (e) {
    if (chat !== c) return;
    if (e instanceof ApiError) {
      c.outbox.delete(out.uuid);
      // Back in the box as it was typed, with its tags.
      if (!c.draft) {
        c.draft = out.shown ?? out.text;
        c.picks = new Map(out.picks ?? []);
      }
      toast(e.message, false);
      draw({ foot: true });
      return;
    }
    if (tries < 2) {
      setTimeout(() => void deliver(c, out, replyTo, tries + 1), 2000);
      return;
    }
    c.outbox.set(out.uuid, { ...out, local: 'lost' });
  }
  draw();
}

/** Closes the chat (the layer's own close). */
function forget() {
  chat = null;
}

/** Tagging is possible: sending is on and WhatsApp is connected (the composer is shown). */
const canTag = () => Boolean(chat?.sendingOn && chat.connected);

/**
 * The group info panel's body: the group, then a note (loading, or why the members can't be shown) or the members. A
 * member is its name, else the number WhatsApp shows, else "Number hidden"; names are untrusted (esc). While sending is
 * possible, tapping a member puts "@Name" in the message.
 * @param {string} groupName @param {{ note: string } | { members: Member[] }} s
 */
function infoBody(groupName, s) {
  const top = `<div class="ch-info-top"><span class="ch-info-av" aria-hidden="true">${icon('users', 34)}</span><h3>${esc(groupName)}</h3>`;
  if ('note' in s) return `${top}<p class="ch-info-count">${esc(s.note)}</p></div>`;
  const n = s.members.length;
  const tag = canTag();
  const rows = s.members
    .map((m) => {
      const title = m.name ?? m.number ?? 'Number hidden';
      const sub = m.name ? m.number ?? 'Number hidden' : m.number ? '' : 'WhatsApp hides this member’s number';
      const inner = `<span class="ch-mem-av" aria-hidden="true">${icon('user', 18)}</span><span class="grow-1 ch-mem-text"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>${m.admin ? '<span class="ch-admin">Group admin</span>' : ''}`;
      return tag
        ? `<li><button class="ch-mem ch-mem-btn" type="button" data-tag="${esc(m.tag)}" aria-label="Tag ${esc(title)} in your message">${inner}</button></li>`
        : `<li class="ch-mem">${inner}</li>`;
    })
    .join('');
  const hint = tag && n ? ' · Tap a member to tag them' : '';
  return `${top}<p class="ch-info-count">Group · ${n} member${n === 1 ? '' : 's'}${hint}</p></div><ul class="ch-mems" aria-label="Members">${rows}</ul>`;
}

/** How long a failed read of the members is remembered before the picker asks again (the agent asks WhatsApp each time). */
const RETRY_MS = 30_000;

/**
 * Reads the group's members (the agent keeps them 5 minutes); read, they are kept for this chat's tagging. One read at a
 * time: a second ask waits for it.
 * @param {NonNullable<typeof chat>} c @returns {Promise<{ name: string, members: Member[] } | { name: string, note: string }>}
 */
function fetchMembers(c) {
  c.reading ??= (async () => {
    /** @type {{ name: string, members: Member[] } | { name: string, note: string }} */
    let r;
    try {
      const d = readMembers(await get(`/clients/${encodeURIComponent(c.code)}/chat/members`));
      const name = d.groupName || c.groupName;
      r = d.known
        ? { name, members: d.members }
        : { name, note: d.reason === 'whatsapp_not_connected' ? 'WhatsApp is not connected, so the members can’t be shown now.' : 'The members could not be read from WhatsApp just now. Try again in a minute.' };
    } catch (e) {
      r = { name: c.groupName, note: e instanceof ApiError ? e.message : 'The members could not be loaded.' };
    }
    c.reading = null;
    if ('members' in r) {
      setMembers(c, r.members);
      c.failed = null;
    } else c.failed = { note: r.note, at: Date.now() };
    return r;
  })();
  return c.reading;
}

/**
 * Keeps the members, each with the label it shows as in the composer: its name, else its number, else "Member" and the
 * last 4 digits of its tag. A label two members share gets those 4 digits too, so a tag is never ambiguous.
 * @param {NonNullable<typeof chat>} c @param {Member[]} members
 */
function setMembers(c, members) {
  const base = (/** @type {Member} */ m) => m.name ?? m.number ?? `Member ${m.tag.slice(-4)}`;
  /** @type {Map<string, number>} */
  const count = new Map();
  for (const m of members) count.set(base(m), (count.get(base(m)) ?? 0) + 1);
  c.members = members;
  c.labels = new Map(members.map((m) => [m.tag, (count.get(base(m)) ?? 0) > 1 ? `${base(m)} ${m.tag.slice(-4)}` : base(m)]));
}

/** Opens the group info panel over the chat and reads the members. */
async function openInfo() {
  const c = chat;
  if (!c) return;
  hidePicker(c);
  const panel = /** @type {HTMLElement} */ ($('.ch-info', c.el));
  panel.innerHTML = `<div class="ch-info-head"><button class="icon-btn" type="button" data-info-back aria-label="Back to the chat">${icon('arrowL', 18)}</button><b>Group info</b></div>
    <div class="ch-info-body">${infoBody(c.groupName, { note: 'Loading the members…' })}</div>`;
  panel.hidden = false;
  /** @type {HTMLElement | null} */ (panel.querySelector('[data-info-back]'))?.focus();
  const r = await fetchMembers(c);
  if (chat !== c || panel.hidden) return;
  const body = panel.querySelector('.ch-info-body');
  if (body) body.innerHTML = infoBody(r.name, 'note' in r ? { note: r.note } : { members: r.members });
}

/** The "@word" being typed right before the caret, or null. @param {HTMLTextAreaElement} t */
function typedTag(t) {
  const caret = t.selectionStart ?? t.value.length;
  const m = /(?:^|\s)@([^\s@]{0,30})$/u.exec(t.value.slice(0, caret));
  if (!m) return null;
  const query = m[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** The members the picker offers for what was typed after "@": by name or number, at most 8. @param {NonNullable<typeof chat>} c @param {string} q */
function matching(c, q) {
  const s = q.toLowerCase();
  const digits = q.replace(/\D/g, '');
  return (c.members ?? [])
    .filter((m) => !s || (c.labels.get(m.tag) ?? '').toLowerCase().includes(s) || (digits !== '' && (m.number ?? '').replace(/\D/g, '').includes(digits)))
    .slice(0, 8);
}

/** Hides the member picker. @param {NonNullable<typeof chat>} c */
function hidePicker(c) {
  c.picker = null;
  const box = c.el.querySelector('#ch-pick');
  if (box instanceof HTMLElement) {
    box.hidden = true;
    box.innerHTML = '';
  }
  c.el.querySelector('#ch-text')?.removeAttribute('aria-activedescendant');
}

/** Shows the member picker for the "@word" being typed, as in WhatsApp; hides it otherwise. */
async function updatePicker() {
  const c = chat;
  if (!c) return;
  const t = c.el.querySelector('#ch-text');
  const box = c.el.querySelector('#ch-pick');
  if (!(t instanceof HTMLTextAreaElement) || !(box instanceof HTMLElement)) return;
  const typed = typedTag(t);
  if (!typed) return hidePicker(c);
  c.picker = { start: typed.start, query: typed.query, active: c.picker && c.picker.query === typed.query ? c.picker.active : 0 };
  if (!c.members) {
    box.hidden = false;
    // A read that failed a moment ago is not asked again yet.
    if (c.failed && Date.now() - c.failed.at < RETRY_MS) {
      box.innerHTML = `<p class="ch-pick-note">${esc(c.failed.note)}</p>`;
      return;
    }
    box.innerHTML = '<p class="ch-pick-note">Loading the members…</p>';
    const r = await fetchMembers(c);
    if (chat !== c || !c.picker) return;
    if (!c.members) {
      box.innerHTML = `<p class="ch-pick-note">${esc('note' in r ? r.note : '')}</p>`;
      return;
    }
    return updatePicker();
  }
  const list = matching(c, typed.query);
  if (list.length === 0) return hidePicker(c);
  const p = c.picker;
  p.active = Math.min(p.active, list.length - 1);
  box.hidden = false;
  box.innerHTML = list
    .map((m, i) => {
      const sub = m.name ? m.number ?? 'Number hidden' : '';
      return `<button type="button" class="ch-pick-item${i === p.active ? ' on' : ''}" role="option" id="ch-pick-${i}" aria-selected="${i === p.active}" data-pick="${esc(m.tag)}" tabindex="-1"><span class="ch-mem-av" aria-hidden="true">${icon('user', 16)}</span><span class="ch-mem-text"><b>${esc(c.labels.get(m.tag) ?? '')}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span></button>`;
    })
    .join('');
  t.setAttribute('aria-activedescendant', `ch-pick-${p.active}`);
}

/**
 * Puts "@Label " in the message: in place of the "@word" being typed, or at the end (from the group info panel). The tag
 * is kept by its label until the message is sent.
 * @param {NonNullable<typeof chat>} c @param {string} tag
 */
function insertTag(c, tag) {
  const t = c.el.querySelector('#ch-text');
  const label = c.labels.get(tag);
  const m = c.members?.find((x) => x.tag === tag);
  if (!(t instanceof HTMLTextAreaElement) || !label || !m) return;
  const caret = c.picker ? t.selectionStart ?? t.value.length : t.value.length;
  const start = c.picker ? c.picker.start : caret;
  const before = t.value.slice(0, start);
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const token = `${lead}@${label} `;
  t.value = before + token + t.value.slice(caret);
  const at = (before + token).length;
  t.setSelectionRange(at, at);
  c.draft = t.value;
  c.picks.set(label, tag);
  // The bubble shows "@Name" for a named member only: never a number (the text keeps its own digits).
  if (m.name) c.names[tag] = m.name;
  hidePicker(c);
  grow();
  t.focus();
}

/**
 * The text as WhatsApp gets it: each tagged "@Label" as "@<digits>" (longest labels first, so one never eats another);
 * and who it tags, by label. A label the owner edited away is no tag.
 * @param {string} shown @param {Map<string, string>} picks
 */
function toWhatsApp(shown, picks) {
  let text = shown;
  /** @type {string[]} */
  const tagged = [];
  for (const [label, tag] of [...picks].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`@${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    const next = text.replace(re, `@${tag}`);
    if (next !== text) tagged.push(label);
    text = next;
  }
  return { text, tagged };
}

/** Back to the chat from the group info panel. */
function closeInfo() {
  const c = chat;
  if (!c) return;
  const panel = /** @type {HTMLElement} */ ($('.ch-info', c.el));
  panel.hidden = true;
  panel.innerHTML = '';
  /** @type {HTMLElement | null} */ (c.el.querySelector('.ch-who'))?.focus();
}

/**
 * Opens the chat of a client. `onBack` reopens what it came from (the client's panel).
 * @param {string} code @param {() => void} onBack
 */
export function openChat(code, onBack) {
  // The group's picture and name open its info, as in WhatsApp. The name is the sheet's title (the h2), as a button.
  const el = openChatLayer(`<div class="ch-head"><button class="icon-btn" type="button" data-chat-back aria-label="Back to the client">${icon('arrowL', 18)}</button>
      <span class="ch-av" data-chat-info aria-hidden="true">${icon('users', 18)}</span><div class="grow-1 ch-title"><h2><button class="ch-who" type="button" data-chat-info aria-haspopup="dialog">Loading…</button></h2><small>${esc(code)} · stored messages</small></div>
      <button class="icon-btn" type="button" data-close aria-label="Close the chat">${icon('close', 18)}</button></div>
    <div class="ch-body" tabindex="0" aria-label="Messages"><button class="ch-older link" type="button" hidden>Load older messages</button>
      <div class="ch-list" aria-live="polite"><p class="ch-empty">Loading the messages…</p></div></div>
    <div class="ch-foot"></div>
    <section class="ch-info" aria-label="Group info" hidden></section>`, { onClose: forget });
  chat = {
    code, el, messages: new Map(), outbox: new Map(), hasOlder: false, loadingOlder: false, sendingOn: false, connected: false,
    groupName: code, clientName: '', replyTo: null, draft: '', armed: false, onBack,
    names: {}, members: null, reading: null, failed: null, labels: new Map(), picks: new Map(), picker: null,
  };
  const body = /** @type {HTMLElement} */ ($('.ch-body', el));
  // Scrolling up near the top loads the page before; the button does the same for keyboards. Checked on scroll, and
  // after the owner's own wheel, touch or key moves too: a scroll event alone is not always sent.
  const nearTop = () => {
    if (chat?.el === el && chat.armed && body.scrollTop < 300) void loadOlder();
  };
  body.addEventListener('scroll', nearTop, { passive: true });
  for (const type of ['wheel', 'touchmove', 'keydown']) body.addEventListener(type, () => requestAnimationFrame(nearTop), { passive: true });
  el.addEventListener('click', (e) => {
    const t = /** @type {Element} */ (e.target);
    if (!chat) return;
    if (t.closest('[data-chat-back]')) {
      const back = chat.onBack;
      closeDrawer(true);
      back();
      return;
    }
    // Tagging: a member picked under the box, or tapped in the group info (the panel closes and the tag goes in).
    const pick = /** @type {HTMLElement | null} */ (t.closest('[data-pick]'));
    if (pick) return insertTag(chat, pick.dataset.pick ?? '');
    const member = /** @type {HTMLElement | null} */ (t.closest('[data-tag]'));
    if (member) {
      const tag = member.dataset.tag ?? '';
      closeInfo();
      return insertTag(chat, tag);
    }
    if (t.id === 'ch-text') return void updatePicker(); // the caret moved
    if (t.closest('[data-chat-info]')) return void openInfo();
    if (t.closest('[data-info-back]')) return closeInfo();
    if (t.closest('.ch-older')) return void loadOlder();
    if (t.closest('[data-reply-cancel]')) {
      chat.replyTo = null;
      draw({ foot: true });
      /** @type {HTMLElement | null} */ (el.querySelector('#ch-text'))?.focus();
      return;
    }
    const reply = /** @type {HTMLElement | null} */ (t.closest('[data-reply]'));
    if (reply) {
      const m = chat.messages.get(Number(reply.dataset.reply));
      if (!m) return;
      chat.draft = /** @type {HTMLTextAreaElement | null} */ (el.querySelector('#ch-text'))?.value ?? chat.draft;
      chat.replyTo = m;
      draw({ foot: true });
      /** @type {HTMLElement | null} */ (el.querySelector('#ch-text'))?.focus();
      return;
    }
    // Settings is another screen: the chat closes on the way.
    if (t.closest('[data-go]')) closeDrawer(true);
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  el.addEventListener('input', (e) => {
    const t = /** @type {HTMLTextAreaElement} */ (e.target);
    if (t.id !== 'ch-text' || !chat) return;
    chat.draft = t.value;
    grow();
    void updatePicker();
  });
  // A member picked with the mouse keeps the box's focus and caret.
  el.addEventListener('mousedown', (e) => {
    if (/** @type {Element} */ (e.target).closest('[data-pick]')) e.preventDefault();
  });
  el.addEventListener('keyup', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t.id === 'ch-text' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) void updatePicker();
  });
  el.addEventListener('keydown', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    // The member picker, while it lists members: arrows move, Enter or Tab picks, Escape closes it (not the chat).
    const p = chat?.picker;
    const items = el.querySelectorAll('#ch-pick [data-pick]');
    if (chat && p && t.id === 'ch-text' && items.length > 0 && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !e.isComposing) {
      e.preventDefault();
      if (e.key === 'Escape') {
        e.stopPropagation();
        return hidePicker(chat);
      }
      if (e.key === 'Enter' || e.key === 'Tab') return insertTag(chat, /** @type {HTMLElement} */ (items[p.active] ?? items[0]).dataset.pick ?? '');
      p.active = (p.active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      return void updatePicker();
    }
    // With a keyboard and mouse, Enter sends (after the confirm) and Shift+Enter is a new line; on a phone, Enter is a
    // new line and the Send button sends, as in WhatsApp.
    if (t.id === 'ch-text' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && desk.matches) {
      e.preventDefault();
      void send();
    }
    // Escape in the group info goes back to the chat; the layer's own Escape (closing the chat) is not reached.
    if (e.key === 'Escape' && !(/** @type {HTMLElement} */ ($('.ch-info', el))).hidden) {
      e.stopPropagation();
      closeInfo();
    }
  });
  void loadNewest(true);
  return el;
}

/** The Clients screen's poll: the newest messages and the states of the ones sent from here, while the chat is open. */
export async function refreshChat() {
  if (!chat || openDrawerElement() !== chat.el) return;
  await loadNewest();
}

/** Whether the chat is open (the Clients screen's poll asks). */
export const chatOpen = () => chat !== null && openDrawerElement() === chat.el;
