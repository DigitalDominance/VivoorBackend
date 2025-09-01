
# Background Job Mode for /watermark

To avoid Heroku's 30s router timeout (H12), the `/watermark` endpoint now enqueues a background job and returns immediately with HTTP 202:

## Flow
1. **POST** `/watermark` (same form fields as before) ⇒ `{ ok, jobId, statusUrl, resultUrl }`
2. **GET** `statusUrl` until `resultReady: true`
3. **GET** `resultUrl` to download the MP4 (streamed). The file is deleted after download.

### Notes
- If you upload a file via `multipart/form-data` (`video` field), it is kept in `/tmp` for the background job and cleaned up after processing.
- If you send `videoUrl`, the worker downloads it directly.
- Jobs are kept for up to 1 hour if the result isn't downloaded (`JOB_TTL_MS`).

No other routes (WebSockets, /health) were changed.
