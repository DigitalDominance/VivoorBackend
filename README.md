# Vivoor Watermark Backend (Heroku-ready)

Add a PNG watermark to an MP4 with FFmpeg. Designed for short clips (e.g., 10–60s).

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /watermark` → returns a watermarked MP4 as a download.

### `POST /watermark`

Multipart **FormData** fields:

- `video` (File, **optional** if `videoUrl` provided)
- `videoUrl` (string, **optional** if `video` provided) — server downloads the MP4
- `position` (string) one of `br|bl|tr|tl` (default: `br`)
- `margin` (number) pixels from the chosen edge (default: `24`)
- `wmWidth` (number) **pixels** to scale the watermark width (keeps aspect ratio). If omitted, watermark is used as-is.
- `filename` (string) desired download filename (default: `watermarked.mp4`)

Watermark source resolution order:
1. `WATERMARK_URL` (downloaded for each request),
2. `WATERMARK_PATH` (absolute path inside container),
3. repo file `./assets/logo.png` (included here as a placeholder — replace with your real logo).

## Local dev

```bash
npm i
# Put your logo at ./assets/logo.png  (or set WATERMARK_URL)
npm start
```

Test with curl:
```bash
curl -F "video=@sample.mp4" -F "position=br" -F "margin=24" -o out.mp4 http://localhost:4000/watermark
```

## Deploy to Heroku

1) Create the app and add buildpacks (**Node.js first**, then **FFmpeg**):

```bash
heroku create vivoor-watermark
heroku buildpacks:add heroku/nodejs
heroku buildpacks:add https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git
```

2) (Optional) Configure env vars:

```bash
heroku config:set WATERMARK_URL="https://example.com/path/to/logo.png"
# or, if using the repo file:
# heroku config:set WATERMARK_PATH="/app/assets/logo.png"
heroku config:set MAX_UPLOAD_MB=300 FFMPEG_PRESET=veryfast FFMPEG_CRF=20
```

3) Deploy:

```bash
git init
git add .
git commit -m "v1 watermark backend"
heroku git:remote -a vivoor-watermark
git push heroku main
```

4) Verify:

```bash
heroku open
heroku logs --tail
```

## CORS

CORS is **restricted** to these origins:

- https://preview--vivoor-live-glow.lovable.app
- https://www.vivoor.xyz
- https://vivoor.xyz

You can modify the list in `server.js` (ALLOWED_ORIGINS).

## Frontend integration (Vite)

```ts
async function sendForWatermark(file: File) {
  const fd = new FormData();
  fd.append("video", file);
  fd.append("position", "br");  // br|bl|tr|tl
  fd.append("margin", "24");    // px
  fd.append("wmWidth", "180");  // px (optional)
  fd.append("filename", "clip.mp4");

  const res = await fetch("https://<your-heroku-app>.herokuapp.com/watermark", {
    method: "POST",
    body: fd,
    // No need for custom headers; browser sets multipart boundary.
  });

  if (!res.ok) throw new Error("Watermark failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "clip.mp4";
  a.click();
  URL.revokeObjectURL(url);
}
```

**Using a remote MP4 URL** (e.g., Livepeer clip `downloadUrl`):

```ts
async function watermarkFromUrl(mp4Url: string) {
  const fd = new FormData();
  fd.append("videoUrl", mp4Url);
  fd.append("position", "br");
  fd.append("margin", "24");
  // fd.append("wmWidth", "200");
  const res = await fetch("https://<your-heroku-app>.herokuapp.com/watermark", { method: "POST", body: fd });
  const blob = await res.blob();
  // ... download as above
}
```

## Notes

- Dyno filesystem is ephemeral; this service writes temp files only during processing.
- For large/long videos, consider moving to a worker with a queue. Short clips (≤60s) are ideal.
- FFmpeg overlay uses: `overlay=main_w-overlay_w-M : main_h-overlay_h-M` for bottom-right placement.
- If you see `ffmpeg: not found` on Heroku, check the FFmpeg buildpack order.
