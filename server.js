/**
 * Watermark Backend (Express + FFmpeg)
 * - POST /watermark : add a PNG watermark to an MP4
 *   Accepts either an uploaded file ("video") or a remote URL ("videoUrl").
 *   Optional fields: position (br|bl|tr|tl), margin (px), wmWidth (px), filename (for the response name)
 * - GET /health     : simple health check
 *
 * Heroku notes:
 * - Requires FFmpeg buildpack. See README.md
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

const app = express();
app.set("x-powered-by", false);

// --- CORS ---
const ALLOWED_ORIGINS = new Set([
  "https://preview--vivoor-live-glow.lovable.app",
  "https://www.vivoor.xyz",
  "https://vivoor.xyz",
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

// --- Multer (uploads to tmpfs/ephemeral) ---
const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024, // default 300MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "video/mp4") cb(null, true);
    else cb(new Error("Only video/mp4 is accepted"));
  },
});

// Helpers
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
  const m = Number.isFinite(margin) ? margin : 24;
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

/**
 * Compose the -filter_complex for FFmpeg.
 * If wmWidthPx is provided, we pre-scale the watermark to that pixel width, maintaining AR.
 */
function makeFilter(position, margin, wmWidthPx) {
  const { x, y } = buildOverlayXY(position, margin);
  if (wmWidthPx && Number(wmWidthPx) > 0) {
    return `[1:v]scale=${Math.floor(Number(wmWidthPx))}:-1[wm];[0:v][wm]overlay=${x}:${y}:format=auto`;
  }
  // No pre-scale; use watermark as-is.
  return `[0:v][1:v]overlay=${x}:${y}:format=auto`;
}

async function runFfmpeg(inPath, wmPath, outPath, opts = {}) {
  const {
    position = "br",
    margin = 24,
    wmWidth = Number(process.env.WM_WIDTH_PX || 0), // 0 = no scaling
    preset = process.env.FFMPEG_PRESET || "veryfast",
    crf = Number(process.env.FFMPEG_CRF || 20),
    threads = Number(process.env.FFMPEG_THREADS || 0), // 0 lets ffmpeg decide
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
  if (threads > 0) {
    args.push("-threads", String(threads));
  }
  args.push(outPath);

  return await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });
}

function safeUnlink(p) {
  if (!p) return;
  fs.promises.unlink(p).catch(() => {});
}

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
 *
 * Watermark source:
 *  - WATERMARK_URL env (downloaded each time), OR
 *  - WATERMARK_PATH env (absolute path), OR
 *  - ./assets/logo.png (repo file)
 */
app.post("/watermark", upload.single("video"), async (req, res) => {
  let inputPath = null;
  let wmPath = null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wmk-"));
  const outPath = path.join(tmp, `out-${Date.now()}.mp4`);

  try {
    const { videoUrl, position, margin, wmWidth, filename } = req.body || {};

    // 1) Resolve video input
    if (req.file?.path) {
      inputPath = req.file.path;
    } else if (videoUrl) {
      inputPath = path.join(tmp, "input.mp4");
      await downloadToFile(videoUrl, inputPath);
    } else {
      return res.status(400).json({ error: "Provide 'video' file or 'videoUrl'." });
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

    // 4) Stream back as download
    const name = (filename && String(filename).trim()) || "watermarked.mp4";
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    const read = fs.createReadStream(outPath);
    read.pipe(res);
    read.on("close", () => {
      // cleanup after response ends
      safeUnlink(inputPath);
      if (process.env.WATERMARK_URL) safeUnlink(wmPath);
      safeUnlink(outPath);
      fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    });
  } catch (err) {
    console.error("[/watermark] error:", err);
    safeUnlink(inputPath);
    if (process.env.WATERMARK_URL) safeUnlink(wmPath);
    safeUnlink(outPath);
    fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Root
app.get("/", (_req, res) => {
  res.type("text").send("Vivoor Watermark API. POST /watermark to add a logo to an MP4.");
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[watermark] listening on :${PORT}`);
});
