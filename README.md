# Ambiance Video Generator

Personal pipeline for long, illustrated **Indian ambiance** videos for YouTube. The plan, research and phased roadmap are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

What's built so far is two services behind one local web page:

1. **Image generation.** Describe a scene and get 6 candidates in a hand-painted anime style. Then you can:
   - save (star) the ones you like;
   - ask for "more like this" from any image;
   - regenerate with the same prompt;
   - edit the prompt;
   - start from a saved image instead of a new prompt.
2. **Image animation.** Turn a chosen image into an 8 s, 1080p Veo clip. The image is used as both the first and last frame, so the clip loops back to where it started. One image can have several takes; star the best.

## Setup

Requirements: Node 24+.

```sh
npm install
cp env.sample .env      # then edit .env
npm start               # http://127.0.0.1:4317
```

By default `PROVIDERS=mock`: everything runs locally for free, with placeholder images and a placeholder clip. To use the real APIs, set these in `.env`:

```
PROVIDERS=google
GEMINI_API_KEY=...      # https://aistudio.google.com/apikey
SPEND_CAP_USD=10
```

`npm start` runs Node with `--use-system-ca`. Corporate TLS inspection makes Node's built-in certificate list reject Google's API, and this flag makes Node trust the Windows certificate store instead.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDERS` | `mock` | `mock` (free) or `google` (paid Gemini image API + Veo) |
| `GEMINI_API_KEY` | — | Required for `google` |
| `SPEND_CAP_USD` | `10` | Hard cap on recorded spend. In-flight animations count against it. |
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Bound to localhost; there's no login yet |
| `DATA_DIR` | `./data` | SQLite database and generated files (gitignored) |
| `IMAGES_PER_BATCH` | `6` | Candidates per batch |
| `IMAGE_MODEL` | `gemini-nano-banana-2.1` | Gemini image model |
| `IMAGE_SIZE` | `2K` | `1K`, `2K` or `4K` |
| `IMAGE_COST_USD` | `0.0504` | Price per image, used for estimates and the ledger (2K price, checked 2026-10-12) |
| `VIDEO_MODEL` | `veo-3.1-fast-generate-preview` | Veo model |
| `VIDEO_COST_PER_SECOND_USD` | `0.12` | Veo 3.1 Fast price per second (checked 2026-10-12); 8 s ≈ $0.96 |
| `VIDEO_POLL_INTERVAL_MS` | `10000` | How often to check on a Veo job |

## How it works

- **Storage.** Image and video files are stored by content hash under `data/assets/`. SQLite (`data/ambiance.db`, via Node's built-in `node:sqlite`) holds:
  - batches and images: prompt, model, size, saved flag;
  - animations: motion prompt, Veo operation id, status;
  - a cost ledger.
- **Prompts.** You type only the scene. The service adds:
  - the style (`src/modules/images/style.ts`);
  - the channel rules: no text, no people, respectful Indian setting.

  The full prompt is shown with every batch.
- **Spending money.** Paid buttons show the estimated cost and need a second click to confirm. The server refuses anything that would go over `SPEND_CAP_USD`.
- **Resuming.**
  - Veo jobs are tracked by operation id. If the server restarts mid-job, it resumes polling instead of submitting (and paying) again.
  - Clicking Animate twice for the same image and prompt reuses the in-flight job.
  - Image batches interrupted by a restart are marked `interrupted`.
- **Audio.** Veo always generates audio. The file is kept as returned and plays muted on the page; the renderer will strip it later.
- **Retention.** Google deletes Veo outputs after 2 days. The service downloads each clip as soon as it's ready.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/config` | Provider, models, cost estimates, spend |
| GET | `/api/batches?limit=` | Recent batches with their images |
| POST | `/api/batches` | `{ scenePrompt?, stylePreset?, parentBatchId?, referenceImageId? }`. Starts a batch (202). |
| GET | `/api/batches/:id` | One batch with its images |
| GET | `/api/images/saved` | Saved images |
| GET / PATCH | `/api/images/:id` | Read, or update `{ saved?, notes? }` |
| GET | `/api/images/:id/motion-suggestion` | Suggested Veo motion prompt for the image's scene |
| GET | `/api/animations?imageId=` | Takes for one image (or recent takes) |
| POST | `/api/animations` | `{ imageId, motionPrompt? }`. Starts an animation (202). |
| GET / PATCH | `/api/animations/:id` | Read, or update `{ starred }` |
| GET | `/api/spend` | `{ spentUsd, inFlightUsd, capUsd }` |
| GET | `/assets/<path>` | Generated files (supports range requests for video) |

## Development

```sh
npm test          # node:test, mock providers, no network
npm run typecheck # tsc --noEmit
npm run dev       # restart on file changes
```

TypeScript runs directly through Node's built-in type stripping, so there's no build step. Code uses only erasable syntax (no enums or parameter properties) and imports with `.ts` extensions.

```
src/
  core/        config, SQLite + migrations, asset store, cost guard
  providers/   google/ (Gemini image, Veo), mock/, shared types + HTTP helper
  modules/     images/ (style presets, batches), animation/ (motion prompts, Veo jobs)
  server/      Fastify routes + static files
web/           the page (plain HTML/CSS/JS)
test/
```
