# Ambiance Video Generator

Personal pipeline for long, illustrated **Indian ambiance** videos for YouTube. The plan, research and phased roadmap are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

What's built so far is two services behind one web page with three tabs: **New scene**, **All images** and **Animations**.

1. **Image generation.**
   - Describe a scene, pick a style and tap Generate. You get one image in a hand-painted anime style.
   - Generate stays gray until the text reads like a scene. A shared check (`web/scene-check.js`) catches empty boxes, keyboard mashing and symbol soup; the server applies the same check.
   - When it's ready, the page opens it from the All images tab.
   - Each image is tagged automatically: a cheap Gemini vision model looks at it. You can add and remove tags.
   - **All images** is a thumbnail grid you can search by tag. Tap a thumbnail to open the image's page.
   - On that page you can:
     - delete it (🗑), which also deletes its animations;
     - edit its tags;
     - make "more like this" (uses the image as a reference);
     - generate another from the same prompt;
     - tap the image to open the full-resolution original.
2. **Image animation.**
   - On an image's page, **Animate** opens a panel right under the buttons with a suggested motion prompt you can edit.
   - **Start animation** asks for confirmation first.
   - Veo makes an 8 s, 1080p clip. The image is used as both the first and last frame, so the clip loops back to where it started.
   - Clips appear in the **Animations** tab. Each shows "Animating…" until it's done, and tapping a finished one opens a looping player where you can mark it ☆ Best or delete it (🗑).
   - Failed animations are left out of the Animations tab. The image's page says when its last animation failed, and why.

Anything that costs money (Generate image, More like this, Generate another, Start animation) or deletes something asks for confirmation in a dialog. Buttons don't show prices; the header shows total spend against the cap.

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

## Deploy to Render (use it from your phone)

`render.yaml` is a Render Blueprint: one always-on Starter web service with a 2 GB persistent disk at `/var/data` for the database and generated files. It's the same pattern as the tour-guide (deodapper.com) service.

1. In Render: **New → Blueprint**, then pick this repo.
2. When prompted, enter:
   - **`GEMINI_API_KEY`**: get one at https://aistudio.google.com/apikey (works from a phone).
   - **`APP_PASSWORD`**: at least 12 characters. It's the only thing protecting your API spend.

   `SESSION_SECRET` is generated automatically.
3. Open the service URL on your phone and log in.

The app won't start on a non-localhost `HOST` without `APP_PASSWORD` and `SESSION_SECRET`. Sessions are signed cookies that last 30 days. After 5 wrong passwords, an IP is locked out for 15 minutes.

## Notes

`npm start` runs Node with `--use-system-ca`. Corporate TLS inspection makes Node's built-in certificate list reject Google's API, and this flag makes Node trust the Windows certificate store instead.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PROVIDERS` | `mock` | `mock` (free) or `google` (paid Gemini image API + Veo) |
| `GEMINI_API_KEY` | — | Required for `google` |
| `SPEND_CAP_USD` | `10` | Hard cap on recorded spend. In-flight animations count against it. |
| `PORT` / `HOST` | `4317` / `127.0.0.1` | Any non-localhost `HOST` requires the login settings below |
| `APP_PASSWORD` | — | Turns on the password login (12+ characters) |
| `SESSION_SECRET` | — | Signs session cookies (32+ characters); required with `APP_PASSWORD` |
| `TRUST_PROXY` | `0` | Proxy hops to trust for client IP / https (`1` on Render) |
| `DATA_DIR` | `./data` | SQLite database and generated files (gitignored) |
| `IMAGES_PER_BATCH` | `1` | Images per Generate click |
| `IMAGE_MODEL` | `gemini-nano-banana-2.1` | Gemini image model |
| `IMAGE_SIZE` | `2K` | `1K`, `2K` or `4K` |
| `IMAGE_COST_USD` | `0.0504` | Price per image, used for estimates and the ledger (2K price, checked 2026-10-12) |
| `TAG_MODEL` | `gemini-3.1-flash-lite` | Vision model that tags each new image |
| `TAG_COST_USD` | `0.0005` | Estimated cost of one tagging call (an image plus a short reply at $0.25 / $1.50 per million tokens, checked 2026-10-12) |
| `VIDEO_MODEL` | `veo-3.1-fast-generate-preview` | Veo model |
| `VIDEO_COST_PER_SECOND_USD` | `0.12` | Veo 3.1 Fast price per second (checked 2026-10-12); 8 s ≈ $0.96 |
| `VIDEO_POLL_INTERVAL_MS` | `10000` | How often to check on a Veo job |

## How it works

- **Storage.** Image and video files are stored by content hash under `data/assets/`. SQLite (`data/ambiance.db`, via Node's built-in `node:sqlite`) holds:
  - images: prompt, model, size and tags;
  - generations: one row per Generate click, kept for provenance;
  - animations: motion prompt, Veo operation id, status;
  - a cost ledger.
- **Prompts.** You type only the scene. The service adds:
  - the style (`src/modules/images/style.ts`);
  - the channel rules: no text, no people, respectful Indian setting.

  The full prompt is shown on every image's page.
- **Tags.** After an image is stored, `TAG_MODEL` is asked for 6–12 short tags (place, setting, time, weather, light, objects, mood, colors) as JSON.
  - If that call fails, the image gets keyword tags from the scene prompt instead, so nothing is left untagged.
  - Tags are lowercased and deduplicated.
  - Search needs every term to match the start of a word in some tag, so `rain kol` finds an image tagged "monsoon rain" and "kolkata".
- **Thumbnails.** Each image also gets two WebP copies, made with sharp: a 480 px thumbnail for the grids and a 1600 px preview for its page. The original is untouched.
- **Startup.** Images that predate thumbnails or tags get them on startup. That uses prompt keywords, never a paid call.
- **Spending money.** Paid actions ask for confirmation in a dialog. The server refuses anything that would go over `SPEND_CAP_USD`.
- **Deleting.**
  - Deleting an image removes its tags and animations.
  - Deleting an animation removes its clip.
  - Files are content-addressed, so a file is only removed from disk when no other row uses it.
  - "More like this" images made from a deleted image are kept; they just lose the link.
  - Cost-ledger rows are kept as spending history.
  - Anything still animating can't be deleted until it finishes, because Google keeps billing for it either way.
- **Resuming.**
  - Veo jobs are tracked by operation id. If the server restarts mid-job, it resumes polling instead of submitting (and paying) again.
  - Clicking Animate twice for the same image and prompt reuses the in-flight job.
  - Generations interrupted by a restart are marked `interrupted`.
- **Audio.** Veo always generates audio. The file is kept as returned and plays muted on the page; the renderer will strip it later.
- **Retention.** Google deletes Veo outputs after 2 days. The service downloads each clip as soon as it's ready.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check (public) |
| POST | `/api/login` / `/api/logout` | `{ password }`. Sets or clears the session cookie (only when login is on). |
| GET | `/api/config` | Provider, models, cost estimates, spend |
| POST | `/api/generations` | `{ scenePrompt?, stylePreset?, parentBatchId?, referenceImageId? }`. Starts a generation (202). |
| GET | `/api/generations/:id` | Poll a generation; when done, `images` holds the new image |
| GET | `/api/images?q=&limit=&offset=` | Images newest first, optionally filtered by tag search. Returns `{ items, total }`. |
| GET | `/api/tags` | Most-used tags with counts |
| GET / PATCH / DELETE | `/api/images/:id` | Read (with tags and prompts), update `{ notes?, tags? }`, or delete (with its animations) |
| GET | `/api/images/:id/motion-suggestion` | Suggested Veo motion prompt for the image's scene |
| GET | `/api/animations?imageId=` | Animations for one image (including failed ones), or all recent non-failed ones with their image's thumbnail and scene |
| POST | `/api/animations` | `{ imageId, motionPrompt? }`. Starts an animation (202). |
| GET / PATCH / DELETE | `/api/animations/:id` | Read, update `{ starred }` (Best), or delete |
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
  providers/   google/ (Gemini image, tagger, Veo), mock/, shared types + HTTP helper
  modules/     images/ (style presets, generation, tags, thumbnails), animation/ (motion prompts, Veo jobs)
  server/      Fastify routes + static files
web/           the page (plain HTML/CSS/JS)
test/
```
