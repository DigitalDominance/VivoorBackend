/**
 * Vivoor Watermark API + WebSockets (Heroku-ready)
 * - POST /watermark : add a PNG watermark to an MP4 (file upload or remote URL)
 * - GET  /health    : simple health check
 * - WS   /ws?streamId=<ID>&token=<optional> : per-stream rooms for chat/notifications
 *
 * Requires:
 * - FFmpeg installed (Heroku FFmpeg buildpack)
 * - Web dyno (Heroku supports WebSockets)
 *
 * This version avoids Heroku H12 (30s) by:
 *  - Streaming FFmpeg output directly to the HTTP response (pipe:1)
 *  - Flushing headers immediately (res.flushHeaders()) so the router sees a response quickly
 *  - Using fragmented MP4 flags so output can start before the file is complete
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
function nowTs() {
  return Math.floor(Date.now() / 1000);
}

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
    case "tl":
      return { x: `${m}`, y: `${m}` };
    case "tr":
      return { x: `main_w-overlay_w-${m}`, y: `${m}` };
    case "bl":
      return { x: `${m}`, y: `main_h-overlay_h-${m}` };
    case "br":
    default:
      return { x: `main_w-overlay_w-${m}`, y: `main_h-overlay_h-${m}` };
  }
}

function makeFilter(position, margin, wmWidthPx) {
  const { x, y } = buildOverlayXY(position, margin);
  if (wmWidthPx && Number(wmWidthPx) > 0) {
    return `[1:v]scale=${Math.floor(Number(wmWidthPx))}:-1[wm];[0:v][wm]overlay=${x}:${y}:format=auto`;
  }
  return `[0:v][1:v]overlay=${x}:${y}:format=auto`;
}

/**
 * Run FFmpeg and stream output directly to HTTP response.
 * - If input is a URL, pass it directly to FFmpeg (no full pre-download).
 * - If input is an uploaded file, use its path.
 * - Watermark image can be a URL (downloaded to tmp), a local path, or default asset.
 */
async function runFfmpegToHttp({
  inputPathOrUrl,
  watermarkPathOrUrl,
  res,
  position = "br",
  margin = 24,
  wmWidth = Number(process.env.WM_WIDTH_PX || 0),
  preset = process.env.FFMPEG_PRESET || "ultrafast",
  crf = Number(process.env.FFMPEG_CRF || 20),
  threads = Number(process.env.FFMPEG_THREADS || 2),
  filename = "watermarked.mp4",
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wmk-"));
  let wmPath = null;
  let cleanupWm = false;

  try {
    // Resolve watermark to a local path if needed (downloading only if URL is provided)
    if (watermarkPathOrUrl?.startsWith?.("http")) {
      wmPath = path.join(tmp, "wm.png");
      await downloadToFile(watermarkPathOrUrl, wmPath);
      cleanupWm = true;
    } else if (watermarkPathOrUrl && fs.existsSync(watermarkPathOrUrl)) {
      wmPath = watermarkPathOrUrl;
    } else {
      wmPath = path.join(__dirname, "assets", "logo.png");
      if (!fs.existsSync(wmPath)) {
        throw new Error("Watermark not found. Set WATERMARK_URL or add assets/logo.png");
      }
    }

    const filter = makeFilter(position, Number(margin), wmWidth);

    // Build FFmpeg args:
    // - Input 0: video (can be URL or file)
    // - Input 1: PNG watermark (local path)
    // - Use fragmented MP4 so we can start sending bytes early
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPathOrUrl, // URL or file path
      "-i",
      wmPath,
      "-filter_complex",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "frag_keyframe+empty_moov+default_base_moof",
      "-f",
      "mp4",
      "pipe:1",
    ];
    if (threads > 0) {
      args.splice(args.length - 2, 0, "-threads", String(threads)); // insert before -f mp4
    }

    // Set headers *before* we start FFmpeg, and flush them to beat the 30s router timeout.
    res.status(200);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    // Ensure Node won't abort the socket early (Heroku still needs first bytes within 30s).
    res.setTimeout(2 * 60 * 1000);

    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    // Spawn FFmpeg and pipe stdout directly to the client
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "inherit"] });

    // If the client disconnects, stop FFmpeg
    const abort = () => {
      try {
        p.kill("SIGINT");
      } catch {}
    };
    res.on("close", abort);
    res.on("error", abort);

    // Pipe FFmpeg output straight to response
    p.stdout.pipe(res);

    await new Promise((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
  } finally {
    // Cleanup downloaded watermark and temp dir
    if (cleanupWm) {
      fs.promises.unlink(wmPath).catch(() => {});
    }
    fs.promises.rm(path.dirname(wmPath || path.join(os.tmpdir(), "wmk-dummy")), { recursive: true, force: true }).catch(() => {});
  }
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
 *
 * This endpoint now streams FFmpeg output directly to the client to avoid H12.
 * If 'videoUrl' is provided, we pass it directly to FFmpeg (no full pre-download).
 */
app.post("/watermark", upload.single("video"), async (req, res) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wmk-"));
  let inputPath = null;
  let wmPath = null;

  try {
    const { videoUrl, position, margin, wmWidth, filename } = req.body || {};

    // Resolve input:
    //  - If file was uploaded, use its path.
    //  - Else if videoUrl provided, pass it directly to FFmpeg (no pre-download).
    //  - Else error.
    let inputPathOrUrl = null;
    if (req.file?.path) {
      inputPathOrUrl = req.file.path;
    } else if (videoUrl) {
      inputPathOrUrl = String(videoUrl);
    } else {
      return res.status(400).json({ error: "Provide 'video' or 'videoUrl'." });
    }

    // Resolve watermark source (if URL in env, download it once; else use file)
    let watermarkPathOrUrl = null;
    if (process.env.WATERMARK_URL) {
      watermarkPathOrUrl = process.env.WATERMARK_URL; // will be downloaded in runner
    } else if (process.env.WATERMARK_PATH && fs.existsSync(process.env.WATERMARK_PATH)) {
      watermarkPathOrUrl = process.env.WATERMARK_PATH;
    } else {
      wmPath = path.join(__dirname, "assets", "logo.png");
      if (!fs.existsSync(wmPath)) {
        return res.status(500).json({ error: "Watermark not found. Set WATERMARK_URL or add assets/logo.png" });
      }
      watermarkPathOrUrl = wmPath;
    }

    // Stream FFmpeg output directly to the response (no temp output file).
    await runFfmpegToHttp({
      inputPathOrUrl,
      watermarkPathOrUrl,
      res,
      position: position || "br",
      margin: Number.isFinite(+margin) ? +margin : 24,
      wmWidth: Number.isFinite(+wmWidth) ? +wmWidth : Number(process.env.WM_WIDTH_PX || 0),
      preset: process.env.FFMPEG_PRESET || "ultrafast",
      crf: Number(process.env.FFMPEG_CRF || 20),
      threads: Number(process.env.FFMPEG_THREADS || 2),
      filename: (filename && String(filename).trim()) || "watermarked.mp4",
    });

    // NOTE: runFfmpegToHttp handles piping and ending the response. We do not write more here.
  } catch (err) {
    console.error("[/watermark] error:", err);
    // If headers already sent (we flushed), just destroy the socket so the client sees an error.
    if (res.headersSent) {
      try {
        res.destroy(err);
      } catch {}
      return;
    }
    return res.status(500).json({ error: String(err.message || err) });
  } finally {
    // Cleanup uploaded input file if present
    safeUnlink(inputPath);
    // best-effort cleanup temp dir
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
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
const wss = new WebSocket.Server({ noServer: true });

// Optional: increase server timeouts so Node won't kill long streams (Heroku still requires first byte < 30s).
server.requestTimeout = 2 * 60 * 1000; // 2 minutes
server.headersTimeout = 2 * 60 * 1000;

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
function heartbeat() {
  this.isAlive = true;
}

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
    if (u.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const streamId = u.searchParams.get("streamId");
    if (!streamId) {
      socket.destroy();
      return;
    }
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
