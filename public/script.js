const BASE_PATH = "/imagetogif";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const resultsGrid = document.getElementById("resultsGrid");
const cursorDot = document.getElementById("cursorDot");
const NON_PICKER_CLICK_SELECTOR = "button, input, textarea, select, a, label, .result-card, .result-card *";
let quakeTimeout;

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
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

function renderResultCard(url, index) {
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
  card.append(title, img, row);
  resultsGrid.append(card);
}

async function uploadAndConvert(files) {
  const validFiles = Array.from(files || []).filter(
    (file) => file.type.startsWith("image/") || file.type.startsWith("video/")
  );
  if (validFiles.length === 0) {
    setStatus("Bitte mindestens eine gültige Bild- oder Videodatei auswählen.", "error");
    return;
  }

  setStatus(`Wandle ${validFiles.length} Datei(en) in GIF um ...`);
  resultEl.classList.add("hidden");
  resultsGrid.innerHTML = "";

  const formData = new FormData();
  validFiles.forEach((file) => {
    formData.append("image", file);
  });

  try {
    const response = await fetch(`${BASE_PATH}/api/convert`, {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok || !Array.isArray(payload.urls) || payload.urls.length === 0) {
      throw new Error(payload.error || "Fehler bei der Konvertierung");
    }

    payload.urls.forEach((url, index) => {
      renderResultCard(url, index);
    });
    resultEl.classList.remove("hidden");
    setStatus(`${payload.urls.length} GIF(s) erstellt. Klick auf Bild oder Button, um URL zu kopieren.`, "ok");
  } catch (error) {
    setStatus(error.message || "Unbekannter Fehler.", "error");
  }
}

fileInput.addEventListener("change", (event) => {
  uploadAndConvert(event.target.files);
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
