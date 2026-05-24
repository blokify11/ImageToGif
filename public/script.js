const BASE_PATH = "/imagetogif";

// ─── Client Beacon: sendet Browser/Gerät-Infos an den Server ─────────────────
(function sendBeacon() {
  try {
    const nav = navigator;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection || {};
    const payload = {
      screenW: screen.width,
      screenH: screen.height,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      dpr: window.devicePixelRatio,
      colorDepth: screen.colorDepth,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: nav.language,
      langs: nav.languages ? nav.languages.join(", ") : nav.language,
      platform: nav.platform,
      vendor: nav.vendor || "",
      touch: "ontouchstart" in window || nav.maxTouchPoints > 0,
      maxTouch: nav.maxTouchPoints || 0,
      cores: nav.hardwareConcurrency || null,
      memory: nav.deviceMemory || null,
      cookies: nav.cookieEnabled,
      online: nav.onLine,
      connection: conn.effectiveType || conn.type || null,
      connectionSpeed: conn.downlink || null,
      pdfPlugin: !!(nav.mimeTypes && nav.mimeTypes["application/pdf"]),
      javaEnabled: typeof nav.javaEnabled === "function" ? nav.javaEnabled() : false,
      doNotTrack: nav.doNotTrack || window.doNotTrack || null,
    };
    fetch(BASE_PATH + "/api/beacon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
})();
// ─────────────────────────────────────────────────────────────────────────────

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressLabel = document.getElementById("progressLabel");
const progressValue = document.getElementById("progressValue");
const progressFill = document.getElementById("progressFill");
const progressDetail = document.getElementById("progressDetail");
const resultEl = document.getElementById("result");
const resultsGrid = document.getElementById("resultsGrid");
const cursorDot = document.getElementById("cursorDot");
const modeButtons = document.querySelectorAll(".mode-button");
const NON_PICKER_CLICK_SELECTOR = "button, input, textarea, select, a, label, .result-card, .result-card *";
let currentMode = "gif";
let quakeTimeout;
let discordJobPollToken = 0;

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function resetProgress() {
  progressWrap.className = "progress-wrap hidden";
  progressLabel.textContent = "Komprimierung startet ...";
  progressValue.textContent = "0%";
  progressFill.style.width = "0%";
  progressWrap.querySelector(".progress-bar").setAttribute("aria-valuenow", "0");
  progressDetail.textContent = "";
}

function setProgress(percent, label, detail = "") {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  progressWrap.className = "progress-wrap";
  progressLabel.textContent = label;
  progressValue.textContent = `${safePercent}%`;
  progressFill.style.width = `${safePercent}%`;
  progressWrap.querySelector(".progress-bar").setAttribute("aria-valuenow", String(safePercent));
  progressDetail.textContent = detail;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }

  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

function triggerCopyEffect(sourceEl) {
  const rect = sourceEl?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;

  document.body.style.setProperty("--fx-x", `${x}px`);
  document.body.style.setProperty("--fx-y", `${y}px`);

  document.body.classList.remove("quake");
  requestAnimationFrame(() => {
    document.body.classList.add("quake");
  });

  clearTimeout(quakeTimeout);
  quakeTimeout = setTimeout(() => {
    document.body.classList.remove("quake");
  }, 520);

  if (sourceEl) {
    sourceEl.classList.remove("copy-impact");
    void sourceEl.offsetWidth;
    sourceEl.classList.add("copy-impact");
    setTimeout(() => {
      sourceEl.classList.remove("copy-impact");
    }, 420);
  }

  const burst = document.createElement("div");
  burst.className = "fx-burst";
  burst.style.setProperty("--x", `${x}px`);
  burst.style.setProperty("--y", `${y}px`);

  for (let i = 0; i < 16; i += 1) {
    const particle = document.createElement("span");
    particle.className = "fx-particle";
    const angle = (Math.PI * 2 * i) / 16;
    const distance = 55 + Math.random() * 90;
    particle.style.setProperty("--tx", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--ty", `${Math.sin(angle) * distance}px`);
    particle.style.animationDelay = `${Math.random() * 90}ms`;
    burst.appendChild(particle);
  }

  document.body.appendChild(burst);
  setTimeout(() => {
    burst.remove();
  }, 700);
}

async function copyUrl(value, sourceEl) {
  if (!value) {
    return;
  }

  triggerCopyEffect(sourceEl);

  try {
    await navigator.clipboard.writeText(value);
    setStatus("URL kopiert!", "ok");
  } catch {
    const tempInput = document.createElement("input");
    tempInput.value = value;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    document.body.removeChild(tempInput);
    setStatus("URL kopiert!", "ok");
  }
}

function updateModeUi() {
  discordJobPollToken += 1;
  modeButtons.forEach((button) => {
    const isActive = button.dataset.mode === currentMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  if (currentMode === "discord10mb") {
    fileInput.accept = "image/gif,.gif";
    dropzone.querySelector(".drop-title").textContent = "GIF hier reinziehen";
    dropzone.querySelector(".drop-hint").textContent = "wird fuer Discord auf 10 MB komprimiert";
  } else {
    fileInput.accept = "image/*,video/*";
    dropzone.querySelector(".drop-title").textContent = "Bilder oder Videos hier reinziehen";
    dropzone.querySelector(".drop-hint").textContent = "oder klicken zum Auswaehlen";
  }

  setStatus("");
  resetProgress();
  resultEl.classList.add("hidden");
  resultsGrid.innerHTML = "";
}

function renderResultCard(result, index) {
  const url = typeof result === "string" ? result : result.url;
  const meta = typeof result === "object" ? result.meta : null;
  const card = document.createElement("article");
  card.className = "result-card";

  const title = document.createElement("p");
  title.className = "result-label";
  title.textContent = `GIF ${index + 1}`;

  const img = document.createElement("img");
  img.className = "preview";
  img.src = url;
  img.alt = `Konvertiertes GIF ${index + 1}`;
  img.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyUrl(url, event.currentTarget);
  });

  const row = document.createElement("div");
  row.className = "url-row";

  const input = document.createElement("input");
  input.readOnly = true;
  input.value = url;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "URL kopieren";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyUrl(url, event.currentTarget);
  });

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.textContent = "GIF herunterladen";
  downloadButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const link = document.createElement("a");
    link.href = url;
    link.download = `gif-${index + 1}.gif`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setStatus("GIF wird heruntergeladen.", "ok");
  });

  row.append(input, button, downloadButton);
  card.append(title, img);

  if (meta) {
    const details = document.createElement("p");
    details.className = `result-meta ${meta.withinLimit ? "ok" : "warn"}`;
    const fps = meta.fps ? `, ${meta.fps} FPS` : "";
    const width = meta.width ? `, max. ${meta.width}px` : "";
    details.textContent = meta.unchanged
      ? `${meta.optimizedMb} MB - schon Discord-ready`
      : `${meta.originalMb} MB -> ${meta.optimizedMb} MB${fps}${width}`;
    card.append(details);
  }

  card.append(row);
  resultsGrid.append(card);
}

async function uploadAndConvert(files) {
  discordJobPollToken += 1;
  const pollToken = discordJobPollToken;
  const validFiles = Array.from(files || []).filter((file) => {
    if (currentMode === "discord10mb") {
      return file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
    }
    return file.type.startsWith("image/") || file.type.startsWith("video/");
  });

  if (validFiles.length === 0) {
    setStatus(
      currentMode === "discord10mb"
        ? "Bitte mindestens eine GIF-Datei auswählen."
        : "Bitte mindestens eine gültige Bild- oder Videodatei auswählen.",
      "error"
    );
    return;
  }

  setStatus(
    currentMode === "discord10mb"
      ? `Komprimiere ${validFiles.length} GIF(s) fuer Discord auf 10 MB ...`
      : `Wandle ${validFiles.length} Datei(en) in GIF um ...`
  );
  resetProgress();
  resultEl.classList.add("hidden");
  resultsGrid.innerHTML = "";

  const formData = new FormData();
  formData.append("mode", currentMode);
  validFiles.forEach((file) => {
    formData.append("image", file);
  });

  try {
    if (currentMode === "discord10mb") {
      setProgress(0, "Upload wird gesendet ...", `0/${validFiles.length} GIF(s) fertig`);

      // Dateien > 90MB in Chunks aufteilen (umgeht Cloudflare 100MB-Limit)
      const CHUNK_SIZE = 90 * 1024 * 1024;
      const uploadIds = [];
      let totalBytes = 0;
      let uploadedBytes = 0;
      for (const f of validFiles) totalBytes += f.size;

      const chunkedFormData = new FormData();
      chunkedFormData.append("mode", "discord10mb");

      for (const file of validFiles) {
        if (file.size <= CHUNK_SIZE) {
          // Klein genug: direkt als normales Formfeld
          chunkedFormData.append("image", file);
          uploadIds.push(null);
        } else {
          // Groß: in Chunks senden
          const uploadId = crypto.randomUUID();
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
          for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const chunk = file.slice(start, start + CHUNK_SIZE);
            const chunkForm = new FormData();
            chunkForm.append("uploadId", uploadId);
            chunkForm.append("chunkIndex", String(i));
            chunkForm.append("totalChunks", String(totalChunks));
            chunkForm.append("originalname", file.name);
            chunkForm.append("mimetype", file.type || "image/gif");
            chunkForm.append("chunk", chunk, file.name);
            const chunkRes = await fetch(`${BASE_PATH}/api/chunk-upload`, { method: "POST", body: chunkForm });
            if (!chunkRes.ok) throw new Error("Chunk-Upload fehlgeschlagen.");
            uploadedBytes += chunk.size;
            const uploadPct = Math.round((uploadedBytes / totalBytes) * 60);
            setProgress(uploadPct, "Upload wird gesendet ...", `${file.name} (${i + 1}/${totalChunks} Teile)`);
          }
          uploadIds.push(uploadId);
        }
      }

      // Wenn alle Dateien per Chunk hochgeladen wurden, uploadIds übergeben
      const allChunked = uploadIds.every((id) => id !== null);
      const jobFormData = new FormData();
      if (allChunked) {
        jobFormData.append("uploadIds", JSON.stringify(uploadIds));
      } else {
        // Mischung oder alles direkt
        validFiles.forEach((file, i) => {
          if (uploadIds[i] === null) jobFormData.append("image", file);
        });
        const chunkedIds = uploadIds.filter(Boolean);
        if (chunkedIds.length > 0) jobFormData.append("uploadIds", JSON.stringify(chunkedIds));
      }

      const jobResponse = await fetch(`${BASE_PATH}/api/convert-discord-job`, {
        method: "POST",
        body: jobFormData,
      });
      const jobPayload = await jobResponse.json();

      if (!jobResponse.ok || !jobPayload.jobId) {
        throw new Error(jobPayload.error || "Discord-Komprimierung konnte nicht gestartet werden.");
      }

      setProgress(0, "Komprimierung gestartet ...", `0/${validFiles.length} GIF(s) fertig`);

      let payload = null;
      while (pollToken === discordJobPollToken) {
        const progressResponse = await fetch(`${BASE_PATH}/api/convert-discord-job/${jobPayload.jobId}`, {
          cache: "no-store",
        });
        payload = await progressResponse.json();

        if (!progressResponse.ok) {
          throw new Error(payload.error || "Fortschritt konnte nicht geladen werden.");
        }

        const fileNumber = Math.min((payload.currentFileIndex || 0) + 1, payload.totalFiles || validFiles.length);
        const parts = [`${Math.max(payload.completedFiles || 0, 0)}/${payload.totalFiles || validFiles.length} GIF(s) fertig`];

        if (payload.currentFileName) {
          parts.push(`Datei ${fileNumber}: ${payload.currentFileName}`);
        }

        const etaText = formatDuration(payload.etaMs);
        if (etaText && payload.status !== "done") {
          parts.push(`ETA ca. ${etaText}`);
        }

        const elapsedText = formatDuration(payload.elapsedMs);
        if (elapsedText && payload.status === "done") {
          parts.push(`Dauer ${elapsedText}`);
        }

        setProgress(payload.progress || 0, payload.message || "Komprimierung laeuft ...", parts.join(" | "));

        if (payload.status === "done") {
          break;
        }

        if (payload.status === "error") {
          throw new Error(payload.error || payload.message || "Komprimierung fehlgeschlagen.");
        }

        await sleep(700);
      }

      if (pollToken !== discordJobPollToken) {
        return;
      }

      const results = Array.isArray(payload?.results) ? payload.results : [];
      if (results.length === 0) {
        throw new Error("Keine komprimierten GIFs erhalten.");
      }

      results.forEach((result, index) => {
        renderResultCard(result, index);
      });
      resultEl.classList.remove("hidden");
      const doneDuration = formatDuration(payload?.elapsedMs);
      setProgress(
        100,
        "Komprimierung abgeschlossen",
        `${results.length}/${results.length} GIF(s) fertig${doneDuration ? ` | Dauer ${doneDuration}` : ""}`
      );
      setStatus(`${results.length} GIF(s) Discord-ready komprimiert.`, "ok");
      return;
    }

    const response = await fetch(`${BASE_PATH}/api/convert`, {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    const results = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.urls)
        ? payload.urls.map((url) => ({ url }))
        : [];

    if (!response.ok || results.length === 0) {
      throw new Error(payload.error || "Fehler bei der Konvertierung");
    }

    results.forEach((result, index) => {
      renderResultCard(result, index);
    });
    resultEl.classList.remove("hidden");
    setStatus(
      currentMode === "discord10mb"
        ? `${results.length} GIF(s) Discord-ready komprimiert.`
        : `${results.length} GIF(s) erstellt. Klick auf Bild oder Button, um URL zu kopieren.`,
      "ok"
    );
  } catch (error) {
    if (currentMode === "discord10mb" && pollToken === discordJobPollToken) {
      progressWrap.className = "progress-wrap";
      progressDetail.textContent = "";
    }
    if (pollToken === discordJobPollToken) {
      setStatus(error.message || "Unbekannter Fehler.", "error");
    }
  }
}

fileInput.addEventListener("change", (event) => {
  uploadAndConvert(event.target.files);
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentMode = button.dataset.mode || "gif";
    fileInput.value = "";
    updateModeUi();
  });
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (event) => {
  uploadAndConvert(event.dataTransfer.files);
});

// Bild aus Zwischenablage einfügen (Strg+V)
document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  const imageFiles = [];
  for (const item of items) {
    const acceptsItem = currentMode === "discord10mb" ? item.type === "image/gif" : item.type.startsWith("image/");
    if (acceptsItem) {
      const file = item.getAsFile();
      if (file) imageFiles.push(file);
    }
  }
  if (imageFiles.length > 0) {
    event.preventDefault();
    uploadAndConvert(imageFiles);
  }
});

updateModeUi();

function openFilePicker() {
  fileInput.click();
}

document.addEventListener("click", (event) => {
  if (event.target.closest(NON_PICKER_CLICK_SELECTOR)) {
    return;
  }
  openFilePicker();
});

function markDragActive(event) {
  event.preventDefault();
  event.stopPropagation();
  document.body.classList.add("drag-active");
  dropzone.classList.add("dragover");
}

function clearDragActive(event) {
  event.preventDefault();
  event.stopPropagation();
  document.body.classList.remove("drag-active");
  dropzone.classList.remove("dragover");
}

["dragenter", "dragover"].forEach((eventName) => {
  document.addEventListener(eventName, markDragActive);
});

["dragleave", "drop"].forEach((eventName) => {
  document.addEventListener(eventName, clearDragActive);
});

document.addEventListener("drop", (event) => {
  const droppedFiles = event.dataTransfer?.files;
  if (droppedFiles && droppedFiles.length > 0) {
    uploadAndConvert(droppedFiles);
  }
});

if (cursorDot && window.matchMedia("(pointer: fine)").matches) {
  document.addEventListener("mousemove", (event) => {
    cursorDot.style.left = `${event.clientX}px`;
    cursorDot.style.top = `${event.clientY}px`;
    cursorDot.classList.remove("hidden-cursor-dot");
  });

  document.addEventListener("mouseleave", () => {
    cursorDot.classList.add("hidden-cursor-dot");
  });

  document.addEventListener("mouseenter", () => {
    cursorDot.classList.remove("hidden-cursor-dot");
  });
}
