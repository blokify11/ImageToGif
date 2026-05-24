const express = require("express");
require("dotenv").config();
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, execFile } = require("child_process");
const http = require("http");

// ─── Admin & Request Logging ──────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "nigga";
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "requests.json");
const MAX_LOG_ENTRIES = 5000;

let requestLogs = [];
fs.mkdirSync(LOG_DIR, { recursive: true });
try {
  if (fs.existsSync(LOG_FILE)) {
    const raw = fs.readFileSync(LOG_FILE, "utf8");
    requestLogs = JSON.parse(raw);
    if (!Array.isArray(requestLogs)) requestLogs = [];
  }
} catch (e) {
  requestLogs = [];
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

let saveTimer = null;
function logRequest(entry) {
  requestLogs.unshift(entry);
  if (requestLogs.length > MAX_LOG_ENTRIES) requestLogs.length = MAX_LOG_ENTRIES;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.promises.writeFile(LOG_FILE, JSON.stringify(requestLogs), "utf8").catch(() => {});
  }, 2000);
}

function adminAuth(req, res, next) {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      if (sep !== -1 && decoded.slice(sep + 1) === ADMIN_TOKEN) {
        return next();
      }
    } catch (_) {}
  }
  res.set("WWW-Authenticate", 'Basic realm="ImageToGif Admin"');
  return res.status(401).send("Unauthorized");
}
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = "/imagetogif";
const GIF_DIR = path.join(__dirname, "gifs");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(GIF_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024,
  },
});

const DISCORD_GIF_LIMIT_BYTES = 10 * 1024 * 1024;
const discordJobs = new Map();
const DISCORD_JOB_TTL_MS = 15 * 60 * 1000;

function bytesToMb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      return resolve({ stdout, stderr });
    });
  });
}

function parseFrameRate(value) {
  if (!value || value === "0/0") return null;
  const [rawNum, rawDen] = String(value).split("/");
  const num = Number(rawNum);
  const den = Number(rawDen || 1);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

async function getGifFrameRate(inputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      inputPath,
    ]);
    const stream = JSON.parse(stdout)?.streams?.[0] || {};
    return parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
  } catch (_) {
    return null;
  }
}

async function getGifDurationSec(inputPath) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_frames,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      inputPath,
    ]);
    const stream = JSON.parse(stdout)?.streams?.[0] || {};
    const frames = parseInt(stream.nb_frames, 10);
    const fps = parseFrameRate(stream.avg_frame_rate) || parseFrameRate(stream.r_frame_rate);
    if (frames > 0 && fps > 0) return frames / fps;
    return null;
  } catch (_) {
    return null;
  }
}

function buildDiscordGifCandidates(sourceFps) {
  const originalFps = Math.max(8, Math.min(30, Math.round(sourceFps || 20)));
  const fpsLevels = [originalFps, 30, 24, 20, 18, 15, 12, 10, 8, 6, 4]
    .filter((fps) => fps <= originalFps)
    .filter((fps, index, list) => list.indexOf(fps) === index);
  const widths = [720, 640, 560, 480, 420, 360, 320, 280, 240, 200, 160, 120];
  const colors = [256, 192, 128, 64, 32];
  const candidates = [];

  for (const fps of fpsLevels) {
    for (const width of widths) {
      for (const colorCount of colors) {
        candidates.push({ fps, width, colorCount });
      }
    }
  }

  return candidates;
}

function runFfmpeg(args, totalDurationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", args);
    let stderr = "";
    let lineBuffer = "";

    ffmpeg.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof onProgress === "function" && totalDurationSec > 0) {
        lineBuffer += text;
        const parts = lineBuffer.split(/\r|\n/);
        lineBuffer = parts.pop();
        for (const line of parts) {
          const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
          if (m) {
            const t = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
            onProgress(Math.min(0.99, t / totalDurationSec));
          }
        }
      }
    });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) return resolve();
      return reject(new Error(`ffmpeg Fehler (Code ${code}): ${stderr}`));
    });
  });
}

async function optimizeGifForDiscord(gifBuffer, tempBaseName, onProgress) {
  if (gifBuffer.length <= DISCORD_GIF_LIMIT_BYTES) {
    return {
      buffer: gifBuffer,
      originalBytes: gifBuffer.length,
      optimizedBytes: gifBuffer.length,
      unchanged: true,
    };
  }

  const tempInput = path.join(os.tmpdir(), `${tempBaseName}.input.gif`);
  const tempOutput = path.join(os.tmpdir(), `${tempBaseName}.discord.gif`);
  let best = null;

  try {
    await fs.promises.writeFile(tempInput, gifBuffer);
    const sourceFps = await getGifFrameRate(tempInput);
    const gifDurationSec = await getGifDurationSec(tempInput);
    const candidates = buildDiscordGifCandidates(sourceFps);

    for (const [index, candidate] of candidates.entries()) {
      await Promise.allSettled([fs.promises.unlink(tempOutput)]);
      const filter = [
        `fps=${candidate.fps},scale='min(${candidate.width},iw)':-2:flags=lanczos,split[s0][s1]`,
        `[s0]palettegen=stats_mode=diff:max_colors=${candidate.colorCount}[p]`,
        "[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      ].join(";");

      await runFfmpeg(
        ["-y", "-i", tempInput, "-lavfi", filter, "-loop", "0", tempOutput],
        gifDurationSec,
        (fraction) => {
          if (typeof onProgress === "function") {
            onProgress({
              currentStep: index + 1,
              totalSteps: candidates.length,
              percent: Math.max(1, Math.min(99, Math.round(fraction * 100))),
              candidate: {
                fps: candidate.fps,
                width: candidate.width,
                colors: candidate.colorCount,
                sizeMb: best ? bytesToMb(best.optimizedBytes) : bytesToMb(gifBuffer.length),
              },
              phase: "running",
            });
          }
        }
      );

      const outputBuffer = await fs.promises.readFile(tempOutput);
      const result = {
        buffer: outputBuffer,
        originalBytes: gifBuffer.length,
        optimizedBytes: outputBuffer.length,
        fps: candidate.fps,
        width: candidate.width,
        colors: candidate.colorCount,
        sourceFps: sourceFps ? Math.round(sourceFps * 10) / 10 : null,
      };

      if (!best || outputBuffer.length < best.optimizedBytes) {
        best = result;
      }

      if (outputBuffer.length <= DISCORD_GIF_LIMIT_BYTES) {
        return result;
      }
    }

    return best;
  } finally {
    await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
  }
}

function scheduleDiscordJobCleanup(jobId) {
  setTimeout(() => {
    const job = discordJobs.get(jobId);
    if (job && (job.status === "done" || job.status === "error")) {
      discordJobs.delete(jobId);
    }
  }, DISCORD_JOB_TTL_MS).unref?.();
}

function createDiscordJob(files) {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    totalFiles: files.length,
    completedFiles: 0,
    currentFileIndex: 0,
    currentFileName: files[0]?.originalname || null,
    currentFileProgress: 0,
    progress: 0,
    etaMs: null,
    elapsedMs: 0,
    message: files.length > 0 ? `Warte auf Start von ${files[0].originalname} ...` : "Warte auf Start ...",
    results: null,
    error: null,
  };

  discordJobs.set(id, job);
  return job;
}

function updateDiscordJob(job, patch) {
  Object.assign(job, patch);
  return job;
}

function calculateEtaMs(startedAt, progress, step) {
  if (!startedAt) {
    return null;
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);
  if (elapsedMs < 2000) {
    return null;
  }

  if (
    step &&
    Number.isFinite(step.currentStep) &&
    step.currentStep > 0 &&
    Number.isFinite(step.originalSizeMb) &&
    Number.isFinite(step.candidate?.sizeMb)
  ) {
    const reducedMb = step.originalSizeMb - step.candidate.sizeMb;
    const remainingMb = step.candidate.sizeMb - 10;

    if (remainingMb <= 0) {
      return 0;
    }

    if (reducedMb > 0) {
      const averageStepMs = elapsedMs / step.currentStep;
      const projectedRemainingSteps = Math.max(1, remainingMb / reducedMb * step.currentStep);
      return Math.round(averageStepMs * projectedRemainingSteps);
    }
  }

  if (!Number.isFinite(progress) || progress <= 0 || progress >= 100) {
    return null;
  }

  return Math.round((elapsedMs * (100 - progress)) / progress);
}

function buildFileMeta(optimized) {
  return {
    originalMb: bytesToMb(optimized.originalBytes),
    optimizedMb: bytesToMb(optimized.optimizedBytes),
    targetMb: 10,
    withinLimit: optimized.optimizedBytes <= DISCORD_GIF_LIMIT_BYTES,
    unchanged: !!optimized.unchanged,
    fps: optimized.fps || null,
    sourceFps: optimized.sourceFps || null,
    width: optimized.width || null,
    colors: optimized.colors || null,
  };
}

async function persistGifBuffer(gifBuffer, protocol, host) {
  const id = crypto.randomUUID();
  const fileName = `${id}.gif`;
  const targetPath = path.join(GIF_DIR, fileName);

  await fs.promises.writeFile(targetPath, gifBuffer);

  const relativeUrl = `${BASE_PATH}/gifs/${fileName}`;
  const url = host ? `${protocol}://${host}${relativeUrl}` : relativeUrl;
  return { url };
}

async function processUploadedFiles(files, mode, protocol, host, progressHandler) {
  const results = [];

  for (const [index, file] of files.entries()) {
    const isImage = file.mimetype.startsWith("image/");
    const isVideo = file.mimetype.startsWith("video/");
    const isGif = file.mimetype === "image/gif" || file.originalname.toLowerCase().endsWith(".gif");

    if (mode === "discord10mb" && !isGif) {
      throw Object.assign(new Error("Für Discord 10 MB bitte nur GIF-Dateien hochladen."), { statusCode: 400 });
    }

    if (mode !== "discord10mb" && !isImage && !isVideo) {
      throw Object.assign(new Error("Bitte nur Bild- oder Videodateien hochladen."), { statusCode: 400 });
    }

    progressHandler?.({
      fileIndex: index,
      fileName: file.originalname,
      filePercent: 0,
      message:
        mode === "discord10mb"
          ? `${file.originalname} wird fuer Discord komprimiert ...`
          : `${file.originalname} wird in GIF umgewandelt ...`,
    });

    let gifBuffer;
    let meta = null;

    if (mode === "discord10mb") {
      const tempBaseName = `imagetogif-discord-${crypto.randomUUID()}`;
      const optimized = await optimizeGifForDiscord(file.buffer, tempBaseName, (step) => {
        progressHandler?.({
          fileIndex: index,
          fileName: file.originalname,
          filePercent: step.percent,
          step: {
            ...step,
            originalSizeMb: bytesToMb(file.buffer.length),
          },
          message: `${file.originalname}: Versuch ${step.currentStep}/${step.totalSteps}`,
        });
      });

      if (!optimized?.buffer) {
        throw Object.assign(new Error("GIF konnte nicht unter 10 MB optimiert werden."), { statusCode: 500 });
      }

      if (optimized.optimizedBytes > DISCORD_GIF_LIMIT_BYTES) {
        throw Object.assign(
          new Error(`GIF ist selbst mit starker Komprimierung noch ${bytesToMb(optimized.optimizedBytes)} MB groß.`),
          { statusCode: 422 }
        );
      }

      gifBuffer = optimized.buffer;
      meta = buildFileMeta(optimized);
    } else if (isImage) {
      gifBuffer = await sharp(file.buffer)
        .rotate()
        .resize({
          width: 720,
          height: 720,
          fit: "inside",
          withoutEnlargement: true,
        })
        .gif({
          effort: 7,
        })
        .toBuffer();
    } else {
      const tempBaseName = `imagetogif-${crypto.randomUUID()}`;
      gifBuffer = await convertVideoToGif(file.buffer, tempBaseName);
    }

    const persisted = await persistGifBuffer(gifBuffer, protocol, host);
    results.push({ ...persisted, meta });

    progressHandler?.({
      fileIndex: index,
      fileName: file.originalname,
      filePercent: 100,
      message: `${file.originalname} ist fertig.`,
    });
  }

  return results;
}

async function runDiscordJob(job, files, protocol, host) {
  const startedAt = Date.now();

  updateDiscordJob(job, {
    status: "processing",
    startedAt,
    elapsedMs: 0,
    etaMs: null,
    message: files.length > 0 ? `${files[0].originalname} wird vorbereitet ...` : "Verarbeitung gestartet ...",
  });

  try {
    let maxProgress = 0;
    const results = await processUploadedFiles(files, "discord10mb", protocol, host, ({
      fileIndex,
      fileName,
      filePercent,
      step,
      message,
    }) => {
      const totalFiles = Math.max(files.length, 1);
      const completedFiles = Math.min(fileIndex, files.length);
      const fileProgressRatio =
        step && Number.isFinite(step.percent)
          ? Math.max(0, Math.min(1, step.percent / 100))
          : Math.max(0, Math.min(1, filePercent / 100));
      const preciseProgress = ((fileIndex + fileProgressRatio) / totalFiles) * 100;
      const safePreciseProgress = Math.max(0, Math.min(100, preciseProgress));
      let safeProgress =
        safePreciseProgress > 0 && safePreciseProgress < 100
          ? Math.max(1, Math.min(99, Math.ceil(safePreciseProgress)))
          : Math.max(0, Math.min(100, Math.round(safePreciseProgress)));
      if (safeProgress < 100) {
        maxProgress = Math.max(maxProgress, safeProgress);
        safeProgress = maxProgress;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);

      updateDiscordJob(job, {
        currentFileIndex: fileIndex,
        currentFileName: fileName,
        currentFileProgress: filePercent,
        completedFiles,
        progress: safeProgress,
        elapsedMs,
        etaMs: calculateEtaMs(startedAt, safePreciseProgress, step),
        message,
      });
    });

    updateDiscordJob(job, {
      status: "done",
      results,
      progress: 100,
      completedFiles: files.length,
      currentFileProgress: 100,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      etaMs: 0,
      message: `${results.length} GIF(s) Discord-ready komprimiert.`,
    });
  } catch (error) {
    updateDiscordJob(job, {
      status: "error",
      elapsedMs: Math.max(0, Date.now() - startedAt),
      etaMs: null,
      error: error.message || "Unbekannter Fehler.",
      message: error.message || "Unbekannter Fehler.",
    });
  } finally {
    scheduleDiscordJobCleanup(job.id);
  }
}

function convertVideoToGif(videoBuffer, tempBaseName) {
  const tempInput = path.join(os.tmpdir(), `${tempBaseName}.input`);
  const tempOutput = path.join(os.tmpdir(), `${tempBaseName}.gif`);

  return new Promise(async (resolve, reject) => {
    try {
      await fs.promises.writeFile(tempInput, videoBuffer);

      const ffmpeg = spawn("ffmpeg", [
        "-y",
        "-i",
        tempInput,
        "-vf",
        "fps=12,scale='min(720,iw)':-2:flags=lanczos",
        "-loop",
        "0",
        tempOutput,
      ]);

      let stderr = "";
      ffmpeg.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      ffmpeg.on("error", async (error) => {
        await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
        reject(error);
      });

      ffmpeg.on("close", async (code) => {
        try {
          if (code !== 0) {
            await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
            return reject(new Error(`ffmpeg Fehler (Code ${code}): ${stderr}`));
          }

          const gifBuffer = await fs.promises.readFile(tempOutput);
          await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
          return resolve(gifBuffer);
        } catch (error) {
          await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
          return reject(error);
        }
      });
    } catch (error) {
      await Promise.allSettled([fs.promises.unlink(tempInput), fs.promises.unlink(tempOutput)]);
      reject(error);
    }
  });
}

// Bots/Crawler die GIF-Links vorschau-fetchen (Discord, Telegram, Slack, Twitter, etc.) werden nicht geloggt
const BOT_UA_PATTERN = /discordbot|telegrambot|slackbot|twitterbot|facebot|linkedinbot|whatsapp|bot\/|crawler|spider|preview|embed|unfurl/i;

app.use(BASE_PATH + "/gifs", (req, res, next) => {
  const ua = req.headers["user-agent"] || "";
  if (!BOT_UA_PATTERN.test(ua)) {
    logRequest({
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: "gif",
      ip: getClientIp(req),
      method: req.method,
      path: req.path,
      ua,
      ref: req.headers["referer"] || "",
      lang: req.headers["accept-language"] || "",
      encoding: req.headers["accept-encoding"] || "",
      dnt: req.headers["dnt"] || "",
      sec_ua: req.headers["sec-ch-ua"] || "",
      sec_ua_mobile: req.headers["sec-ch-ua-mobile"] || "",
      sec_ua_platform: req.headers["sec-ch-ua-platform"] || "",
      sec_fetch_site: req.headers["sec-fetch-site"] || "",
      sec_fetch_mode: req.headers["sec-fetch-mode"] || "",
      sec_fetch_dest: req.headers["sec-fetch-dest"] || "",
    });
  }
  next();
});
app.use(BASE_PATH + "/gifs", express.static(GIF_DIR));

// CORS für cross-origin Requests von blokify.net (Discord-Upload via upload.blokify.net)
app.use((req, res, next) => {
  const allowed = ["https://blokify.net", "https://upload.blokify.net"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Sorgt fuer konsistente URL mit Trailing Slash.
app.use((req, res, next) => {
  if (req.path === BASE_PATH) {
    return res.redirect(301, BASE_PATH + "/");
  }
  return next();
});

// Loggt alle Anfragen (außer admin und gifs – die werden separat geloggt)
app.use(BASE_PATH, (req, res, next) => {
  if (!req.path.startsWith("/admin") && !req.path.startsWith("/gifs") && req.path !== "/auth/beacon" && req.path !== "/auth/callback") {
    logRequest({
      id: crypto.randomUUID(),
      ts: Date.now(),
      type: req.path.startsWith("/api/") ? "api" : "page",
      ip: getClientIp(req),
      method: req.method,
      path: req.path,
      ua: req.headers["user-agent"] || "",
      ref: req.headers["referer"] || "",
      lang: req.headers["accept-language"] || "",
      encoding: req.headers["accept-encoding"] || "",
      dnt: req.headers["dnt"] || "",
      sec_ua: req.headers["sec-ch-ua"] || "",
      sec_ua_mobile: req.headers["sec-ch-ua-mobile"] || "",
      sec_ua_platform: req.headers["sec-ch-ua-platform"] || "",
      sec_fetch_site: req.headers["sec-fetch-site"] || "",
      sec_fetch_mode: req.headers["sec-fetch-mode"] || "",
      sec_fetch_dest: req.headers["sec-fetch-dest"] || "",
    });
  }
  next();
});

app.use(BASE_PATH, express.json({ limit: "16kb" }));

// Beacon – empfängt Client-seitige Browser/Gerät-Infos und merged sie in den neuesten Log-Eintrag der IP
app.post(BASE_PATH + "/api/beacon", (req, res) => {
  const ip = getClientIp(req);
  const data = req.body;
  if (data && typeof data === "object") {
    const entry = requestLogs.find((l) => l.ip === ip && l.type === "page" && Date.now() - l.ts < 30000);
    if (entry) {
      entry.client = {
        screenW: data.screenW,
        screenH: data.screenH,
        innerW: data.innerW,
        innerH: data.innerH,
        dpr: data.dpr,
        colorDepth: data.colorDepth,
        tz: data.tz,
        lang: data.lang,
        langs: data.langs,
        platform: data.platform,
        vendor: data.vendor,
        touch: data.touch,
        maxTouch: data.maxTouch,
        cores: data.cores,
        memory: data.memory,
        cookies: data.cookies,
        online: data.online,
        connection: data.connection,
        connectionSpeed: data.connectionSpeed,
        pdfPlugin: data.pdfPlugin,
        javaEnabled: data.javaEnabled,
        doNotTrack: data.doNotTrack,
      };
    }
  }
  res.sendStatus(204);
});

app.use(
  BASE_PATH,
  express.static(PUBLIC_DIR, {
    etag: false,
    lastModified: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
    },
  })
);

app.post(BASE_PATH + "/api/convert", upload.array("image", 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Keine Dateien empfangen." });
    }

    const mode = req.body?.mode === "discord10mb" ? "discord10mb" : "gif";
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const results = await processUploadedFiles(req.files, mode, protocol, host);

    return res.json({ success: true, mode, results });
  } catch (error) {
    console.error("Konvertierungsfehler:", error);
    if (String(error.message || "").includes("ffmpeg")) {
      return res.status(500).json({ error: "Video-Konvertierung fehlgeschlagen. ffmpeg verfuegbar?" });
    }
    return res.status(error.statusCode || 500).json({ error: error.message || "Konvertierung fehlgeschlagen." });
  }
});

// Chunked-Upload: empfängt einzelne Chunks und speichert sie temporär
const chunkUploadStorage = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const pendingChunks = new Map(); // uploadId -> { total, received, chunks: Buffer[], originalname, mimetype }

app.post(BASE_PATH + "/api/chunk-upload", chunkUploadStorage.single("chunk"), (req, res) => {
  try {
    const { uploadId, chunkIndex, totalChunks, originalname, mimetype } = req.body;
    if (!uploadId || chunkIndex === undefined || !totalChunks || !req.file) {
      return res.status(400).json({ error: "Ungültige Chunk-Daten." });
    }
    const idx = parseInt(chunkIndex, 10);
    const total = parseInt(totalChunks, 10);
    if (!pendingChunks.has(uploadId)) {
      pendingChunks.set(uploadId, { total, received: 0, chunks: new Array(total), originalname, mimetype });
      setTimeout(() => pendingChunks.delete(uploadId), 30 * 60 * 1000);
    }
    const entry = pendingChunks.get(uploadId);
    entry.chunks[idx] = req.file.buffer;
    entry.received += 1;
    if (entry.received === entry.total) {
      return res.json({ status: "complete" });
    }
    return res.json({ status: "ok", received: entry.received, total: entry.total });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post(BASE_PATH + "/api/convert-discord-job", upload.array("image", 20), async (req, res) => {
  try {
    let files = req.files || [];

    // Chunked-Upload: uploadIds als JSON-Array im Formfeld "uploadIds"
    if (req.body?.uploadIds) {
      const uploadIds = JSON.parse(req.body.uploadIds);
      const assembled = [];
      for (const uploadId of uploadIds) {
        const entry = pendingChunks.get(uploadId);
        if (!entry || entry.received !== entry.total) {
          return res.status(400).json({ error: `Upload ${uploadId} unvollständig.` });
        }
        const buffer = Buffer.concat(entry.chunks);
        assembled.push({
          buffer,
          originalname: entry.originalname,
          mimetype: entry.mimetype,
          size: buffer.length,
        });
        pendingChunks.delete(uploadId);
      }
      files = assembled;
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "Keine Dateien empfangen." });
    }

    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const job = createDiscordJob(files);

    runDiscordJob(job, req.files, protocol, host).catch((error) => {
      console.error("Fehler bei Discord-Job:", error);
      updateDiscordJob(job, {
        status: "error",
        error: error.message || "Konvertierung fehlgeschlagen.",
        message: error.message || "Konvertierung fehlgeschlagen.",
      });
      scheduleDiscordJobCleanup(job.id);
    });

    return res.status(202).json({ jobId: job.id });
  } catch (error) {
    console.error("Fehler bei /api/convert-discord-job:", error);
    return res.status(error.statusCode || 500).json({ error: error.message || "Konvertierung fehlgeschlagen." });
  }
});

app.get(BASE_PATH + "/api/convert-discord-job/:jobId", (req, res) => {
  const job = discordJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job nicht gefunden oder bereits abgelaufen." });
  }

  return res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    totalFiles: job.totalFiles,
    completedFiles: job.completedFiles,
    currentFileIndex: job.currentFileIndex,
    currentFileName: job.currentFileName,
    currentFileProgress: job.currentFileProgress,
    progress: job.progress,
    etaMs: job.etaMs,
    elapsedMs: job.elapsedMs,
    message: job.message,
    results: job.results,
    error: job.error,
  });
});

// ─── Discord OAuth2 Callback ──────────────────────────────────────────────────
const AUTH_LOG_FILE = path.join(LOG_DIR, "auth.json");
let authLogs = [];
try {
  if (fs.existsSync(AUTH_LOG_FILE)) {
    const raw = fs.readFileSync(AUTH_LOG_FILE, "utf8");
    authLogs = JSON.parse(raw);
    if (!Array.isArray(authLogs)) authLogs = [];
  }
} catch (e) { authLogs = []; }

function saveAuthLogs() {
  fs.promises.writeFile(AUTH_LOG_FILE, JSON.stringify(authLogs), "utf8").catch(() => {});
}

app.get(BASE_PATH + "/auth/callback", async (req, res) => {
  const ip = getClientIp(req);
  const ts = Date.now();
  const id = crypto.randomUUID();
  const code = req.query.code || null;

  const entry = {
    time: new Date(ts).toISOString(),
    ip,
    userAgent: req.headers["user-agent"] || "",
    acceptLanguage: req.headers["accept-language"] || "",
    code: code ? "✓" : "✗",
    state: req.query.state || null,
  };

  // Discord User-Infos abrufen
  if (code && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_CLIENT_SECRET !== "DEIN_CLIENT_SECRET_HIER") {
    try {
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: process.env.DISCORD_REDIRECT_URI || `https://blokify.net${BASE_PATH}/auth/callback`,
        }),
      });
      const tokenData = await tokenRes.json();
      console.log("[auth/callback] token response:", JSON.stringify(tokenData));
      if (tokenRes.ok && tokenData.access_token) {
        const tokenScopes = String(tokenData.scope || "").split(/\s+/).filter(Boolean);
        const hasGuildJoinScope = tokenScopes.includes("guilds.join");

        // User via Bearer Token (für Email + Basis-Daten)
        const userRes = await fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (userRes.ok) {
          const user = await userRes.json();
          const avatarHash = user.avatar;
          const bannerHash = user.banner;
          const accentColor = user.accent_color;
          entry.discordId = user.id;
          entry.discordUsername = user.username;
          entry.discordGlobalName = user.global_name || null;
          entry.discordAvatar = avatarHash
            ? `https://cdn.discordapp.com/avatars/${user.id}/${avatarHash}.${avatarHash.startsWith("a_") ? "gif" : "png"}?size=256`
            : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`;
          entry.discordBanner = bannerHash
            ? `https://cdn.discordapp.com/banners/${user.id}/${bannerHash}.${bannerHash.startsWith("a_") ? "gif" : "png"}?size=512`
            : null;
          entry.discordAccentColor = accentColor ? "#" + accentColor.toString(16).padStart(6, "0") : null;
          entry.discordEmail = user.email || null;
          entry.discordVerified = user.verified ?? null;
          entry.discordNitro = user.premium_type > 0 ? true : false;
          entry.discordCreatedAt = new Date(Number((BigInt(user.id) >> 22n) + 1420070400000n)).toISOString();
          entry.discordBio = user.bio || user.about_me || null;
          entry.discordPronouns = user.pronouns || null;
          entry.discordClanTag = user.clan?.tag || null;

          // Pronomen + Bio über Profil-Endpunkt nachholen falls nicht in /users/@me
          if (!entry.discordPronouns || !entry.discordBio) {
            try {
              const profileRes = await fetch("https://discord.com/api/v10/users/@me/profile", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
              });
              if (profileRes.ok) {
                const profile = await profileRes.json();
                const up = profile.user_profile || profile;
                if (!entry.discordPronouns) entry.discordPronouns = up.pronouns || null;
                if (!entry.discordBio) entry.discordBio = up.bio || null;
              }
            } catch (_) {}
          }

          // Auto-Join in Main-Server, wenn guilds.join-Scope + Bot-Token vorhanden sind.
          const mainGuildId = process.env.DISCORD_MAIN_GUILD_ID || process.env.MAIN_GUILD_ID || "1397218011131154543";
          entry.mainGuildJoin = {
            attempted: false,
            success: false,
            guildId: mainGuildId,
            hasGuildsJoinScope: hasGuildJoinScope,
            status: null,
            detail: null,
          };

          if (!hasGuildJoinScope) {
            entry.mainGuildJoin.detail = "missing_guilds.join_scope";
            console.warn(`[auth/callback] guilds.join Scope fehlt für User ${user.id}.`);
          } else if (!process.env.DISCORD_BOT_TOKEN) {
            entry.mainGuildJoin.detail = "missing_discord_bot_token";
            console.warn("[auth/callback] DISCORD_BOT_TOKEN fehlt - Auto-Join übersprungen.");
          } else {
            entry.mainGuildJoin.attempted = true;
            try {
              const joinRes = await fetch(`https://discord.com/api/v10/guilds/${mainGuildId}/members/${user.id}`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                },
                body: JSON.stringify({ access_token: tokenData.access_token }),
              });

              entry.mainGuildJoin.status = joinRes.status;
              if (joinRes.status === 201 || joinRes.status === 204 || joinRes.status === 409) {
                entry.mainGuildJoin.success = true;
              } else {
                const joinErrorText = await joinRes.text().catch(() => "");
                entry.mainGuildJoin.detail = joinErrorText
                  ? joinErrorText.slice(0, 400)
                  : "join_failed_without_response_body";
              }
            } catch (joinErr) {
              entry.mainGuildJoin.status = "exception";
              entry.mainGuildJoin.detail = joinErr?.message || "join_request_exception";
            }
          }

          // Zusätzlich via Bot-Token für Banner (falls nicht im Bearer-Response)
          if (!bannerHash && process.env.DISCORD_BOT_TOKEN) {
            try {
              const botRes = await fetch(`https://discord.com/api/users/${user.id}`, {
                headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
              });
              if (botRes.ok) {
                const botUser = await botRes.json();
                if (botUser.banner) {
                  entry.discordBanner = `https://cdn.discordapp.com/banners/${user.id}/${botUser.banner}.${botUser.banner.startsWith("a_") ? "gif" : "png"}?size=512`;
                }
                if (!accentColor && botUser.accent_color) {
                  entry.discordAccentColor = "#" + botUser.accent_color.toString(16).padStart(6, "0");
                }
              }
            } catch (_) {}
          }
        }
      }
    } catch (e) {
      console.error("[auth/callback] Discord-User-Fetch fehlgeschlagen:", e.message);
    }
  }

  authLogs.unshift(entry);
  if (authLogs.length > 1000) authLogs.length = 1000;
  saveAuthLogs();

  // Auch in Hauptlogs eintragen
  logRequest({
    id,
    ts,
    type: "auth",
    ip,
    method: "GET",
    path: req.path,
    ua: req.headers["user-agent"] || "",
    lang: req.headers["accept-language"] || "",
    ref: req.headers["referer"] || "",
    authEntry: entry,
  });

  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Autorisiert</title></head>
<body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<p>✅ Autorisiert. Dieser Tab schließt sich…</p>
<script>
(async () => {
  const nav = navigator;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
  const data = {
    screen: screen.width + "x" + screen.height,
    windowSize: window.innerWidth + "x" + window.innerHeight,
    dpr: window.devicePixelRatio,
    colorDepth: screen.colorDepth,
    platform: nav.platform,
    vendor: nav.vendor,
    cpuCores: nav.hardwareConcurrency,
    ram: nav.deviceMemory,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: nav.languages?.join(","),
    connectionType: conn.effectiveType || conn.type,
    downlink: conn.downlink,
    touchPoints: nav.maxTouchPoints,
    cookiesEnabled: nav.cookieEnabled,
    online: nav.onLine,
    doNotTrack: nav.doNotTrack,
    userAgent: nav.userAgent,
  };
  try {
    await fetch("/imagetogif/auth/beacon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      keepalive: true,
    });
  } catch(e) {}
  window.close();
})();
</script>
</body></html>`);
});

app.get(BASE_PATH + "/admin/api/auth-logs", adminAuth, (req, res) => {
  res.json(authLogs);
});

app.post(BASE_PATH + "/auth/beacon", express.json({ limit: "16kb" }), (req, res) => {
  const ip = getClientIp(req);
  console.log("[auth/beacon] ip:", ip, "body:", JSON.stringify(req.body));
  // Neuesten Eintrag dieser IP ODER den neuesten Eintrag ohne client-Daten finden
  let entry = authLogs.find((e) => e.ip === ip && !e.client);
  if (!entry) entry = authLogs.find((e) => !e.client);
  if (entry) {
    entry.client = req.body;
    entry.beaconIp = ip;
    saveAuthLogs();
  }
  res.sendStatus(204);
});

// ─── Admin-Routen ─────────────────────────────────────────────────────────────
app.get(BASE_PATH + "/admin", adminAuth, (req, res) => {
  const auth = req.headers["authorization"] || "";
  try {
    let html = fs.readFileSync(path.join(__dirname, "admin", "index.html"), "utf8");
    html = html.replace("const ADMIN_AUTH_HEADER = null;", `const ADMIN_AUTH_HEADER = ${JSON.stringify(auth)};`);
    res.type("html").send(html);
  } catch (e) {
    res.status(500).send("Admin-Seite nicht gefunden.");
  }
});

app.get(BASE_PATH + "/admin/api/logs", adminAuth, (req, res) => {
  const { type, limit } = req.query;
  let logs = type ? requestLogs.filter((l) => l.type === type) : requestLogs;
  if (limit) logs = logs.slice(0, Math.min(parseInt(limit, 10) || 500, MAX_LOG_ENTRIES));
  res.json(logs);
});

app.get(BASE_PATH + "/admin/api/ip-lookup", adminAuth, (req, res) => {
  const ip = String(req.query.ip || "").trim();
  if (!ip || !/^[0-9a-fA-F.:]+$/.test(ip)) {
    return res.status(400).json({ error: "Ungültige IP-Adresse" });
  }
  const options = {
    hostname: "ip-api.com",
    path: `/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,query,mobile,proxy,hosting`,
    method: "GET",
    headers: { "User-Agent": "imagetogif-admin/1.0" },
  };
  const proxyReq = http.request(options, (proxyRes) => {
    let data = "";
    proxyRes.on("data", (chunk) => { data += chunk; });
    proxyRes.on("end", () => {
      try {
        res.json(JSON.parse(data));
      } catch {
        res.status(500).json({ error: "Ungültige API-Antwort" });
      }
    });
  });
  proxyReq.on("error", () => res.status(500).json({ error: "IP-Lookup fehlgeschlagen" }));
  proxyReq.end();
});

app.get(BASE_PATH + "/admin/api/pm2", adminAuth, (req, res) => {
  execFile("pm2", ["jlist"], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        error: "PM2-Daten konnten nicht geladen werden.",
        detail: stderr ? String(stderr).slice(0, 300) : error.message,
      });
    }

    let list;
    try {
      list = JSON.parse(stdout || "[]");
      if (!Array.isArray(list)) list = [];
    } catch (e) {
      return res.status(500).json({ error: "PM2 lieferte ungueltige Daten." });
    }

    const now = Date.now();
    const processes = list.map((p) => {
      const env = p.pm2_env || {};
      const monit = p.monit || {};
      const createdAt = Number(env.created_at) || null;
      const uptimeMs = createdAt ? Math.max(0, now - createdAt) : null;
      return {
        name: env.name || p.name || "unknown",
        namespace: env.namespace || "default",
        status: env.status || "unknown",
        pid: p.pid || null,
        pmId: p.pm_id,
        instances: env.instances || 1,
        execMode: env.exec_mode || "-",
        restarts: Number(env.restart_time) || 0,
        cpuPercent: Number(monit.cpu) || 0,
        memoryBytes: Number(monit.memory) || 0,
        uptimeMs,
      };
    });

    const totalCpuPercent = processes.reduce((sum, p) => sum + p.cpuPercent, 0);
    const totalMemoryBytes = processes.reduce((sum, p) => sum + p.memoryBytes, 0);

    return res.json({
      timestamp: now,
      host: {
        cpuCores: os.cpus().length,
        loadAvg: os.loadavg(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
      },
      summary: {
        processCount: processes.length,
        onlineCount: processes.filter((p) => p.status === "online").length,
        totalCpuPercent,
        totalMemoryBytes,
      },
      processes,
    });
  });
});
// ─────────────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: "Nicht gefunden." });
});

app.listen(PORT, () => {
  console.log(`ImageToGif läuft auf Port ${PORT}`);
  console.log(`Öffne http://localhost:${PORT}${BASE_PATH}`);
});
