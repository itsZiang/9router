import { runCompressionEval } from "./runner";
import { extractTextContent } from "../messageContent";

/**
 * Replay-bench over real transcripts (TV3). Instead of synthetic prompts, feed
 * captured conversation turns through a compression function and measure ratio +
 * retention per turn, grouped by transcript. This catches regressions that only
 * show up on real-world inputs (tool dumps, long histories, mixed content).
 */

/** Flatten transcripts into eval cases — one per non-empty turn, grouped by transcript id. */
export function transcriptsToCorpus(transcripts) {
  const corpus = [];
  for (const transcript of transcripts) {
    transcript.turns.forEach((turn, index) => {
      if (turn.content?.trim()) {
        corpus.push({
          id: `${transcript.id}#${index}`,
          input: turn.content,
          task: transcript.id
        });
      }
    });
  }
  return corpus;
}
export function replayTranscripts(transcripts, compress) {
  return runCompressionEval(transcriptsToCorpus(transcripts), compress);
}

/** Shape of a captured request body — only the messages array matters for replay. */

/**
 * Build a {@link Transcript} from a captured request body (a call-log / capture-store entry).
 * Multimodal and tool-result content blocks are flattened to text via extractTextContent, so a
 * replay corpus can be sourced from real traffic instead of synthetic prompts. A non-object body
 * or one without a `messages` array yields a transcript with no turns (callers can filter those).
 */
export function requestBodyToTranscript(id, body) {
  const messages = body && typeof body === "object" && Array.isArray(body.messages) ? body.messages : [];
  const turns = messages.map(message => ({
    role: typeof message.role === "string" ? message.role : "user",
    content: extractTextContent(message.content)
  }));
  return {
    id,
    turns
  };
}

/**
 * Map a list of captured request bodies (e.g. read from the capture store / call logs) into
 * transcripts. Pair with {@link replayTranscripts} to benchmark compression over real traffic.
 */
export function requestBodiesToTranscripts(entries) {
  return entries.map(entry => requestBodyToTranscript(entry.id, entry.body));
}