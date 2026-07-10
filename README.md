# Cutline

[![npm version](https://img.shields.io/npm/v/@cgalatro2/cutline.svg)](https://www.npmjs.com/package/@cgalatro2/cutline)

Open-source content pipeline for technical creators.

**Find the publishable ideas inside a recording.**

Give Cutline a recording (and optionally a script). It builds a first-draft publishing queue — standalone Shorts/TikToks with creator-style titles, scores, and cut points.

## Install

Requirements:

- Node.js 20+
- [ffmpeg](https://ffmpeg.org/) on your PATH (`brew install ffmpeg`)
- An [OpenAI API key](https://platform.openai.com/api-keys)

```bash
# one-shot
npx @cgalatro2/cutline clip ./demo.mp4

# or install the `cutline` command globally
npm install -g @cgalatro2/cutline
cutline clip ./demo.mp4
```

Set your API key (either works):

```bash
export OPENAI_API_KEY=sk-...
# or
cp .env.example .env   # if running from a clone
```

## Usage

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

```bash
git clone https://github.com/cgalatro2/cutline.git
cd cutline
npm install
cp .env.example .env   # set OPENAI_API_KEY
npm run build
npm link               # optional: put local `cutline` on PATH
npm run dev -- clip ./demo.mp4
```

See [VISION.md](./VISION.md) for where this is headed.

## License

MIT
