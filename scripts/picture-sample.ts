// A sample chat picture for the owner to look at before go-live (11 Nov 2026): made from fixed words, with no database,
// no WhatsApp and no Drive. node scripts/picture-sample.ts --out <file.png>
import '../src/media/image.ts'; // blocks sharp's SVG loader, as the app does: the sample is drawn as in production
import { writeFileSync } from 'node:fs';
import type { PictureMessage } from '../src/control/chatQueries.ts';
import { drawChatPicture } from '../src/output/chatPicture.ts';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!out || !out.endsWith('.png')) throw new Error('Give --out <file.png>');
const at = (min: number) => new Date(Date.UTC(2026, 10, 3, 4, min)).toISOString();
const m = (o: Partial<PictureMessage>): PictureMessage => ({
  id: 1, at: at(0), mine: false, sender: 'Mr. Sharma', text: '', kind: 'text', seconds: null, transcript: null, quote: null,
  edited: false, deleted: false, source: false, ...o,
});
const png = await drawChatPicture({
  client: { code: 'SHA', name: 'Sharma Interiors' },
  messages: [
    m({ at: at(8), sender: 'Priya', text: 'Logo final ho gaya?' }),
    m({ at: at(9), mine: true, sender: 'Founder', text: 'Haan, sent yesterday' }),
    m({ at: at(10), kind: 'image', text: 'Yeh dekho' }),
    m({ at: at(11), kind: 'voice', seconds: 42, transcript: 'Banner ka colour thoda dull lag raha hai' }),
    m({ at: at(12), source: true, text: 'Banner thoda bright karo @Priya, aur logo bada 👍', quote: { sender: 'Priya', text: 'Logo final ho gaya?', kind: 'text' } }),
    m({ at: at(14), mine: true, sender: 'Founder', text: 'Ok, aaj shaam tak' }),
    m({ at: at(15), sender: 'Priya', text: 'Thanks! बहुत बढ़िया 🙏' }),
  ],
});
writeFileSync(out, png);
console.log(`Sample picture: ${out} (${png.length} bytes)`);
