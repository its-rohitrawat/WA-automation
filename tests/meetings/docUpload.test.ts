import { describe, expect, it } from 'vitest';
import { meetingDocName, renderMeetingDoc, type MeetingDocInput } from '../../src/meetings/doc.ts';
import { uploadMeetingDoc } from '../../src/meetings/docUpload.ts';
import { DriveNotFoundError } from '../../src/output/drive.ts';
import { getKv, setKv } from '../../src/store/kv.ts';
import { seededDb } from '../helpers/db.ts';
import { FakeDrive } from '../helpers/fakeDrive.ts';

const meeting: MeetingDocInput = {
  clientId: 1,
  clientName: 'Sharma Interiors',
  title: 'Logo review',
  startedAt: '2026-10-19T08:35:00Z',
  seconds: 600,
  attendees: [{ name: 'Asha Verma', email: 'asha@studio.example', team: true }],
  summary: { whatHappened: 'Done.', discussion: [], decisions: [], actionItems: [], openQuestions: [], conclusion: '', speakers: [] },
  segments: [{ start: 0, end: 2, speaker: 'A', text: 'Hello' }],
  transcriptCut: false,
};

async function setup() {
  const db = await seededDb();
  const drive = new FakeDrive();
  setKv(db, 'drive_root_id', 'root-1');
  return { db, drive };
}

describe('uploadMeetingDoc', () => {
  it('makes the Meetings folder once and creates each Doc in it, returning the Doc id', async () => {
    const { db, drive } = await setup();
    const first = await uploadMeetingDoc({ db, api: drive }, meeting);
    const second = await uploadMeetingDoc({ db, api: drive }, { ...meeting, title: 'Second' });
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings']);
    expect(drive.docs).toEqual([
      { id: first, name: meetingDocName(meeting), parentId: 'folder-3', html: renderMeetingDoc(meeting) },
      { id: second, name: '2026-10-19 – Sharma Interiors – Second', parentId: 'folder-3', html: renderMeetingDoc({ ...meeting, title: 'Second' }) },
    ]);
    expect(first).not.toBe(second);
  });

  it('re-creates the Meetings folder once when the saved one is gone', async () => {
    const { db, drive } = await setup();
    await uploadMeetingDoc({ db, api: drive }, meeting);
    drive.missing.add(getKv(db, 'drive_meetings_folder:1')!);
    await uploadMeetingDoc({ db, api: drive }, meeting);
    expect(drive.folders).toEqual(['Clients', 'Sharma Interiors', 'Meetings', 'Meetings']);
    expect(drive.docs.map((d) => d.parentId)).toEqual(['folder-3', 'folder-5']);
  });

  it('passes a sign-in failure through as it came', async () => {
    const { db, drive } = await setup();
    const auth = Object.assign(new Error('unauthorized'), { code: 401 });
    drive.failNextWith = auth;
    await expect(uploadMeetingDoc({ db, api: drive }, meeting)).rejects.toBe(auth);
  });
});

describe('FakeDrive.createDoc', () => {
  it('records name, parent and HTML, and fails like createFile', async () => {
    const drive = new FakeDrive();
    const id = await drive.createDoc('N', '<p>a</p>', 'p-1');
    expect(drive.docs).toEqual([{ id, name: 'N', parentId: 'p-1', html: '<p>a</p>' }]);
    drive.missing.add('p-2');
    await expect(drive.createDoc('N', '', 'p-2')).rejects.toBeInstanceOf(DriveNotFoundError);
    drive.fileParentsMissing = true;
    await expect(drive.createDoc('N', '', 'p-1')).rejects.toBeInstanceOf(DriveNotFoundError);
    drive.fileParentsMissing = false;
    drive.failNext = 1;
    await expect(drive.createDoc('N', '', 'p-1')).rejects.toThrow('Drive unavailable');
    expect(drive.createDocCalls).toBe(4);
    expect(drive.docs).toHaveLength(1);
  });
});
