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
  let inputPath = null;
  let wmPath = null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wmk-"));
  const outPath = path.join(tmp, `out-${Date.now()}.mp4`);

  try {
    const { videoUrl, position, margin, wmWidth, filename } = req.body || {};

    // 1) Resolve input video
    if (req.file?.path) {
      inputPath = req.file.path;
    } else if (videoUrl) {
      inputPath = path.join(tmp, "input.mp4");
      await downloadToFile(videoUrl, inputPath);
    } else {
      return res.status(400).json({ error: "Provide 'video' or 'videoUrl'." });
    }

    // 2) Resolve watermark
    if (process.env.WATERMARK_URL) {
      wmPath = path.join(tmp, "wm.png");
      await downloadToFile(process.env.WATERMARK_URL, wmPath);
    } else if (process.env.WATERMARK_PATH && fs.existsSync(process.env.WATERMARK_PATH)) {
      wmPath = process.env.WATERMARK_PATH;
    } else {
      wmPath = path.join(__dirname, "assets", "logo.png");
      if (!fs.existsSync(wmPath)) {
        return res.status(500).json({ error: "Watermark not found. Set WATERMARK_URL or add assets/logo.png" });
      }
    }

    // 3) Run ffmpeg
    await runFfmpeg(inputPath, wmPath, outPath, { position, margin, wmWidth });

    /*
     * At this point FFmpeg has finished and the output file has been flushed to disk. We
     * no longer need the input video or any downloaded watermark asset to remain on
     * disk. Removing these immediately frees up disk space and allows the kernel to
     * release any associated caches, which can help prevent memory bloat on Heroku.
     */
    safeUnlink(inputPath);
    // Only remove the downloaded watermark if WATERMARK_URL was used. When using
    // WATERMARK_PATH or the built-in asset the file lives outside of the temp
    // directory and should not be deleted.
    if (process.env.WATERMARK_URL) safeUnlink(wmPath);

    // 4) Stream back the result. Use a read stream so the file is not buffered
    // into memory. Once the response is finished we clean up the output file and
    // temporary directory.
    const name = (filename && String(filename).trim()) || "watermarked.mp4";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    const readStream = fs.createReadStream(outPath);
    readStream.pipe(res);

    const cleanup = () => {
      // Remove the watermarked file itself. This happens after the file has
      // finished streaming to the client. Using safeUnlink ensures any errors
      // during deletion are ignored.
      safeUnlink(outPath);
      // Remove the temporary directory created for this request. This forces
      // removal even if there are lingering handles.
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    };
    // When the read stream ends normally the 'close' event fires. On some
    // connections Express will emit 'finish' on the response instead. Listen
    // to both to ensure cleanup always occurs.
    readStream.on("close", cleanup);
    res.on("finish", cleanup);
  } catch (err) {
    console.error("[/watermark] error:", err);
    safeUnlink(inputPath);
    if (process.env.WATERMARK_URL) safeUnlink(wmPath);
    safeUnlink(outPath);
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
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
