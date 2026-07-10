# Cutline

Open-source content pipeline for technical creators.

**Find the publishable ideas inside a recording.**

Give Cutline a recording (and optionally a script). It builds a first-draft publishing queue — standalone Shorts/TikToks with creator-style titles, scores, and cut points.

```bash
# ad-hoc — video only
cutline outline ./demo.mp4

# with a script
cutline outline ./demo.mp4 ./script.md
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

See [VISION.md](./VISION.md) for where this is headed.

## Setup

```bash
npm install
cp .env.example .env   # set OPENAI_API_KEY
npm run build
```

Requirements:

- Node.js 20+
- [ffmpeg](https://ffmpeg.org/) on your PATH
- An OpenAI API key

## Usage

```bash
npm run dev -- outline ./demo.mp4 --out output
npx cutline outline ./demo.mp4
```

### Script format (optional)

```md
- [SnowChat response]
  - Talking point one
  - Talking point two
```

## License

MIT
