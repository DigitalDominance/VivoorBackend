/**
 * Vivoor Watermark API + WebSockets (Heroku-ready)
 * - POST /watermark : add a PNG watermark to an MP4 (file upload or remote URL)
 * - GET  /health    : simple health check
 * - WS   /ws?streamId=<ID>&token=<optional> : per-stream rooms for chat/notifications
 *
 * Requires:
 * - FFmpeg installed (Heroku FFmpeg buildpack)
 * - Web dyno (Heroku supports WebSockets)
 */
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const http = require("http");
const { URL } = require("url");
const WebSocket = require("ws");

const app = express();
app.set("x-powered-by", false);

// === timeout tweak: 2 minutes (in ms) ===
const TWO_MIN_MS = 2 * 60 * 1000;

/* ----------------------------- C O R S ---------------------------------- */
const ALLOWED_ORIGINS = new Set([
  "https://preview--vivoor-live-glow.lovable.app",
  "https://www.vivoor.xyz",
  "https://vivoor.xyz",
  "https://qcowmxypihinteajhnjw.supabase.co",
]);
app.use(
  cors({
    origin: function (origin, cb) {
      if (!origin) return cb(null, true); // allow curl/postman
      cb(null, ALLOWED_ORIGINS.has(origin));
    },
  })
);

// Parse small JSON bodies (not used for file upload but fine for /health etc)
app.use(express.json({ limit: "100kb" }));

// === per-route timeout for /watermark (request + response) ===
app.use("/watermark", (req, res, next) => {
  // Extend socket timeouts for this route only
  req.setTimeout(TWO_MIN_MS);
  res.setTimeout(TWO_MIN_MS);
  next();
});

/* ---------------------------- U P L O A D S ------------------------------ */
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "video/mp4") cb(null, true);
    else cb(new Error("Only video/mp4 is accepted"));
  },
});

/* ------------------------------ H E L P E R S ---------------------------- */
function nowTs() { return Math.floor(Date.now() / 1000); }

async function downloadToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to fetch videoUrl: ${res.status}`);
  const nodeStream = Readable.fromWeb(res.body);
  const fileStream = fs.createWriteStream(outPath);
  await pipeline(nodeStream, fileStream);
}

function buildOverlayXY(position, margin) {
  const m = Number.isFinite(+margin) ? +margin : 24;
  switch (position) {
    case "tl": return { x: `${m}`, y: `${m}` };
    case "tr": return { x: `main_w-overlay_w-${m}`, y: `${m}` };
    case "bl": return { x: `${m}`, y: `main_h-overlay_h-${m}` };
    case "br":
    default:   return { x: `main_w-overlay_w-${m}`, y: `main_h-overlay_h-${m}` };
  }
}

function makeFilter(position, margin, wmWidthPx) {
  const { x, y } = buildOverlayXY(position, margin);
  if (wmWidthPx && Number(wmWidthPx) > 0) {
    return `[1:v]scale=${Math.floor(Number(wmWidthPx))}:-1[wm];[0:v][wm]overlay=${x}:${y}:format=auto`;
  }
  return `[0:v][1:v]overlay=${x}:${y}:format=auto`;
}

async function runFfmpeg(inPath, wmPath, outPath, opts = {}) {
  const {
    position = "br",
    margin = 24,
    wmWidth = Number(process.env.WM_WIDTH_PX || 0),
    // Use a more conservative preset by default. Ultrafast reduces memory usage
    // compared to veryfast, while still providing reasonable performance for
    // simple overlays. If the deployer wants to override this they can set
    // FFMPEG_PRESET in the environment.
    preset = process.env.FFMPEG_PRESET || "ultrafast",
    crf = Number(process.env.FFMPEG_CRF || 20),
    // Heroku dynos have limited memory. By default ffmpeg will use a thread per
    // core which can drastically increase memory usage (seen as 12 threads in
    // logs). Limit the number of encoding threads to 2 by default, unless
    // overridden via FFMPEG_THREADS. Using 1 or 2 threads greatly reduces
    // memory consumption while still allowing parallelism during encoding.
    threads = Number(process.env.FFMPEG_THREADS || 2),
  } = opts;

  const filter = makeFilter(position, Number(margin), wmWidth);
  const args = [
    "-y",
    "-i", inPath,
    "-i", wmPath,
    "-filter_complex", filter,
    "-c:v", "libx264",
    "-preset", preset,
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
  ];
  if (threads > 0) args.push("-threads", String(threads));
  args.push(outPath);

  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)));
  });
}

function safeUnlink(p) {
  if (!p) return;
  fs.promises.unlink(p).catch(() => {});
}

/* ------------------------- B A C K G R O U N D  J O B S ------------------------- */
/**
 * Minimal in-process job queue to avoid Heroku 30s router timeouts.
 * POST /watermark enqueues a job and returns { jobId } immediately.
 * Clients can poll /watermark/status/:id and download via /watermark/result/:id.
 * No external deps; data is kept in-memory and files in /tmp until download.
 */
const { randomUUID } = require("crypto");

const JOB_TTL_MS = 60 * 60 * 1000; // keep jobs around for up to 1 hour
const jobs = new Map(); // id -> { status, inputPath?, videoUrl?, opts, outputPath?, filename, error?, createdAt, updatedAt, progress }

function makeTmpDir() {
  const os = require("os"); const fs = require("fs"); const path = require("path");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wmk-job-"));
  return d;
}

function enqueueWatermarkJob(payload) {
  const id = randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    progress: 0,
    ...payload,
  };
  jobs.set(id, job);
  // process asynchronously so request can return immediately
  setImmediate(() => processWatermarkJob(id).catch(() => {}));
  return job;
}

async function processWatermarkJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "processing"; job.updatedAt = Date.now();

  const tmpRoot = makeTmpDir();
  let tmpInput = job.inputPath || null;
  let tmpWmPath = null;
  const outPath = path.join(tmpRoot, `out-${Date.now()}.mp4`);

  try {
    const { videoUrl, position, margin, wmWidth, filename } = job.opts || {};
    // Resolve input if using URL
    if (!tmpInput) {
      if (!videoUrl) throw new Error("Job missing input");
      tmpInput = path.join(tmpRoot, "input.mp4");
      await downloadToFile(videoUrl, tmpInput);
    }

    // Resolve watermark
    if (process.env.WATERMARK_URL) {
      tmpWmPath = path.join(tmpRoot, "wm.png");
      await downloadToFile(process.env.WATERMARK_URL, tmpWmPath);
    } else if (process.env.WATERMARK_PATH && fs.existsSync(process.env.WATERMARK_PATH)) {
      tmpWmPath = process.env.WATERMARK_PATH;
    } else {
      tmpWmPath = path.join(__dirname, "assets", "logo.png");
      if (!fs.existsSync(tmpWmPath)) throw new Error("Watermark not found. Set WATERMARK_URL or add assets/logo.png");
    }

    // Run ffmpeg
    await runFfmpeg(tmpInput, tmpWmPath, outPath, { position, margin, wmWidth });

    // Cleanup input + downloaded WM if applicable
    safeUnlink(tmpInput);
    if (process.env.WATERMARK_URL) safeUnlink(tmpWmPath);

    job.outputPath = outPath;
    job.filename = (filename && String(filename).trim()) || "watermarked.mp4";
    job.status = "completed";
    job.progress = 100;
    job.updatedAt = Date.now();

    // Schedule job directory cleanup after TTL if result not downloaded
    setTimeout(() => {
      const j = jobs.get(id);
      if (j && j.status === "completed" && j.outputPath && fs.existsSync(j.outputPath)) {
        safeUnlink(j.outputPath);
        try { fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
        jobs.delete(id);
      }
    }, JOB_TTL_MS);
  } catch (err) {
    job.status = "failed";
    job.error = String(err.message || err);
    job.updatedAt = Date.now();
    // Cleanup temp
    safeUnlink(tmpInput);
    if (tmpWmPath && process.env.WATERMARK_URL) safeUnlink(tmpWmPath);
    safeUnlink(outPath);
    try { fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}
/* ------------------------------------------------------------------------ */

/* -------------------------------- A P I ---------------------------------- */
app.get("/health", (_req, res) => {
  res.json({ ok: true, time: nowTs() });
});

/**
 * POST /watermark
 * FormData:
 *  - video (File)  [optional if videoUrl is provided]
 *  - videoUrl (string) [optional if 'video' provided]
 *  - position: "br" | "bl" | "tr" | "tl" (default: br)
 *  - margin: number px (default: 24)
 *  - wmWidth: number px (optional)
 *  - filename: desired download filename (optional, default "watermarked.mp4")
 * Watermark source resolution order:
 *  - WATERMARK_URL env, WATERMARK_PATH env, ./assets/logo.png
 */
app.post("/watermark", upload.single("video"), async (req, res) => {
  
  // Background job mode: enqueue and return a job id immediately (avoids Heroku 30s H12)
  let inputPath = null;
  try {
    const { videoUrl, position, margin, wmWidth, filename } = req.body || {};

    // If file uploaded, keep its temp path for the worker
    if (req.file?.path) {
      inputPath = req.file.path;
    }

    const job = enqueueWatermarkJob({
      inputPath,
      opts: { videoUrl, position, margin, wmWidth, filename },
    });

    res.status(202).json({
      ok: true,
      jobId: job.id,
      statusUrl: `/watermark/status/${job.id}`,
      resultUrl: `/watermark/result/${job.id}`
    });
  } catch (err) {
    // If enqueuing fails, make sure to remove uploaded temp file
    if (inputPath) safeUnlink(inputPath);
    console.error("[/watermark enqueue] error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }

});

app.get("/", (_req, res) => {
  res.type("text").send("Vivoor Watermark API + WebSockets. POST /watermark to add a logo to an MP4. WS at /ws?streamId=ID");
});

/* ----------------------------- W E B S O C K E T ------------------------- */
/**
 * WS endpoint: /ws?streamId=<ID>&token=<optional>
 * Each streamId is a "room". Broadcasts go to that room only.
 */
const server = http.createServer(app);

// === server-level timeouts set to 2 minutes ===
server.requestTimeout = TWO_MIN_MS;        // time allowed for the entire request/response cycle
server.headersTimeout = TWO_MIN_MS + 10000; // allow a bit more than requestTimeout for headers
server.keepAliveTimeout = TWO_MIN_MS;       // keep-alive sockets last up to 2 min

const wss = new WebSocket.Server({ noServer: true });
const rooms = new Map(); // streamId -> Set<ws>
const HEARTBEAT_MS = 25000;

function joinRoom(streamId, ws) {
  if (!rooms.has(streamId)) rooms.set(streamId, new Set());
  rooms.get(streamId).add(ws);
  ws._roomId = streamId;
}
function leaveRoom(ws) {
  const id = ws._roomId;
  if (!id) return;
  const set = rooms.get(id);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(id);
  }
  delete ws._roomId;
}
function broadcast(streamId, obj) {
  const set = rooms.get(streamId);
  if (!set) return;
  const msg = JSON.stringify(obj);
  for (const client of set) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}
function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws, request) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw || "{}"));
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
        return;
      }
      const streamId = ws._roomId;
      if (!streamId) return;
      broadcast(streamId, { ...msg, streamId, serverTs: Date.now() });
    } catch {}
  });
  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

server.on("upgrade", (req, socket, head) => {
  try {
    const origin = req.headers.origin || "";
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      socket.destroy();
      return;
    }
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== "/ws") { socket.destroy(); return; }
    const streamId = u.searchParams.get("streamId");
    if (!streamId) { socket.destroy(); return; }
    // TODO: validate ?token=... if you add auth
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      joinRoom(streamId, ws);
      ws.send(JSON.stringify({ type: "hello", streamId, serverTs: Date.now() }));
    });
  } catch {
    socket.destroy();
  }
});

// Heartbeat to keep connections healthy on proxies
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(interval));

/* --------------------------------- S T A R T ----------------------------- */
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[watermark+ws] listening on :${PORT}`);
});
