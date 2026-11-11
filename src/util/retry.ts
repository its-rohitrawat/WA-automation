/**
 * Delay before the next try after `attempt` failed tries: 2, 4, 8 ... minutes, at most 6 hours. Shared by the file
 * uploader (src/media/uploader.ts) and the chat pictures (src/store/sourcePictures.ts), so a Drive outage costs both
 * the same few tries.
 */
export const retryMs = (attempt: number): number => Math.min(60_000 * 2 ** attempt, 6 * 3_600_000);
