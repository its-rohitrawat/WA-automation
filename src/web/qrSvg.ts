import { createRequire } from 'node:module';

// The WhatsApp link QR code as an SVG image for the dashboard (D3). It uses the QR encoder that qrcode-terminal (already
// a dependency, used by the CLI) ships in its vendor folder, so no new package is needed. The SVG is built from numbers
// only: the QR text never appears in it, and it carries no script, link or external reference.

interface QrEncoder {
  addData(text: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode/index.js') as new (typeNumber: number, level: number) => QrEncoder;
const Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js') as { L: number; M: number; Q: number; H: number };

/** The white border around the code, in modules (the QR standard asks for 4). */
const QUIET = 4;

/** The QR code of `text` as an SVG document: one white square and one black path, sized by its viewBox. */
export function renderQrSvg(text: string): string {
  const qr = new QRCode(-1, Level.L); // -1: the smallest version that fits; L: what WhatsApp's own codes use
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + QUIET * 2;
  let path = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(row, col)) path += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}
