# cutline

CLI for turning long-form recordings into content assets.

## Status

Early scaffolding. The first command will be:

```bash
cutline outline script.md demo.mp4
```

See [VISION.md](./VISION.md) for where this is headed.

## Setup

```bash
npm install
npm run build
```

During development:

```bash
npm run dev -- outline script.md demo.mp4
```

## Requirements

- Node.js 20+
- ffmpeg (for media extraction)

## License

MIT
