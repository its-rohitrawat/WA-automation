import { describe, expect, it, vi } from 'vitest';
import { SourcePictures } from '../../src/output/sourcePictures.ts';
import type { Db } from '../../src/store/db.ts';
import { setKv } from '../../src/store/kv.ts';
import { insertMessage } from '../../src/store/messages.ts';
import { createTask, setTaskStatus, type NewTask } from '../../src/store/tasks.ts';
import { manualClock } from '../../src/util/clock.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { NOW, seeded } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

const task = (clientId: number, sourceWaId: string): NewTask => ({
  clientId, side: 'us', title: 'Brighter banner', category: 'design', priority: 'major', assignedTo: null, askedBy: null,
  raisedOn: '2026-11-03', deadline: null, latestProgress: null, sourceQuote: 'banner bright karo', sourceDate: '2026-11-03', sourceWaId, origin: 'whatsapp',
});

/** The same database, except that the first write to source_pictures throws (a database that cannot save one result). */
function failingFirstSave(db: Db): Db {
  let failed = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'run') {
        return async (sql: string, params?: unknown) => {
          if (!failed && sql.trimStart().startsWith('INSERT INTO source_pictures')) {
            failed = true;
            throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
          }
          return (target.run as (s: string, p?: unknown) => Promise<unknown>).call(target, sql, params);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function setup(o: { tasks?: number; root?: boolean; perRun?: number; flaky?: boolean } = {}) {
  const { db, ids } = await seeded();
  if (o.root !== false) await setKv(db, 'drive_root_id', 'root');
  const n = o.tasks ?? 2;
  for (let i = 1; i <= n + 1; i++) {
    await insertMessage(db, { waId: `w${i}`, clientId: ids.sharma, senderJid: '919800000002@s.whatsapp.net', senderNumber: null, senderName: 'Rahul', fromMe: false, ts: new Date(Date.UTC(2026, 10, 3, 5, i)).toISOString(), text: `message ${i}`, quotedWaId: null, mediaType: null });
  }
  const tasks = [];
  for (let i = 1; i <= n; i++) tasks.push(await createTask(db, task(ids.sharma, `w${i}`), new Date(Date.UTC(2026, 10, 3, 6, i)).toISOString()));
  const done = await createTask(db, task(ids.sharma, `w${n + 1}`), NOW);
  await setTaskStatus(db, done.id, 'done', '2026-11-03', NOW, 'human');
  const drive = new FakeDrive();
  const clock = manualClock(NOW);
  const onMade = vi.fn();
  const pictures = new SourcePictures({ db: o.flaky ? failingFirstSave(db) : db, api: drive, clock, log: silentLogger(), onMade, ...(o.perRun ? { perRun: o.perRun } : {}) });
  const sourcesFolder = () => drive.folderIds[drive.folders.indexOf('Sources')];
  return { db, ids, tasks, drive, clock, onMade, pictures, sourcesFolder };
}

describe('SourcePictures (a chat picture as each task’s source, 11 Nov 2026)', () => {
  it('draws and uploads one PNG per open task with a stored source into the client’s Sources folder, then asks for an upload', async () => {
    const { db, tasks, drive, onMade, pictures, sourcesFolder } = await setup();
    await pictures.run();
    expect(drive.created.map((f) => f.name).sort()).toEqual(tasks.map((t) => `${t.code}.png`).sort());
    expect(drive.created.every((f) => f.parentId === sourcesFolder())).toBe(true);
    expect(drive.createMimes.every((m) => m === 'image/png')).toBe(true);
    expect(onMade).toHaveBeenCalledTimes(1);
    expect(await db.all('SELECT drive_file_id AS file FROM source_pictures ORDER BY task_id')).toHaveLength(2);
    await pictures.run(); // nothing is due any more
    expect(drive.created).toHaveLength(2);
    expect(onMade).toHaveBeenCalledTimes(1);
  });

  it('makes at most perRun per run, newest task first', async () => {
    const { tasks, drive, pictures } = await setup({ tasks: 3, perRun: 2 });
    await pictures.run();
    expect(drive.created.map((f) => f.name)).toEqual([`${tasks[2]!.code}.png`, `${tasks[1]!.code}.png`]);
    await pictures.run();
    expect(drive.created.at(-1)!.name).toBe(`${tasks[0]!.code}.png`);
  });

  it('does nothing before the first tracker upload has made the WA Agent folder: nothing drawn, no Drive call, no row', async () => {
    const { db, drive, onMade, pictures } = await setup({ root: false });
    await pictures.run();
    expect(drive.created).toEqual([]);
    expect(drive.folders).toEqual([]);
    expect(drive.createFileCalls).toBe(0);
    expect(onMade).not.toHaveBeenCalled();
    expect(await db.all('SELECT id FROM source_pictures')).toEqual([]);
  });

  it('records a Drive failure by its code and tries again 10 minutes later', async () => {
    const { db, drive, clock, pictures } = await setup({ tasks: 1 });
    drive.failNextWith = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await pictures.run();
    expect(drive.created).toEqual([]);
    expect(await db.get('SELECT error_code AS code, attempts FROM source_pictures')).toEqual({ code: 'ECONNRESET', attempts: 1 });
    clock.advance(9 * 60_000);
    await pictures.run();
    expect(drive.created).toEqual([]); // not yet
    clock.advance(2 * 60_000);
    await pictures.run();
    expect(drive.created).toHaveLength(1);
  });

  it('stops at a Google sign-in failure, writes no row, and pauses for 15 minutes', async () => {
    const { db, drive, clock, pictures } = await setup();
    drive.failNextWith = Object.assign(new Error('unauthorized'), { code: 401 });
    await pictures.run();
    expect(drive.createFileCalls).toBe(0);
    expect(await db.all('SELECT id FROM source_pictures')).toEqual([]);
    clock.advance(14 * 60_000);
    await pictures.run();
    expect(drive.created).toEqual([]); // still paused
    clock.advance(2 * 60_000);
    await pictures.run();
    expect(drive.created).toHaveLength(2);
  });

  it('makes a new picture when a task’s source changes', async () => {
    const { db, tasks, drive, pictures } = await setup({ tasks: 1 });
    await pictures.run();
    await db.run("UPDATE tasks SET source_wa_id = 'w2' WHERE id = ?", [tasks[0]!.id]);
    await pictures.run();
    expect(drive.created.map((f) => f.name)).toEqual([`${tasks[0]!.code}.png`, `${tasks[0]!.code}.png`]);
  });

  it('when the database cannot save the id, pauses and later saves that id without uploading again', async () => {
    const { db, drive, clock, onMade, pictures } = await setup({ tasks: 1, flaky: true });
    await pictures.run();
    expect(drive.created).toHaveLength(1);
    expect(await db.all('SELECT id FROM source_pictures')).toEqual([]);
    expect(onMade).not.toHaveBeenCalled();
    clock.advance(10 * 60_000);
    await pictures.run(); // still paused: no save, no upload
    expect(drive.created).toHaveLength(1);
    expect(await db.all('SELECT id FROM source_pictures')).toEqual([]);
    clock.advance(6 * 60_000);
    await pictures.run();
    expect(drive.created).toHaveLength(1);
    expect(await db.get('SELECT drive_file_id AS file FROM source_pictures')).toEqual({ file: drive.created[0]!.id });
    expect(onMade).toHaveBeenCalledTimes(1);
  });

  it('stop() tries once more to save an id the database refused', async () => {
    const { db, drive, pictures } = await setup({ tasks: 1, flaky: true });
    await pictures.run();
    await pictures.stop(1000);
    expect(drive.created).toHaveLength(1);
    expect(await db.get('SELECT drive_file_id AS file FROM source_pictures')).toEqual({ file: drive.created[0]!.id });
  });

  it('a run already going is shared; after stop() no run starts', async () => {
    const { drive, pictures } = await setup();
    await Promise.all([pictures.run(), pictures.run()]);
    expect(drive.created).toHaveLength(2);
    await pictures.stop(1000);
    await pictures.run();
    expect(drive.created).toHaveLength(2);
  });
});
