/**
 * Transcript loading, normalization, and segment utilities.
 */

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export async function loadTranscript(_path: string): Promise<TranscriptSegment[]> {
  throw new Error("transcript helpers not implemented yet");
}
