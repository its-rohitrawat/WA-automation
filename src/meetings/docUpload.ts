import type { DriveApi } from '../output/drive.ts';
import { withClientSubfolder } from '../output/folders.ts';
import type { Db } from '../store/db.ts';
import { meetingDocName, renderMeetingDoc, type MeetingDocInput } from './doc.ts';

export interface MeetingDocDeps {
  db: Db;
  api: DriveApi;
}

/**
 * Creates the meeting's summary Doc in WA Agent/Clients/<Client>/Meetings/ (the folder made once and saved in kv
 * drive_meetings_folder:<clientId>; folders removed in Drive are rebuilt, see withClientSubfolder) and returns its id.
 *
 * Every call makes a new Doc. The caller must save the returned id before the tracker step, and never call this again for
 * a meeting that has one, so a retry does not make a second Doc. As with client files, a Doc that Drive made while its
 * answer never arrived (a timeout, a dropped connection) is made again on the next try: a duplicate the owner can see,
 * and nothing is lost.
 *
 * Throws DriveRootMissingError before the publisher has made the WA Agent folder, DriveNotFoundError when folders could
 * not be rebuilt, DriveAuthError (from googleDriveApi) when Google sign-in must be redone, and other Drive errors as they
 * came.
 */
export function uploadMeetingDoc(deps: MeetingDocDeps, meeting: MeetingDocInput): Promise<string> {
  const name = meetingDocName(meeting);
  const html = renderMeetingDoc(meeting);
  return withClientSubfolder(deps.db, deps.api, { clientId: meeting.clientId, clientName: meeting.clientName }, 'Meetings', (folderId) =>
    deps.api.createDoc(name, html, folderId));
}
