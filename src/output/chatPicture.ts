import sharp, { type OverlayOptions } from 'sharp';
import type { PictureMessage, PictureWindow } from '../control/chatQueries.ts';
import { oneLine } from '../control/clientQueries.ts';
import { formatDuration } from '../media/labels.ts';
import { istShortDate, istTime } from '../util/time.ts';

// A task's chat picture (owner request, 11 Nov 2026): a WhatsApp-style picture of its source message and the few around
// it, drawn with sharp, which the agent already has. Each bubble's words come from sharp's text renderer (Pango: it
// wraps lines and draws Hindi and emoji with the machine's fonts); the wall, the header and the bubbles are an SVG
// underneath, holding no words. Every word from WhatsApp is escaped for Pango markup first (markup()), so a message can
// never change how the picture looks. No I/O: the caller uploads the PNG.

/** Drawn at twice the size it is shown at, so it stays sharp on a phone. */
const SCALE = 2;
export const PICTURE_WIDTH = 720 * SCALE;
const PAD = 16 * SCALE;
const HEADER = 60 * SCALE;
const GAP = 6 * SCALE;
const BUBBLE_MAX = Math.round(PICTURE_WIDTH * 0.72);
const PAD_X = 10 * SCALE;
const PAD_Y = 7 * SCALE;
const RADIUS = 8 * SCALE;
const EDGE = 3 * SCALE;
const DPI = 72 * SCALE;
/** A message longer than this is cut, with "…". */
const TEXT_MAX = 600;
/** ...and at most this many lines (a 600-character message of line breaks would be a 600-line picture); a transcript gets half. */
const TEXT_LINES = 12;
const TRANSCRIPT_LINES = 6;
const C = {
  wall: '#efeae2', head: '#008069', headText: '#ffffff', headSub: '#d9fdd3', in: '#ffffff', out: '#d9fdd3',
  hit: '#fff3c4', hitEdge: '#f5a623', name: '#1f7aec', meta: '#667781', text: '#111b21',
} as const;

const KIND: Partial<Record<PictureMessage['kind'], string>> = {
  image: 'Photo', video: 'Video', document: 'Document', sticker: 'Sticker', voice: 'Voice note', audio: 'Audio',
  location: 'Location', contact: 'Contact', poll: 'Poll', event: 'Event', other: 'File',
};

/** Text for Pango markup: &, < and > escaped, so it is drawn as it is. */
export function markup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** At most max whole characters, "…" when cut. */
function cut(s: string, max: number): string {
  const parts = Array.from(graphemes.segment(s), (g) => g.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join('').trimEnd()}…` : s;
}

const span = (color: string, text: string, extra = '') => `<span foreground="${color}"${extra}>${text}</span>`;

/** At most max lines, with runs of blank lines folded to one, "…" when cut. */
function fewLines(s: string, max: number): string {
  const all = s.replace(/\n{3,}/g, '\n\n').split('\n');
  return all.length > max ? `${all.slice(0, max).join('\n').trimEnd()}…` : all.join('\n');
}

/** One bubble's words as Pango markup: the sender (theirs only), the quote, the media label, the text, the time. */
function bubbleMarkup(m: PictureMessage): string {
  const lines: string[] = [];
  if (!m.mine) lines.push(span(C.name, markup(m.sender), ' weight="bold"'));
  if (m.deleted) {
    lines.push(span(C.meta, 'This message was deleted', ' style="italic"'));
  } else {
    if (m.quote) lines.push(span(C.meta, `↩ ${markup(m.quote.sender)}: ${markup(cut(m.quote.text || KIND[m.quote.kind] || 'deleted message', 80))}`, ' size="small"'));
    const label = KIND[m.kind];
    if (label) {
      const length = m.seconds ? ` ${formatDuration(m.seconds)}` : '';
      lines.push(span(C.meta, `${label}${length}${m.transcript ? `: ${markup(fewLines(cut(m.transcript, TEXT_MAX), TRANSCRIPT_LINES))}` : ''}`, ' style="italic"'));
    }
    if (m.text) lines.push(span(C.text, markup(fewLines(cut(m.text, TEXT_MAX), TEXT_LINES))));
  }
  lines.push(span(C.meta, `${m.edited && !m.deleted ? 'edited · ' : ''}${istTime(new Date(m.at))}`, ' size="x-small"'));
  return lines.join('\n');
}

/** Markup drawn as a transparent PNG, wrapped at width. */
async function words(text: string, width: number): Promise<{ png: Buffer; width: number; height: number }> {
  const { data, info } = await sharp({ text: { text, font: 'sans 15', width, dpi: DPI, rgba: true, wrap: 'word-char' } })
    .png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** The picture of a window (pictureWindow) as a PNG. */
export async function drawChatPicture(w: PictureWindow): Promise<Buffer> {
  const source = w.messages.find((m) => m.source) ?? w.messages[0];
  const sub = `${w.client.code}${source ? ` · ${istShortDate(new Date(source.at))}` : ''}`;
  const head = await words(`${span(C.headText, markup(oneLine(w.client.name, 80)), ' weight="bold"')}\n${span(C.headSub, markup(oneLine(sub, 80)), ' size="small"')}`, PICTURE_WIDTH - 2 * PAD);
  const layers: OverlayOptions[] = [{ input: head.png, top: Math.max(0, Math.round((HEADER - head.height) / 2)), left: PAD }];
  const rects: string[] = [];
  let y = HEADER + PAD;
  for (const m of w.messages) {
    const t = await words(bubbleMarkup(m), BUBBLE_MAX - 2 * PAD_X);
    const bw = t.width + 2 * PAD_X;
    const bh = t.height + 2 * PAD_Y;
    const x = m.mine ? PICTURE_WIDTH - PAD - bw : PAD;
    const fill = m.source ? C.hit : m.mine ? C.out : C.in;
    rects.push(`<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${RADIUS}" fill="${fill}"${m.source ? ` stroke="${C.hitEdge}" stroke-width="${EDGE}"` : ''}/>`);
    layers.push({ input: t.png, top: y + PAD_Y, left: x + PAD_X });
    y += bh + GAP;
  }
  const height = y - GAP + PAD;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_WIDTH}" height="${height}"><rect width="100%" height="100%" fill="${C.wall}"/><rect width="100%" height="${HEADER}" fill="${C.head}"/>${rects.join('')}</svg>`;
  return sharp(Buffer.from(svg)).composite(layers).png({ compressionLevel: 9 }).toBuffer();
}
