/**
 * The kv key under which the Drive publisher (drive.ts) stores the Drive file id of Tracker.xlsx once it has uploaded
 * it; the morning report reads it to build the tracker link. In its own module so the report can use it without
 * loading drive.ts (and, through it, the Google client and the workbook). Never change the value: existing databases
 * hold the id under it.
 */
export const TRACKER_ID_KEY = 'drive_tracker_id';

/** The tracker's file name and the agent's top folder in Drive. */
export const TRACKER_FILE_NAME = 'Tracker.xlsx';
export const DRIVE_ROOT_NAME = 'WA Agent';

/**
 * The kv key holding when (ISO time) the publisher last had to start a new Tracker.xlsx because the stored one could not
 * be reached and none was visible in any WA Agent folder (usually: the Google login changed). The Tracker screen shows it as a note.
 */
export const TRACKER_NEW_FILE_KEY = 'drive_tracker_new_file_at';
