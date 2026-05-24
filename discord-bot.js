require("dotenv").config();
const { Client, GatewayIntentBits, Events, AttachmentBuilder, MessageFlags } = require("discord.js");
const https = require("https");
const http = require("http");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("Fehlende ENV-Variable: DISCORD_BOT_TOKEN");
  process.exit(1);
}

const GIF_DIR = path.join(__dirname, "gifs");
fs.mkdirSync(GIF_DIR, { recursive: true });

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Discord Bot eingeloggt als ${c.user.tag}`);
});

// Ladebalken-Helper
function progressBar(step, total = 5) {
  const filled = Math.round((step / total) * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${Math.round((step / total) * 100)}%`;
}

function loadingEmbed(text, step) {
  return {
    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
    components: [{
      type: 17,
      components: [
        { type: 10, content: `### ⏳ GIF wird erstellt…` },
        { type: 14, spacing: 1 },
        { type: 10, content: `\`${progressBar(step)}\`\n${text}` },
      ],
    }],
  };
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "imagetogif") return;

  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment("png");

  // Erlaubte MIME-Types: nur Bilder
  const isImage = attachment.contentType?.startsWith("image/");

  if (!isImage) {
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [{ type: 17, components: [{ type: 10, content: "❌ Bitte lade eine Bilddatei hoch (PNG, JPG, GIF, WEBP…)." }] }],
    });
  }

  // Datei-Größe: max 100 MB
  if (attachment.size > 100 * 1024 * 1024) {
    return interaction.editReply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [{ type: 17, components: [{ type: 10, content: "❌ Datei zu groß. Maximum: 100 MB." }] }],
    });
  }

  try {
    // Schritt 1: Datei herunterladen
    await interaction.editReply(loadingEmbed("Datei wird heruntergeladen…", 1));
    const fileBuffer = await downloadURL(attachment.url);

    // Schritt 2: Konvertierung starten
    await interaction.editReply(loadingEmbed("Konvertierung läuft…", 2));
    let gifBuffer;

    await interaction.editReply(loadingEmbed("Bild wird zu GIF verarbeitet…", 3));
    gifBuffer = await sharp(fileBuffer)
      .rotate()
      .resize({ width: 720, height: 720, fit: "inside", withoutEnlargement: true })
      .gif({ effort: 7 })
      .toBuffer();

    // Schritt 3: Speichern
    await interaction.editReply(loadingEmbed("GIF wird gespeichert…", 4));
    const id = crypto.randomUUID();
    const fileName = `${id}.gif`;
    const targetPath = path.join(GIF_DIR, fileName);
    await fs.promises.writeFile(targetPath, gifBuffer);

    // Schritt 4: Fertig
    const gifAttachment = new AttachmentBuilder(gifBuffer, { name: fileName });
    const gifUrl = `https://blokify.net/imagetogif/gifs/${fileName}`;
    const sizeMB = (gifBuffer.length / 1024 / 1024).toFixed(2);

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      files: [gifAttachment],
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: `### ✅ GIF erstellt!` },
            { type: 14, spacing: 1 },
            { type: 12, items: [{ media: { url: `attachment://${fileName}` } }] },
            { type: 14, spacing: 1 },
            { type: 10, content: `🔗 **Direktlink:** ${gifUrl}\n📦 **Größe:** ${sizeMB} MB` },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("Konvertierungsfehler:", err);
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      components: [{ type: 17, components: [{ type: 10, content: "❌ Konvertierung fehlgeschlagen. Bitte versuche es erneut." }] }],
    });
  }
});

// ─── Hilfsfunktionen ───────────────────────────────────────────────────────────

function downloadURL(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function convertVideoToGif(videoBuffer, tempBaseName) {
  const { spawn } = require("child_process");
  const tempInput = path.join(os.tmpdir(), `${tempBaseName}.input`);
  const tempOutput = path.join(os.tmpdir(), `${tempBaseName}.gif`);

  return new Promise(async (resolve, reject) => {
    try {
      await fs.promises.writeFile(tempInput, videoBuffer);
      const ffmpeg = spawn("ffmpeg", [
        "-y", "-i", tempInput,
        "-vf", "fps=12,scale='min(720,iw)':-2:flags=lanczos",
        "-loop", "0", tempOutput,
      ]);
      let stderr = "";
      ffmpeg.stderr.on("data", (c) => { stderr += c.toString(); });
      ffmpeg.on("error", async (e) => {
        await cleanup(tempInput, tempOutput);
        reject(e);
      });
      ffmpeg.on("close", async (code) => {
        if (code !== 0) {
          await cleanup(tempInput, tempOutput);
          return reject(new Error(`ffmpeg Fehler (Code ${code}): ${stderr}`));
        }
        const buf = await fs.promises.readFile(tempOutput);
        await cleanup(tempInput, tempOutput);
        resolve(buf);
      });
    } catch (e) {
      await cleanup(tempInput, tempOutput);
      reject(e);
    }
  });
}

async function cleanup(...files) {
  await Promise.allSettled(files.map((f) => fs.promises.unlink(f)));
}

client.login(token);
