const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = "/imagetogif";
const GIF_DIR = path.join(__dirname, "gifs");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(GIF_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

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

app.use(BASE_PATH + "/gifs", express.static(GIF_DIR));

// Sorgt fuer konsistente URL mit Trailing Slash.
app.use((req, res, next) => {
  if (req.path === BASE_PATH) {
    return res.redirect(301, BASE_PATH + "/");
  }
  return next();
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

    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.get("host");
    const urls = [];

    for (const file of req.files) {
      const isImage = file.mimetype.startsWith("image/");
      const isVideo = file.mimetype.startsWith("video/");

      if (!isImage && !isVideo) {
        return res.status(400).json({ error: "Bitte nur Bild- oder Videodateien hochladen." });
      }

      let gifBuffer;

      if (isImage) {
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

      const id = crypto.randomUUID();
      const fileName = `${id}.gif`;
      const targetPath = path.join(GIF_DIR, fileName);

      await fs.promises.writeFile(targetPath, gifBuffer);

      const relativeUrl = `${BASE_PATH}/gifs/${fileName}`;
      const url = host ? `${protocol}://${host}${relativeUrl}` : relativeUrl;
      urls.push(url);
    }

    return res.json({
      success: true,
      urls,
    });
  } catch (error) {
    console.error("Konvertierungsfehler:", error);
    if (String(error.message || "").includes("ffmpeg")) {
      return res.status(500).json({ error: "Video-Konvertierung fehlgeschlagen. ffmpeg verfuegbar?" });
    }
    return res.status(500).json({ error: "Konvertierung fehlgeschlagen." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Nicht gefunden." });
});

app.listen(PORT, () => {
  console.log(`ImageToGif läuft auf Port ${PORT}`);
  console.log(`Öffne http://localhost:${PORT}${BASE_PATH}`);
});
