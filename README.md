# Cutline

[![npm version](https://img.shields.io/npm/v/@cgalatro2/cutline.svg)](https://www.npmjs.com/package/@cgalatro2/cutline)

Open-source content pipeline for technical creators.

**Find the publishable ideas inside your work.**

`cutline harvest` collects Cursor and ChatGPT conversations and turns them into a moment brief: quoted beats from your work, plus a pointer back to the full archive.

## Install

Requirements:

- Node.js 20+
- An [OpenAI API key](https://platform.openai.com/api-keys) for idea mining (and for `clip` transcription)
- Optional: [chatdump](https://github.com/combinatrix-ai/chatdump) on your PATH to include ChatGPT (macOS menu bar app + CLI)
- Optional: [ffmpeg](https://ffmpeg.org/) on your PATH (`brew install ffmpeg`) for `clip`

```bash
# one-shot
npx @cgalatro2/cutline harvest 3

# or install the `cutline` command globally
npm install -g @cgalatro2/cutline
cutline harvest 3
```

Set your API key (either works):

```bash
export OPENAI_API_KEY=sk-...
# or
cp .env.example .env   # if running from a clone
```

## Harvest conversations

`cutline harvest` collects new Cursor and ChatGPT work conversations since the last successful run, writes a local archive, and mines it for moments. ChatGPT is included when [chatdump](https://github.com/combinatrix-ai/chatdump) is installed. Without it, harvest skips ChatGPT and still archives Cursor.

First run, backfill the last few days and set the checkpoint:

```bash
cutline harvest 3
cutline harvest 3 -m "Worked on Snowball auth"
```

Every run after that:

```bash
cutline harvest
```

Other options:

```bash
cutline harvest --since 3
cutline harvest --no-analyze
cutline harvest --out ./my-harvests
```

`--since` / the optional day argument is a backfill window. After the first successful harvest you do not need it. Archives and checkpoints stay on this machine:

```txt
~/.cutline/state.json
~/.cutline/harvests/2026-09-02T175012/
  harvest.json
  conversations.md
  moments.md
```

`conversations.md` is the full archive. `moments.md` is a paste-sized brief for a stronger editor: quotes, a tag, and one nearby turn. gpt-4o-mini only highlights. It does not write posts.

Cursor transcripts are read from `~/.cursor/projects/*/agent-transcripts`. ChatGPT conversations are synced with `chatdump sync`, then read from chatdump's local JSON cache. Conversation archives stay local and are gitignored.

Analysis (on by default) sends harvested conversation text to OpenAI. There is no secret redaction. Use `--no-analyze` to archive without uploading. `OPENAI_API_KEY` is required unless you pass `--no-analyze`.

## Clip a recording

Give Cutline a recording (and optionally a script). It builds a first-draft publishing queue: standalone Shorts/TikToks with creator-style titles, scores, and cut points.

```bash
# video only
cutline clip ./demo.mp4

# with a script
cutline clip ./demo.mp4 ./script.md

# custom output dir
cutline clip ./demo.mp4 --out ./my-run
```

Produces:

```txt
output/
  audio.mp3
  transcript.md
  publishable-clips.md
```

`publishable-clips.md` is the creator artifact:

```md
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
[0:07] …
```

### Script format (optional)

```md
- [Camera angle]
  - Talking point one
  - Talking point two
```

## Develop from source

Clone the repo and run your own local `cutline` while you hack:

```bash
git clone https://github.com/cgalatro2/cutline.git
cd cutline
npm install
cp .env.example .env   # set OPENAI_API_KEY
npm run build          # compiles to dist/ and marks the bin executable
npm link               # puts this checkout's `cutline` on your PATH
cutline harvest 3
```

After code changes:

```bash
npm run build          # required. `cutline` runs dist/, not src/
cutline harvest 3
```

Or skip the link and run TypeScript directly:

```bash
npm run dev -- harvest 3
```

To go back to the published npm version:

```bash
npm unlink -g @cgalatro2/cutline
npm install -g @cgalatro2/cutline
```

See [VISION.md](./VISION.md) for where this is headed.

## License

MIT
