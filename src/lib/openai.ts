import { createReadStream } from "node:fs";
import OpenAI from "openai";

/** whisper-1 is required for segment/word timestamps (verbose_json). */
const TRANSCRIBE_MODEL = "whisper-1";
const OUTLINE_MODEL = "gpt-4o-mini";

export type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptResult = {
  text: string;
  segments: TranscriptSegment[];
};

export function requireApiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY is missing. Copy .env.example to .env and set your key, or export OPENAI_API_KEY.",
    );
  }
  return key;
}

export function createOpenAIClient(): OpenAI {
  return new OpenAI({ apiKey: requireApiKey() });
}

/** Format seconds as M:SS or H:MM:SS. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** One timestamped line per Whisper segment (usually phrase/sentence-sized). */
export function formatTimestampedTranscript(
  segments: TranscriptSegment[],
): string {
  return segments
    .map((seg) => {
      const text = seg.text.trim();
      if (!text) return null;
      return `[${formatTimestamp(seg.start)}] ${text}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export async function transcribeAudio(
  client: OpenAI,
  audioPath: string,
): Promise<TranscriptResult> {
  const result = await client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: TRANSCRIBE_MODEL,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  const segments: TranscriptSegment[] = (result.segments ?? []).map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
  }));

  const text =
    result.text?.trim() ||
    segments
      .map((s) => s.text)
      .filter(Boolean)
      .join(" ");

  if (segments.length === 0 && text) {
    return { text, segments: [{ start: 0, end: 0, text }] };
  }

  return { text, segments };
}

export async function generatePublishableClips(
  client: OpenAI,
  timestampedTranscript: string,
  script?: string,
): Promise<string> {
  const hasScript = Boolean(script?.trim());

  const system = `Find the publishable ideas inside this recording.

You are building a publishing queue of standalone YouTube Shorts / TikToks — not summarizing the video, not writing a table of contents, not labeling chapters.

Each clip should:
- Teach exactly one idea.
- Start where the idea actually begins — never on transition or setup lines.
- End immediately after the payoff — as soon as the central idea has been fully demonstrated.
- Ignore transitions. Lines like "so real quick before I show you the next step", "from here we go to", "I guess there is a middle step" almost never belong in a Short. Start on the first line that delivers the idea.
- Ignore greetings and setup that only exist to introduce a later idea.

Do not optimize for equal-sized chapters. Optimize for complete ideas.

Titles must sound like a real creator on YouTube or TikTok — curiosity, specificity, concrete outcomes.
Ask: "If this were uploaded as its own Short tomorrow, what would YOU actually call it?"
Avoid generic marketing phrases: Unlock, Discover, Instantly, Effortlessly, Powerful, Insights, Game-changer, Revolutionary.
  Bad: "Unlock Insights from TikTok Videos Instantly", "Discovering TikTok Video Insights with Snowball"
  Good: "Why Raw TikTok Metrics Aren't Enough", "AI Watches TikTok Videos So You Don't Have To", "We Let AI Explain Why This TikTok Went Viral", "Chat with TikTok Videos Like They're ChatGPT"
${
  hasScript
    ? `Use the original script to understand the creator's intended beats.
Use the timestamped transcript to decide where each clip actually starts and ends.`
    : `Infer creator intent from the transcript alone.`
}

Score each clip 1.0–10.0 for publish-worthiness. Be honest — not every clip is a 9.
High scores: standalone idea, strong payoff, clear demo, minimal setup.
Lower scores: weak payoff, heavy setup, transition-heavy, incomplete idea.

The transcript lines are already timestamped like \`[0:54] spoken words\`. Use those timestamps — do not invent new ones.
Start = timestamp of the first included line. End = timestamp of the last included line.
Prefer fewer strong clips (usually 2–5) over many weak ones.
Omit material that is not part of a publishable clip.

Output ONLY in this exact format (no preamble, no closing commentary):

# Clip 1

Title:
Why Raw TikTok Metrics Aren't Enough

Start:
0:07

End:
0:58

Score:
9.2/10

Why:
- Standalone idea
- Strong payoff
- Clear demo
- Minimal setup

Transcript:
[0:07] Spoken line…
[0:12] Next spoken line…

---

# Clip 2

Title:
AI Watches TikTok Videos So You Don't Have To

Start:
1:02

End:
1:29

Score:
8.4/10

Why:
- Standalone explanation of one feature
- Clear demo payoff

Transcript:
[1:02] Spoken line…

- Use M:SS for under an hour, H:MM:SS if longer.
- Separate clips with a horizontal rule (\`---\`).
- Put the strongest clips first when scores differ meaningfully.`;

  const user = hasScript
    ? `## Script

${script}

## Timestamped transcript

${timestampedTranscript}`
    : `## Timestamped transcript

${timestampedTranscript}`;

  const response = await client.chat.completions.create({
    model: OUTLINE_MODEL,
    temperature: 0.35,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("OpenAI returned an empty publishable-clips result.");
  }
  return text;
}
