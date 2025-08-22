# Vivoor Watermark Backend + WebSockets (Heroku-ready)

Adds a PNG watermark to an MP4 with FFmpeg and exposes per-stream WebSocket rooms.

## REST Endpoints
- `GET /health` → `{ ok: true }`
- `POST /watermark` → returns watermarked MP4

**POST /watermark (multipart/form-data)**
- `video` (File) OR `videoUrl` (string)
- `position` `"br" | "bl" | "tr" | "tl"` (default: `br`)
- `margin` number (px; default `24`)
- `wmWidth` number (px; optional scale)
- `filename` output filename (default `watermarked.mp4`)

Watermark source order:
1. `WATERMARK_URL` (downloaded per request)
2. `WATERMARK_PATH` (absolute path)
3. `./assets/logo.png` (default placeholder)

## WebSocket
- `wss://<host>/ws?streamId=<ID>`
- Each `streamId` is a room. Broadcasts stay in-room.
- Messages are JSON (`chat`, `status`, `ping`/`pong` supported by default).

## CORS
Allowed origins are configured in `server.js`:
- https://preview--vivoor-live-glow.lovable.app
- https://www.vivoor.xyz
- https://vivoor.xyz

## Heroku Deploy
```bash
heroku create vivoor-watermark-ws
heroku buildpacks:add heroku/nodejs
heroku buildpacks:add https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git

heroku config:set MAX_UPLOAD_MB=300 FFMPEG_PRESET=veryfast FFMPEG_CRF=20
# heroku config:set WATERMARK_URL="https://your.cdn/logo.png"

git init && git add . && git commit -m "vivoor watermark ws"
heroku git:remote -a vivoor-watermark-ws
git push heroku main
```
