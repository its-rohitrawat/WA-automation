/**
 * The kv key under which the Drive publisher (drive.ts) stores the Drive file id of Tracker.xlsx once it has uploaded
 * it; the morning report reads it to build the tracker link. In its own module so the report can use it without
 * loading drive.ts (and, through it, the Google client and the workbook). Never change the value: existing databases
 * hold the id under it.
 */
export const TRACKER_ID_KEY = 'drive_tracker_id';
