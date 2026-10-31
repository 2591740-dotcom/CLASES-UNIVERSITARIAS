const app = document.querySelector("#app");
const keybar = document.querySelector("#keybar");

let poll = 0;
let shown = "";
let clase = null;
let setup = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function youtubeHref(raw) {
  const text = String(raw).replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const watch = text.match(/youtube\.com\/watch\?[^\s<>]+/i);
  const fromWatch = watch && watch[0].match(/[?&]v=([A-Za-z0-9_-]{11})/);
  const short = text.match(/(?:youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([A-Za-z0-9_-]{11})/i);
  const id = (fromWatch && fromWatch[1]) || (short && short[1]);
  if (!id) return "";
  const start = text.match(/[?&](?:t|start)=(\d+)/i);
  return `https://www.youtube.com/watch?v=${id}${start && start[1] !== "0" ? `&t=${start[1]}` : ""}`;
}

function linkify(escaped) {
  return escaped.replace(
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s<>]+|(?:embed|shorts|live)\/[A-Za-z0-9_-]{11}[^\s<>]*)|youtu\.be\/[A-Za-z0-9_-]{11}[^\s<>]*)/gi,
    (raw) => {
      const href = youtubeHref(raw);
      if (!href) return raw;
      return `<a href="${esc(href)}" target="_blank" rel="noreferrer">Ver en YouTube</a>`;
    },
  );
}

function rich(value) {
  const html = linkify(esc(value)
    .split(/\n{2,}/)
    .map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`)
    .join("")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
  return html.replace(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g, '<button type="button" class="jump" data-time="$1">$1</button>');
}

function youtubeCards(videos) {
  return (videos || []).map((video) => {
    const href = youtubeHref(video.url || "");
    if (!href) return "";
    const when = video.tiempo
      ? `<button type="button" class="jump" data-time="${esc(video.tiempo)}">En la clase, ${esc(video.tiempo)}</button>`
      : "";
    return `<a class="yt" href="${esc(href)}" target="_blank" rel="noreferrer"><span class="kicker">YouTube</span><strong>${esc(video.titulo || "Ver el video")}</strong></a>${when}`;
  }).join("");
}

function parseTime(stamp) {
  const parts = String(stamp).split(":").map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function durationLabel(seconds) {
  const total = Math.round(seconds || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours && minutes) return `${hours} h ${minutes} min`;
  if (hours) return `${hours} h`;
  if (minutes) return `${minutes} min`;
  return total ? `${total} s` : "";
}

function elapsed(started) {
  if (!started) return "";
  const seconds = Math.max(0, Math.round(Date.now() / 1000 - started));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

async function api(url, options) {
  if (window.claseClaraCloud) return window.claseClaraCloud.api(url, options);
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "No se pudo completar.");
  return data;
}

function stopPoll() {
  clearInterval(poll);
  poll = 0;
}

function materiaValue() {
  return document.querySelector("#materia")?.value || "";
}

function termsValue() {
  return document.querySelector("#terms")?.value || "";
}

function renderKey(status) {
  setup = status;
  const chat = status.chat || {};
  const label = chat.label || "IA";
  const model = chat.model ? ` · ${chat.model}` : "";
  const note = status.ready ? `${label}${model}` : (status.missing || "Elige un proveedor");
  keybar.innerHTML = `<span class="note">${esc(note)}</span><button class="texty" id="open-config" type="button">Configurar</button>`;
  document.querySelector("#open-config").onclick = openConfig;
}

function providerOptions(providers, hearOnly) {
  return (providers || [])
    .filter((item) => !hearOnly || item.hears)
    .map((item) => `<option value="${esc(item.id)}">${esc(item.label)}</option>`)
    .join("");
}

function openConfig() {
  const box = document.querySelector("#config");
  const status = setup || {};
  const chat = status.chat || {};
  const stt = status.stt || {};
  const providers = status.providers || [];
  box.hidden = false;
  box.innerHTML = `
    <section class="panel">
      <h2>Proveedor de IA</h2>
      <div class="config-grid">
        <div>
          <label for="cfg-chat">Quién explica y responde el chat</label>
          <select id="cfg-chat">${providerOptions(providers, false)}</select>
        </div>
        <div>
          <label for="cfg-key">Clave</label>
          <input id="cfg-key" type="password" autocomplete="off">
        </div>
        <div>
          <label for="cfg-model">Modelo</label>
          <input id="cfg-model" type="text" autocomplete="off">
        </div>
        <div id="cfg-base-row">
          <label for="cfg-base">URL base</label>
          <input id="cfg-base" type="text" placeholder="https://tu-servidor/v1" autocomplete="off">
        </div>
        <p class="note span-2" id="cfg-note"></p>
        <p class="span-2"><a id="cfg-link" href="" target="_blank" rel="noreferrer">Dónde sacar la clave</a></p>
        <div class="span-2">
          <label for="cfg-stt">Quién transcribe la voz</label>
          <select id="cfg-stt">
            <option value="same">El mismo proveedor</option>
            ${providerOptions(providers, true)}
          </select>
        </div>
        <div id="cfg-stt-key-row">
          <label for="cfg-stt-key">Clave de la voz</label>
          <input id="cfg-stt-key" type="password" autocomplete="off">
        </div>
        <div>
          <label for="cfg-stt-model">Modelo de voz</label>
          <input id="cfg-stt-model" type="text" autocomplete="off">
        </div>
        <div id="cfg-stt-base-row" class="span-2">
          <label for="cfg-stt-base">URL para transcribir</label>
          <input id="cfg-stt-base" type="text" placeholder="https://tu-servidor/v1" autocomplete="off">
        </div>
      </div>
      <div class="row">
        <button class="primary" id="cfg-save" type="button">Guardar</button>
        <button class="ghost" id="cfg-close" type="button">Cerrar</button>
      </div>
    </section>`;
  document.querySelector("#cfg-chat").value = chat.provider || "grok";
  document.querySelector("#cfg-stt").value = stt.provider || "same";
  document.querySelector("#cfg-model").value = chat.model || "";
  document.querySelector("#cfg-base").value = chat.base || "";
  document.querySelector("#cfg-stt-model").value = stt.model || "";
  document.querySelector("#cfg-stt-base").value = stt.base || "";
  syncConfig();
  document.querySelector("#cfg-chat").onchange = () => {
    const id = document.querySelector("#cfg-chat").value;
    const spec = providers.find((item) => item.id === id);
    const saved = (setup && setup.chat) || {};
    if (id === saved.provider) {
      document.querySelector("#cfg-model").value = saved.model || "";
    } else if (spec) {
      document.querySelector("#cfg-model").value = spec.default_model || "";
      document.querySelector("#cfg-key").value = "";
    }
    if (document.querySelector("#cfg-stt").value === "same") {
      document.querySelector("#cfg-stt-model").value = id === saved.provider
        ? ((setup && setup.stt && setup.stt.model) || "")
        : ((spec && spec.default_stt_model) || "");
    }
    syncConfig();
  };
  document.querySelector("#cfg-stt").onchange = () => {
    const id = document.querySelector("#cfg-stt").value;
    document.querySelector("#cfg-stt-key").value = "";
    if (id === "same") {
      const spec = providers.find((item) => item.id === document.querySelector("#cfg-chat").value);
      document.querySelector("#cfg-stt-model").value = spec ? (spec.default_stt_model || "") : "";
    } else {
      const spec = providers.find((item) => item.id === id);
      document.querySelector("#cfg-stt-model").value = spec ? (spec.default_stt_model || "") : "";
    }
    syncConfig();
  };
  document.querySelector("#cfg-close").onclick = closeConfig;
  document.querySelector("#cfg-save").onclick = saveConfig;
}

function closeConfig() {
  const box = document.querySelector("#config");
  box.hidden = true;
  box.innerHTML = "";
}

function syncConfig() {
  const providers = (setup && setup.providers) || [];
  const chatId = document.querySelector("#cfg-chat").value;
  const sttId = document.querySelector("#cfg-stt").value;
  const spec = providers.find((item) => item.id === chatId) || {};
  const savedChat = (setup && setup.chat) || {};
  const savedStt = (setup && setup.stt) || {};
  document.querySelector("#cfg-base-row").hidden = chatId !== "compatible";
  document.querySelector("#cfg-note").textContent = spec.note || "";
  document.querySelector("#cfg-stt-key-row").hidden = sttId === "same";
  document.querySelector("#cfg-stt-base-row").hidden = sttId !== "compatible";
  const link = document.querySelector("#cfg-link");
  if (spec.key_url) {
    link.hidden = false;
    link.href = spec.key_url;
  } else {
    link.hidden = true;
  }
  const key = document.querySelector("#cfg-key");
  if (savedChat.provider === chatId && savedChat.has_key) {
    key.placeholder = savedChat.from_env ? "En blanco sigue la clave del sistema" : "En blanco se conserva la guardada";
  } else {
    key.placeholder = "Pega la clave de este proveedor";
  }
  const voice = document.querySelector("#cfg-stt-key");
  if (savedStt.provider === sttId && savedStt.has_key) {
    voice.placeholder = savedStt.from_env ? "En blanco sigue la clave del sistema" : "En blanco se conserva la guardada";
  } else {
    voice.placeholder = "Pega la clave de la voz";
  }
}

async function saveConfig() {
  const button = document.querySelector("#cfg-save");
  button.disabled = true;
  try {
    const status = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_provider: document.querySelector("#cfg-chat").value,
        chat_key: document.querySelector("#cfg-key").value,
        chat_model: document.querySelector("#cfg-model").value,
        chat_base: document.querySelector("#cfg-base").value,
        stt_provider: document.querySelector("#cfg-stt").value,
        stt_key: document.querySelector("#cfg-stt-key").value,
        stt_model: document.querySelector("#cfg-stt-model").value,
        stt_base: document.querySelector("#cfg-stt-base").value,
      }),
    });
    closeConfig();
    renderKey(status);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
}

function phoneHome(classes) {
  const mine = classes.length
    ? classes.map(cardHtml).join("")
    : '<p class="empty">Todavía no hay clases. Cuando la PC publique una, aparece aquí.</p>';
  return `
    <section class="hero">
      <p class="kicker">Tu clase, en claro</p>
      <h1>La misma clase, en el teléfono.</h1>
      <p class="lede">El texto y las diapositivas salen de Supabase. El video se ve desde el enlace o desde un archivo que cargues en este aparato.</p>
    </section>
    <section class="panel">
      <div class="drop" id="drop">
        <label for="link">Enlace de Zoom</label>
        <input id="link" type="text" placeholder="https://....zoom.us/rec/play/...">
        <label for="file">Video en este teléfono</label>
        <input id="file" type="file" accept="video/*,audio/*">
        <label for="materia">Materia, si quieres</label>
        <input id="materia" type="text" placeholder="Ejemplo: biología celular">
        <div class="row">
          <button class="primary" id="go" type="button">Guardar clase</button>
        </div>
        <p class="note">El enlace queda para todos los dispositivos y la PC arma la explicación. Si cargas un archivo, el video queda en este teléfono y puedes saltar a los minutos aunque no haya internet.</p>
      </div>
    </section>
    <h2>Clases</h2>
    <div class="grid">${mine}</div>`;
}

function homeHtml(classes, recordings, status) {
  if (window.claseClaraCloud) return phoneHome(classes);
  const mine = classes.length
    ? classes.map(cardHtml).join("")
    : '<p class="empty">Todavía no hay clases. La primera aparece aquí.</p>';
  const zoom = recordings.length
    ? recordings.map((item) => `
      <article class="card">
        <h3>${esc(item.name)}</h3>
        <p>${esc(item.when)} · ${esc(item.size_mb)} MB</p>
        <div class="actions"><button class="primary use-zoom" type="button" data-path="${esc(item.path)}">Procesar</button></div>
      </article>`).join("")
    : '<p class="empty">No veo grabaciones en Documentos\\Zoom.</p>';
  const ffmpeg = status.ffmpeg ? "" : '<p class="banner">Falta ffmpeg en esta computadora. Sin eso no puedo sacar el audio ni las capturas.</p>';
  return `
    <section class="hero">
      <p class="kicker">Tu clase, en claro</p>
      <h1>Entiende la clase sin volver a verla entera.</h1>
      <p class="lede">No entra a Zoom. Lee el video que ya descargaste, se queda con lo que se dijo y con las pantallas que cambian, y te lo explica para estudiar.</p>
      ${ffmpeg}
    </section>
    <section class="panel">
      <div class="drop" id="drop">
        <label for="path">Video o audio de la clase</label>
        <input id="path" type="text" placeholder="Pega la ruta o un enlace zoom.us/rec/play/">
        <div class="row">
          <button class="ghost" id="pick" type="button">Elegir video</button>
          <button class="primary" id="go" type="button">Procesar</button>
        </div>
        <label for="materia">Materia, si quieres afinar los nombres</label>
        <input id="materia" type="text" placeholder="Ejemplo: biología celular">
        <label for="terms">Palabras de la clase</label>
        <input id="terms" type="text" placeholder="Ejemplo: mitocondria, ATP, Krebs">
        <p class="note">Elegir video abre el explorador en Documentos\Zoom. Si no lo ves delante, mira la ventana ClaseClara en la barra de tareas. También puedes pegar un enlace de Zoom que abra sin clave: la PC baja el video, arma la clase y sube el texto y las diapositivas. El video no se sube.</p>
      </div>
    </section>
    <h2>Grabaciones de Zoom</h2>
    <div class="grid">${zoom}</div>
    <h2>Clases ya hechas</h2>
    <div class="grid">${mine}</div>`;
}

function cardHtml(item) {
  const state = item.status === "ready" ? "Lista" : item.status === "error" ? "Se detuvo" : "Preparando";
  const extra = item.status === "error" ? item.error : item.status === "ready" ? durationLabel(item.duration) : item.detail;
  const avisos = Number(item.avisos) || 0;
  const flag = avisos ? `<span class="status alert">${avisos} aviso${avisos === 1 ? "" : "s"}</span>` : "";
  return `
    <article class="card">
      <span class="status ${esc(item.status)}">${esc(state)}</span>
      ${flag}
      <h3>${esc(item.title || "Clase")}</h3>
      <p>${esc(item.materia || "")} ${esc(extra || "")}</p>
      <div class="actions">
        <button class="primary open-class" type="button" data-id="${esc(item.id)}">Abrir</button>
        <button class="ghost danger delete-class" type="button" data-id="${esc(item.id)}">Borrar</button>
      </div>
    </article>`;
}

async function showHome() {
  stopSpeech();
  stopPoll();
  shown = "";
  clase = null;
  document.title = "ClaseClara";
  const [status, list, zoom] = await Promise.all([
    api("/api/status"),
    api("/api/classes"),
    api("/api/zoom"),
  ]);
  renderKey(status);
  app.innerHTML = homeHtml(list.classes, zoom.recordings, status);
  const pick = document.querySelector("#pick");
  if (pick) pick.onclick = chooseFile;
  const go = document.querySelector("#go");
  if (go) {
    go.onclick = window.claseClaraCloud
      ? saveFromPhone
      : () => startPath(document.querySelector("#path").value.trim());
  }
  document.querySelectorAll(".use-zoom").forEach((button) => {
    button.onclick = () => startPath(button.dataset.path);
  });
  document.querySelectorAll(".open-class").forEach((button) => {
    button.onclick = () => openClass(button.dataset.id);
  });
  document.querySelectorAll(".delete-class").forEach((button) => {
    button.onclick = () => removeClass(button.dataset.id);
  });
  const drop = document.querySelector("#drop");
  if (!drop || !document.querySelector("#path")) return;
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
}

async function chooseFile() {
  const button = document.querySelector("#pick");
  button.disabled = true;
  button.textContent = "Mira la ventana ClaseClara en la barra…";
  try {
    const data = await api("/api/pick", { method: "POST" });
    if (data.path) document.querySelector("#path").value = data.path;
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Elegir video";
  }
}

function stepsHtml(job) {
  const order = ["audio", "frames", "transcript", "study"];
  const names = { audio: "Audio", frames: "Capturas", transcript: "Transcripción", study: "Explicación" };
  const current = order.indexOf(job.stage);
  return order.map((id, index) => {
    const cls = job.status === "ready" || index < current ? "done" : index === current ? "on" : "";
    return `<li class="${cls}">${names[id]}</li>`;
  }).join("");
}

function processHtml(job) {
  const actions = job.id
    ? `<button class="primary" id="retry" type="button">Reintentar</button>
       <button class="ghost" id="again" type="button">Transcribir de nuevo</button>`
    : "";
  const error = job.status === "error"
    ? `<p class="error" id="job-error">${esc(job.error || "Se detuvo.")}</p>
       <div class="row">${actions}<button class="ghost" id="back" type="button">Volver</button></div>`
    : `<p class="note" id="elapsed">${esc(elapsed(job.started))}</p>`;
  return `
    <section id="process" data-id="${esc(job.id || "")}">
      <p class="kicker">Preparando</p>
      <h1 class="big" id="detail">${esc(job.detail || "Trabajando…")}</h1>
      <ul class="steps" id="steps">${stepsHtml(job)}</ul>
      ${error}
      <p class="note">Una clase de una hora suele tardar unos minutos. Puedes dejar esta página abierta.</p>
    </section>`;
}

function bindProcess(job) {
  const back = document.querySelector("#back");
  if (back) back.onclick = showHome;
  const retry = document.querySelector("#retry");
  if (retry) retry.onclick = () => retryJob(job.id, false);
  const again = document.querySelector("#again");
  if (again) again.onclick = () => retryJob(job.id, true);
}

function renderProcess(job) {
  const same = document.querySelector("#process")?.dataset.id === (job.id || "") && shown === job.status;
  if (!same) {
    stopSpeech();
    shown = job.status;
    app.innerHTML = processHtml(job);
    bindProcess(job);
    return;
  }
  const detail = document.querySelector("#detail");
  const clock = document.querySelector("#elapsed");
  const steps = document.querySelector("#steps");
  if (detail) detail.textContent = job.detail || "Trabajando…";
  if (clock) clock.textContent = elapsed(job.started);
  if (steps) steps.innerHTML = stepsHtml(job);
}

async function saveFromPhone() {
  const link = document.querySelector("#link")?.value.trim() || "";
  const file = document.querySelector("#file")?.files?.[0] || null;
  if (!link && !file) {
    alert("Pega un enlace o carga un video.");
    return;
  }
  const button = document.querySelector("#go");
  button.disabled = true;
  try {
    const id = await window.claseClaraCloud.saveEntry({
      link,
      file,
      materia: materiaValue(),
      onProgress: (text) => { button.textContent = text; },
    });
    await openClass(id);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = "Guardar clase";
  }
}

async function startPath(path) {
  if (!path) {
    alert("Elige un video o pega un enlace.");
    return;
  }
  shown = "";
  const isLink = /^https?:\/\//i.test(path);
  renderProcess({ status: "processing", stage: "audio", detail: isLink ? "Bajando el video del enlace" : "Preparando el video", started: Math.floor(Date.now() / 1000) });
  try {
    const data = await api("/api/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isLink
        ? { url: path, materia: materiaValue(), terms: termsValue() }
        : { path, materia: materiaValue(), terms: termsValue() }),
    });
    watch(data.id);
  } catch (error) {
    renderProcess({ status: "error", stage: "error", error: error.message });
  }
}

function uploadFile(file) {
  shown = "";
  renderProcess({ status: "processing", stage: "audio", detail: "Subiendo el video…", started: Math.floor(Date.now() / 1000) });
  const body = new FormData();
  body.append("materia", materiaValue());
  body.append("terms", termsValue());
  body.append("file", file);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const detail = document.querySelector("#detail");
    if (detail) detail.textContent = `Subiendo el video… ${Math.round(event.loaded / event.total * 100)}%`;
  };
  xhr.onload = () => {
    let data = {};
    try { data = JSON.parse(xhr.responseText || "{}"); } catch { data = {}; }
    if (xhr.status >= 400) {
      renderProcess({ status: "error", stage: "error", error: data.error || "No se pudo subir el video." });
      return;
    }
    watch(data.id);
  };
  xhr.onerror = () => renderProcess({ status: "error", stage: "error", error: "No se pudo subir el video." });
  xhr.send(body);
}

function watch(id) {
  stopPoll();
  const tick = async () => {
    try {
      const job = await api(`/api/jobs/${id}`);
      renderProcess(job);
      if (job.status === "ready") {
        stopPoll();
        openClass(id);
      } else if (job.status === "error") {
        stopPoll();
      }
    } catch (error) {
      stopPoll();
      renderProcess({ id, status: "error", stage: "error", error: error.message });
    }
  };
  tick();
  poll = setInterval(tick, 1000);
}

async function saveTitle() {
  const input = document.querySelector("#class-title");
  const course = document.querySelector("#class-course");
  const title = input.value.trim();
  if (!title) {
    alert("Escribe un nombre.");
    return;
  }
  const button = document.querySelector("#rename button");
  button.disabled = true;
  try {
    const saved = await api(`/api/classes/${clase.id}/title`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, materia: course.value }),
    });
    clase.title = saved.title;
    clase.materia = saved.materia;
    clase.title_custom = saved.title_custom;
    if (clase.study) clase.study.titulo = saved.title;
    document.querySelector("#class-heading").textContent = saved.title;
    document.title = saved.title;
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

async function retryJob(id, retranscribe) {
  shown = "";
  renderProcess({ id, status: "processing", stage: "audio", detail: "Retomando la clase", started: Math.floor(Date.now() / 1000) });
  try {
    await api(`/api/classes/${id}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retranscribe }),
    });
    watch(id);
  } catch (error) {
    renderProcess({ id, status: "error", stage: "error", error: error.message });
  }
}

async function removeClass(id) {
  if (!confirm("¿Borrar esta clase de ClaseClara? El video original no se toca.")) return;
  await api(`/api/classes/${id}`, { method: "DELETE" });
  showHome();
}

function frameNote(study, index) {
  return (study.capturas || []).find((shot) => shot.indice === index + 1);
}

function frameSrc(data, file) {
  const name = String(file || "");
  if (/^(https?:|capacitor:|blob:|data:)/i.test(name)) return name;
  return `/media/${data.id}/frames/${name}`;
}

function playerHtml(data) {
  const src = data.media_src || (data.media_kind ? `/media/${data.id}/source` : "");
  if (!src) return "";
  const tag = data.media_kind === "audio" ? "audio" : "video";
  return `<${tag} id="player" class="player" controls playsinline preload="metadata" src="${esc(src)}"></${tag}>`;
}

function attachHtml() {
  if (!window.claseClaraCloud) return "";
  return `<div class="panel attach">
    <label for="attach-link">Enlace de Zoom para esta clase</label>
    <input id="attach-link" type="text" placeholder="https://....zoom.us/rec/play/...">
    <label for="attach-file">O carga el video en este teléfono</label>
    <input id="attach-file" type="file" accept="video/*,audio/*">
    <div class="row"><button class="primary" id="attach" type="button">Usar en esta clase</button></div>
  </div>`;
}

function studyHtml(data) {
  const study = data.study || {};
  const hasNotices = (study.avisos || []).length > 0;
  const shownTitle = data.title_custom ? (data.title || study.titulo || "Clase") : (study.titulo || data.title || "Clase");
  const frames = data.frames || [];
  const film = frames.map((frame, index) => {
    const note = frameNote(study, index);
    return `<button type="button" class="seek" data-time="${esc(durationStamp(frame.time))}">
      <img src="${esc(frameSrc(data, frame.file))}" alt="">
      <span>${esc(note?.que_muestra || durationStamp(frame.time))}</span>
    </button>`;
  }).join("");
  const player = playerHtml(data);
  return `
    <div class="layout">
      <section>
        <div class="study-head">
          <div>
            <p class="kicker">${esc(data.materia || "Clase")} ${esc(durationLabel(data.duration))}</p>
            <h1 id="class-heading">${esc(shownTitle)}</h1>
            <p class="idea">${esc(study.idea || "")}</p>
            <form id="rename" class="rename">
              <div class="grow">
                <label for="class-title">Nombre de la clase</label>
                <input id="class-title" type="text" maxlength="140" value="${esc(shownTitle)}">
              </div>
              <div>
                <label for="class-course">Curso</label>
                <input id="class-course" type="text" maxlength="120" placeholder="Ejemplo: psicología" value="${esc(data.materia || "")}">
              </div>
              <button class="ghost" type="submit">Guardar nombre</button>
            </form>
          </div>
          <div class="row">
            <button class="ghost" id="back" type="button">Inicio</button>
            <button class="ghost danger" id="delete" type="button">Borrar</button>
          </div>
        </div>
        ${player}
        ${attachHtml()}
        ${data.notice ? `<aside class="banner"><p>${esc(data.notice)}</p></aside>` : ""}
        <div class="film">${film}</div>
        ${noticesBanner(data)}
        <div class="listen">
          <button class="ghost" id="listen" type="button" aria-pressed="false">Escuchar</button>
          <p class="note" id="listen-note" hidden></p>
        </div>
        <div class="tabs" role="tablist">
          ${tab("avisos", "Avisos", hasNotices, hasNotices)}
          ${tab("explicacion", "Explicación", !hasNotices)}
          ${tab("resumen", "Resumen", false)}
          ${tab("esquema", "Esquema", false)}
          ${tab("glosario", "Glosario", false)}
          ${tab("repaso", "Repaso", false)}
          ${tab("capturas", "Capturas", false)}
          ${tab("links", "Links", false)}
          ${tab("texto", "Transcripción", false)}
        </div>
        <div id="panels">
          <div data-panel="avisos" ${hasNotices ? "" : "hidden"}>${noticesHtml(data)}</div>
          <div data-panel="explicacion" ${hasNotices ? "hidden" : ""}>${explainHtml(study)}</div>
          <div data-panel="resumen" hidden>${summaryHtml(study)}</div>
          <div data-panel="esquema" hidden>${mapHtml(study)}</div>
          <div data-panel="glosario" hidden>${termsHtml(study)}</div>
          <div data-panel="repaso" hidden>${quizHtml(study)}</div>
          <div data-panel="capturas" hidden>${shotsHtml(data)}</div>
          <div data-panel="links" hidden>${linksHtml(study)}</div>
          <div data-panel="texto" hidden>${transcriptHtml(data.lines || [])}</div>
        </div>
      </section>
      <aside class="panel chat">
        <h2>Pregunta a la clase</h2>
        <div class="chips">
          <button class="chip" type="button">Explícame la parte difícil como si tuviera 15 años</button>
          <button class="chip" type="button">Hazme un esquema de lo más importante</button>
          <button class="chip" type="button">¿Qué encargó el profesor y para cuándo hay que presentarlo?</button>
          <button class="chip" type="button">¿Qué podría entrar en un examen?</button>
        </div>
        <div class="messages" id="messages">${chatHtml(data.chat || [])}</div>
        <form class="composer" id="chat-form">
          <textarea id="question" rows="2" placeholder="Pregunta con lo que se dijo en la clase"></textarea>
          <button class="primary" type="submit">Enviar</button>
        </form>
      </aside>
    </div>`;
}

function tab(id, label, selected, warn) {
  return `<button type="button" class="${warn ? "warn" : ""}" role="tab" data-tab="${id}" aria-selected="${selected ? "true" : "false"}">${label}</button>`;
}

const AVISO_LABEL = {
  tarea: "Tarea",
  lectura: "Lectura",
  exposicion: "Exposición",
  reunion: "Reunión",
  examen: "Examen",
  aviso: "Aviso",
};

function noticesBanner(data) {
  const study = data.study || {};
  if (!Object.prototype.hasOwnProperty.call(study, "avisos")) {
    return `<aside class="banner">
      <p>Esta clase se guardó antes de buscar encargos. En Avisos está el botón para hacerlo con la transcripción que ya existe.</p>
    </aside>`;
  }
  const items = study.avisos || [];
  if (!items.length) return "";
  const lines = items.map((item) => {
    const kind = AVISO_LABEL[item.tipo] || "Aviso";
    const when = item.fecha ? ` Presentar: ${item.fecha}.` : " No se dijo la fecha.";
    return `<li><strong>${esc(kind)}.</strong> ${esc(item.titulo)}.${esc(when)}</li>`;
  }).join("");
  return `<aside class="banner avisos-banner">
    <p class="kicker">Avisos de esta clase</p>
    <ul>${lines}</ul>
    <button class="ghost" id="open-avisos" type="button">Ver el detalle</button>
  </aside>`;
}

function avisoShot(data, index) {
  const frame = (data.frames || [])[index - 1];
  if (!frame || index < 1) return "";
  return `<img src="${esc(frameSrc(data, frame.file))}" alt="Captura del encargo">`;
}

function avisoAction() {
  return `<div class="aviso-action">
    <button class="primary" id="find-avisos" type="button">Buscar avisos</button>
    <p class="note">Vuelve a leer lo que se dijo, sin transcribir otra vez. Si todavía no guardaste un nombre, también lo pone según el tema y el curso.</p>
  </div>`;
}

function noticesHtml(data) {
  const study = data.study || {};
  const action = avisoAction();
  if (!Object.prototype.hasOwnProperty.call(study, "avisos")) {
    return `${action}<p class="empty">Todavía no se buscaron encargos del profesor.</p>`;
  }
  const items = study.avisos || [];
  if (!items.length) {
    return `${action}<p class="empty">En esta clase no apareció una tarea, lectura, exposición, reunión ni otro encargo.</p>`;
  }
  return action + items.map((item) => {
    const kind = AVISO_LABEL[item.tipo] || "Aviso";
    const fecha = item.fecha
      ? `<p class="aviso-fecha">Presentar: ${esc(item.fecha)}</p>`
      : '<p class="aviso-fecha">No se dijo la fecha.</p>';
    const link = /^https?:\/\//i.test(item.enlace || "")
      ? `<p><a href="${esc(item.enlace)}" target="_blank" rel="noreferrer">${esc(item.enlace)}</a></p>`
      : "";
    const texto = item.texto
      ? `<div class="lectura"><p class="kicker">Texto o lectura</p>${rich(item.texto)}</div>`
      : "";
    const shot = avisoShot(data, Number(item.captura) || 0);
    const donde = item.donde_ver ? `<p>${esc(item.donde_ver)}</p>` : "";
    const salto = item.tiempo
      ? `<button type="button" class="seek" data-time="${esc(item.tiempo)}">Ver en el video ${esc(item.tiempo)}</button>`
      : "";
    return `<article class="block aviso">
      <p class="kicker">${esc(kind)}</p>
      <h3>${esc(item.titulo)}</h3>
      ${fecha}
      ${item.detalle ? rich(item.detalle) : ""}
      ${texto}
      ${shot}
      ${link}
      ${donde}
      ${salto}
    </article>`;
  }).join("");
}

function durationStamp(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function linksHtml(study) {
  const links = study.links || [];
  if (!links.length) {
    return '<p class="empty">No apareció ningún enlace en lo que se dijo ni en las diapositivas ya leídas.</p>';
  }
  return links.map((link) => {
    const youtube = youtubeHref(link.url || "");
    const href = youtube || (/^https?:\/\//i.test(link.url || "") ? link.url : "");
    if (!href) return "";
    const label = link.titulo && link.titulo !== href ? link.titulo : href;
    const when = link.tiempo
      ? `<button type="button" class="seek" data-time="${esc(link.tiempo)}">Ver en el video ${esc(link.tiempo)}</button>`
      : "";
    return `<article class="block link-item">
      <a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>
      <p><a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(href)}</a></p>
      ${when}
    </article>`;
  }).join("");
}

function explainHtml(study) {
  const hard = study.dificil ? `<article class="hard"><p class="kicker">Para entenderlo</p><p>${esc(study.dificil)}</p></article>` : "";
  const parts = (study.explicacion || []).map((part) => `
    <article class="block explain">
      <h3>${esc(part.titulo)}</h3>
      ${rich(part.texto)}
      ${part.ejemplo ? `<p class="example"><strong>Ejemplo. </strong>${linkify(esc(part.ejemplo))}</p>` : ""}
      ${youtubeCards(part.videos)}
    </article>`).join("");
  return hard + (parts || '<p class="empty">No hay explicación todavía.</p>');
}

function summaryHtml(study) {
  const points = (study.puntos || []).map((point) => `
    <button type="button" class="seek" data-time="${esc(point.tiempo)}"><b>${esc(point.tiempo)}</b> ${esc(point.texto)}</button>`).join("");
  return `<article class="block prose">${rich(study.resumen || "")}</article>
    <div class="moments">${points}</div>`;
}

function mapHtml(study) {
  const items = (study.esquema || []).map((topic) => `
    <li><strong>${esc(topic.texto)}</strong><ul>
      ${(topic.hijos || []).map((child) => `<li>${esc(child.texto)}<span>${esc(child.detalle || "")}</span></li>`).join("")}
    </ul></li>`).join("");
  return `<article class="block"><ol class="map">${items || "<li>No hay esquema.</li>"}</ol></article>`;
}

function termsHtml(study) {
  const rows = (study.terminos || []).map((term) => `<div><dt>${esc(term.termino)}</dt><dd>${esc(term.definicion)}</dd></div>`).join("");
  return `<article class="block"><dl class="terms">${rows || "<p>No hay términos.</p>"}</dl></article>`;
}

function quizHtml(study) {
  const cards = (study.repaso || []).map((item) => `
    <article class="block">
      <h3>${esc(item.pregunta)}</h3>
      <button class="ghost reveal" type="button">Ver respuesta</button>
      <p class="answer" hidden>${esc(item.respuesta)}</p>
    </article>`).join("");
  return cards || '<p class="empty">No hay preguntas de repaso.</p>';
}

function shotsHtml(data) {
  const study = data.study || {};
  const cards = (data.frames || []).map((frame, index) => {
    const note = frameNote(study, index);
    return `<figure class="shot">
      <img src="${esc(frameSrc(data, frame.file))}" alt="">
      <figcaption><b>${esc(durationStamp(frame.time))}</b> ${esc(note?.que_muestra || "Captura de la clase")}
        <strong>${esc(note?.por_que_importa || "")}</strong></figcaption>
    </figure>`;
  }).join("");
  return `<div class="shots">${cards || '<p class="empty">Este archivo no tenía imagen. La explicación sale del audio.</p>'}</div>`;
}

function transcriptHtml(lines) {
  if (!lines.length) return '<p class="empty">No hay transcripción.</p>';
  return lines.map((line) => `
    <div class="line"><button type="button" class="jump seek" data-time="${esc(line.stamp)}">${esc(line.stamp)}</button>
    <b>${esc(line.speaker)}</b> ${esc(line.text)}</div>`).join("");
}

function cleanSpeech(value) {
  return String(value ?? "").replace(/[*_`#>]/g, " ").replace(/\s+/g, " ").trim();
}

function speechFor(tab, data) {
  const study = data?.study || {};
  if (tab === "avisos") {
    return (study.avisos || []).map((item) => {
      const kind = AVISO_LABEL[item.tipo] || "Aviso";
      const when = item.fecha ? `Presentar: ${item.fecha}.` : "";
      const reading = item.texto ? `Texto o lectura. ${item.texto}` : "";
      return [kind, item.titulo, when, item.detalle, reading, item.donde_ver].map(cleanSpeech).filter(Boolean).join(". ");
    }).filter(Boolean).join("\n");
  }
  if (tab === "explicacion") {
    const parts = [];
    if (study.dificil) parts.push(`Para entenderlo. ${cleanSpeech(study.dificil)}`);
    for (const part of study.explicacion || []) {
      const block = [part.titulo, part.texto, part.ejemplo ? `Ejemplo. ${part.ejemplo}` : ""].map(cleanSpeech).filter(Boolean).join(". ");
      if (block) parts.push(block);
    }
    return parts.join("\n");
  }
  if (tab === "resumen") {
    const points = (study.puntos || []).map((point) => cleanSpeech(`${point.tiempo ? `Minuto ${point.tiempo}. ` : ""}${point.texto || ""}`));
    return [cleanSpeech(study.resumen), ...points].filter(Boolean).join("\n");
  }
  if (tab === "esquema") {
    return (study.esquema || []).map((topic) => {
      const children = (topic.hijos || []).map((child) => cleanSpeech(`${child.texto || ""}. ${child.detalle || ""}`)).filter(Boolean);
      return [cleanSpeech(topic.texto), ...children].filter(Boolean).join(". ");
    }).filter(Boolean).join("\n");
  }
  if (tab === "glosario") {
    return (study.terminos || []).map((term) => cleanSpeech(`${term.termino}. ${term.definicion}`)).filter(Boolean).join("\n");
  }
  if (tab === "repaso") {
    return (study.repaso || []).map((item) => cleanSpeech(`Pregunta. ${item.pregunta}. Respuesta. ${item.respuesta}`)).filter(Boolean).join("\n");
  }
  if (tab === "capturas") {
    return (data.frames || []).map((frame, index) => {
      const note = frameNote(study, index);
      return cleanSpeech(`Minuto ${durationStamp(frame.time)}. ${note?.que_muestra || "Captura de la clase"}. ${note?.por_que_importa || ""}`);
    }).filter(Boolean).join("\n");
  }
  if (tab === "links") {
    return (study.links || []).map((link) => {
      const title = cleanSpeech(link.titulo || "");
      const url = String(link.url || "");
      if (title && title !== url && !/^https?:/i.test(title)) return title;
      try {
        return `Enlace en ${new URL(url).hostname.replace(/^www\./, "")}`;
      } catch {
        return "";
      }
    }).filter(Boolean).join("\n");
  }
  if (tab === "texto") {
    return (data.lines || []).map((line) => cleanSpeech(`${line.speaker}. ${line.text}`)).filter(Boolean).join("\n");
  }
  return "";
}

function speechChunks(text) {
  const pieces = String(text || "").split(/\n+/).flatMap((line) => line.split(/(?<=[.!?;:])\s+/));
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    const bit = piece.trim();
    if (!bit) continue;
    if (bit.length > 1600) {
      if (current) chunks.push(current);
      for (let i = 0; i < bit.length; i += 1600) chunks.push(bit.slice(i, i + 1600));
      current = "";
      continue;
    }
    if (current && `${current} ${bit}`.length > 1600) {
      chunks.push(current);
      current = bit;
    } else {
      current = current ? `${current} ${bit}` : bit;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

let speechToken = 0;
let speechPulse = 0;

function listenNote(message) {
  const note = document.querySelector("#listen-note");
  if (!note) return;
  note.hidden = !message;
  note.textContent = message || "";
}

function spanishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const prefer = ["es-PE", "es-MX", "es-419", "es-ES", "es-US", "es-AR", "es-CL", "es-CO"];
  for (const code of prefer) {
    const found = voices.find((voice) => voice.lang.toLowerCase().replace("_", "-") === code.toLowerCase());
    if (found) return found;
  }
  return voices.find((voice) => voice.lang.toLowerCase().startsWith("es")) || null;
}

function stopSpeech() {
  speechToken += 1;
  clearInterval(speechPulse);
  window.speechSynthesis?.cancel();
  const button = document.querySelector("#listen");
  if (button) {
    button.textContent = "Escuchar";
    button.setAttribute("aria-pressed", "false");
  }
}

function startSpeech() {
  const synth = window.speechSynthesis;
  const button = document.querySelector("#listen");
  if (!button) return;
  if (!synth) {
    listenNote("Este navegador no lee en voz alta. Ábrelo en Edge o Chrome.");
    return;
  }
  if (button.getAttribute("aria-pressed") === "true") {
    stopSpeech();
    return;
  }
  const tab = document.querySelector("[data-tab][aria-selected='true']")?.dataset.tab || "";
  const chunks = speechChunks(speechFor(tab, clase));
  if (!chunks.length) {
    listenNote("Esta parte no tiene texto para leer.");
    return;
  }
  listenNote("");
  const player = document.querySelector("#player");
  if (player && !player.paused) player.pause();
  const token = ++speechToken;
  button.textContent = "Detener";
  button.setAttribute("aria-pressed", "true");
  let index = 0;
  let started = false;
  const speakNext = () => {
    if (token !== speechToken) return;
    if (index >= chunks.length) {
      stopSpeech();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    index += 1;
    const voice = spanishVoice();
    utterance.lang = voice?.lang || "es-ES";
    if (voice) utterance.voice = voice;
    utterance.rate = 1;
    utterance.onend = speakNext;
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      if (token === speechToken) stopSpeech();
    };
    synth.speak(utterance);
  };
  const begin = () => {
    if (started || token !== speechToken) return;
    started = true;
    speakNext();
    speechPulse = setInterval(() => {
      if (token !== speechToken || !synth.speaking) return;
      synth.pause();
      synth.resume();
    }, 10000);
  };
  if (synth.getVoices().length) begin();
  else {
    synth.addEventListener("voiceschanged", begin, { once: true });
    synth.getVoices();
    setTimeout(begin, 400);
  }
}

function chatHtml(messages) {
  if (!messages.length) return '<p class="empty" id="chat-empty">Pregunta con tus palabras. La respuesta sale de esta clase.</p>';
  return messages.map((message) => `<div class="bubble ${message.role === "user" ? "user" : ""}">${rich(message.content)}</div>`).join("");
}

function bindStudy() {
  document.querySelector("#back").onclick = showHome;
  const rename = document.querySelector("#rename");
  if (rename) rename.onsubmit = (event) => {
    event.preventDefault();
    saveTitle();
  };
  const findAvisos = document.querySelector("#find-avisos");
  if (findAvisos) findAvisos.onclick = () => retryJob(clase.id, false);
  const openAvisos = document.querySelector("#open-avisos");
  if (openAvisos) {
    openAvisos.onclick = () => document.querySelector('[data-tab="avisos"]')?.click();
  }
  document.querySelector("#delete").onclick = () => removeClass(clase.id);
  const listen = document.querySelector("#listen");
  if (listen) listen.onclick = startSpeech;
  const attach = document.querySelector("#attach");
  if (attach) {
    attach.onclick = async () => {
      const link = document.querySelector("#attach-link")?.value.trim() || "";
      const file = document.querySelector("#attach-file")?.files?.[0] || null;
      if (!link && !file) {
        alert("Pega un enlace o carga un video.");
        return;
      }
      attach.disabled = true;
      try {
        await window.claseClaraCloud.saveEntry({
          link,
          file,
          classId: clase.id,
          materia: document.querySelector("#class-course")?.value || "",
          onProgress: (text) => { attach.textContent = text; },
        });
        await openClass(clase.id);
      } catch (error) {
        alert(error.message);
        attach.disabled = false;
        attach.textContent = "Usar en esta clase";
      }
    };
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => {
      stopSpeech();
      document.querySelectorAll("[data-tab]").forEach((tabButton) => {
        tabButton.setAttribute("aria-selected", tabButton === button ? "true" : "false");
      });
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.hidden = panel.dataset.panel !== button.dataset.tab;
      });
    };
  });
  document.querySelectorAll(".reveal").forEach((button) => {
    button.onclick = () => {
      const answer = button.parentElement.querySelector(".answer");
      answer.hidden = !answer.hidden;
      button.textContent = answer.hidden ? "Ver respuesta" : "Ocultar respuesta";
    };
  });
  app.onclick = (event) => {
    const button = event.target.closest(".seek, .jump");
    if (!button || !app.contains(button)) return;
    const player = document.querySelector("#player");
    const seconds = parseTime(button.dataset.time || button.textContent);
    if (!player || seconds == null) return;
    stopSpeech();
    player.currentTime = seconds;
    player.play().catch(() => {});
  };
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.onclick = () => ask(chip.textContent);
  });
  document.querySelector("#chat-form").onsubmit = (event) => {
    event.preventDefault();
    const box = document.querySelector("#question");
    const text = box.value.trim();
    if (!text) return;
    box.value = "";
    ask(text);
  };
  const player = document.querySelector("#player");
  if (player) {
    player.addEventListener("play", () => stopSpeech());
    player.addEventListener("error", () => {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "El navegador no reproduce este formato. El resumen, las capturas y el chat sí están.";
      player.replaceWith(note);
    });
  }
}

async function openClass(id) {
  stopSpeech();
  stopPoll();
  const data = await api(`/api/classes/${id}`);
  if (data.status === "processing") {
    watch(id);
    return;
  }
  if (data.status === "error" && !data.study) {
    renderProcess(data);
    return;
  }
  clase = data;
  shown = "study";
  document.title = data.study?.titulo || data.title || "ClaseClara";
  app.innerHTML = studyHtml(data);
  bindStudy();
}

async function ask(question) {
  const messages = document.querySelector("#messages");
  document.querySelector("#chat-empty")?.remove();
  messages.insertAdjacentHTML("beforeend", `<div class="bubble user">${rich(question)}</div><div class="bubble" id="pending">Pensando con la clase…</div>`);
  messages.scrollTop = messages.scrollHeight;
  const form = document.querySelector("#chat-form");
  form.querySelector("button").disabled = true;
  try {
    const data = await api(`/api/classes/${clase.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question }),
    });
    clase.chat = data.chat;
    messages.innerHTML = chatHtml(data.chat);
  } catch (error) {
    document.querySelector("#pending").textContent = error.message;
  } finally {
    form.querySelector("button").disabled = false;
    messages.scrollTop = messages.scrollHeight;
  }
}

document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  showHome();
});

function startClaseClara() {
  showHome().catch((error) => {
    app.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  });
}

window.startClaseClara = startClaseClara;
if (!window.CLASECLARA_HOLD) startClaseClara();
