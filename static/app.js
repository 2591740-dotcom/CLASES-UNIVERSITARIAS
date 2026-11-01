const app = document.querySelector("#app");
const keybar = document.querySelector("#keybar");

const FILE_ACCEPT = "video/*,audio/*,.mp4,.mkv,.webm,.mov,.m4v,.avi,.m4a,.mp3,.wav,.aac,.ogg";

let poll = 0;
let homeToken = 0;
let homeCache = null;
let shown = "";
let clase = null;
let setup = null;

function fechaIso(value) {
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dayFirst = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  let year;
  let month;
  let day;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dayFirst) {
    day = Number(dayFirst[1]);
    month = Number(dayFirst[2]);
    year = Number(dayFirst[3]);
  } else {
    return "";
  }
  const found = new Date(year, month - 1, day);
  if (found.getFullYear() !== year || found.getMonth() !== month - 1 || found.getDate() !== day) return "";
  if (year < 2000) return "";
  const latest = new Date();
  latest.setDate(latest.getDate() + 1);
  latest.setHours(23, 59, 59, 999);
  if (found > latest) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function horaValida(value) {
  const text = String(value || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : "";
}

function fechaEnTexto(text) {
  const raw = String(text || "");
  const tagged = raw.match(/(?:GMT|UTC)(20\d{2})([01]\d)([0-3]\d)/i);
  if (tagged) {
    const found = fechaIso(`${tagged[1]}-${tagged[2]}-${tagged[3]}`);
    if (found) return found;
  }
  const separated = raw.match(/(20\d{2})[-_.]([01]\d)[-_.]([0-3]\d)/);
  if (separated) {
    const found = fechaIso(`${separated[1]}-${separated[2]}-${separated[3]}`);
    if (found) return found;
  }
  const compact = raw.match(/(?:^|[^\d])(20\d{2})([01]\d)([0-3]\d)(?:[^\d]|$)/);
  if (compact) {
    const found = fechaIso(`${compact[1]}-${compact[2]}-${compact[3]}`);
    if (found) return found;
  }
  const dayFirst = raw.match(/(?:^|[^\d])([0-3]\d)[./-]([01]\d)[./-](20\d{2})(?:[^\d]|$)/);
  if (!dayFirst) return "";
  const direct = fechaIso(`${dayFirst[3]}-${dayFirst[2]}-${dayFirst[1]}`);
  if (direct) return direct;
  return fechaIso(`${dayFirst[3]}-${dayFirst[1]}-${dayFirst[2]}`);
}

function fechaDelArchivo(file) {
  if (!file) return "";
  const named = fechaEnTexto(file.name || "");
  if (named) return named;
  const when = Number(file.lastModified);
  if (!Number.isFinite(when) || when < Date.UTC(2000, 0, 1)) return "";
  const day = new Date(when);
  return fechaIso(`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`);
}

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

function youtubeId(raw) {
  const href = youtubeHref(raw);
  const found = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return found ? found[1] : "";
}

const GENERICOS_ARCHIVO = new Set(["fuente", "video", "audio", "clase", "clase por enlace"]);

function claveFuenteValida(key) {
  const text = String(key || "").trim();
  if (text.startsWith("zoom:") && text.length >= 14 && text.length <= 300) return true;
  if (/^yt:[A-Za-z0-9_-]{11}$/.test(text)) return true;
  if (text.startsWith("archivo:") && text.length >= 12 && text.length <= 120 && text.split(":").length - 1 >= 2) return true;
  if (/^huella:[0-9a-f]{32}$/.test(text)) return true;
  if (text.startsWith("ruta:") && text.length >= 8 && text.length <= 400) return true;
  return false;
}

function limpiarFuentes(keys) {
  const clean = [];
  for (const item of keys || []) {
    const key = String(item || "").trim();
    if (!claveFuenteValida(key) || clean.includes(key)) continue;
    clean.push(key);
    if (clean.length >= 8) break;
  }
  return clean;
}

function fuenteZoom(url) {
  const text = String(url || "").trim().replace(/\s+/g, " ");
  if (!text || text.length > 2000) return "";
  let parsed;
  try { parsed = new URL(text); } catch { return ""; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !host.endsWith("zoom.us")) return "";
  const path = parsed.pathname;
  for (const marker of ["/rec/play/", "/rec/share/", "/rec/download/"]) {
    const at = path.indexOf(marker);
    if (at < 0) continue;
    const token = path.slice(at + marker.length).replace(/^\/+|\/+$/g, "").split("/")[0];
    if (token.length >= 8 && token.length <= 240) return `zoom:${host}/${token}`;
  }
  return "";
}

function fuenteYouTube(url) {
  const id = youtubeId(url);
  return id ? `yt:${id}` : "";
}

function fuenteArchivo(name, size) {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes < 1024 || bytes > 2500000000) return "";
  const base = String(name || "").split(/[/\\]/).pop() || "";
  const dot = base.lastIndexOf(".");
  let stem = dot > 0 ? base.slice(0, dot) : base;
  stem = stem.replace(/[_-]+/g, " ").replace(/\s+\(\d+\)$/, "");
  stem = stem.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!stem || GENERICOS_ARCHIVO.has(stem)) return "";
  return `archivo:${bytes}:${stem.slice(0, 80)}`;
}

async function fuenteHuella(file) {
  if (!file || file.size < 1024 || file.size > 2500000000 || !crypto?.subtle) return "";
  const chunk = 1024 * 1024;
  const head = new Uint8Array(await file.slice(0, chunk).arrayBuffer());
  let tail = new Uint8Array();
  if (file.size > chunk) tail = new Uint8Array(await file.slice(file.size - chunk).arrayBuffer());
  const sizeBytes = new TextEncoder().encode(String(file.size));
  const all = new Uint8Array(head.length + tail.length + sizeBytes.length);
  all.set(head, 0);
  all.set(tail, head.length);
  all.set(sizeBytes, head.length + tail.length);
  const digest = await crypto.subtle.digest("SHA-256", all);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `huella:${hex.slice(0, 32)}`;
}

function avisoDuplicado(titulo, tipo) {
  const nombre = String(titulo || "Clase").split(/\s+/).filter(Boolean).join(" ").slice(0, 80) || "Clase";
  const cosa = tipo === "enlace" ? "este enlace" : "este video";
  return `Ya cargaste ${cosa} en «${nombre}». Lo detengo para no prepararlo otra vez.`;
}

function clavesDeFila(row) {
  const keys = [fuenteZoom(row && row.video_url), fuenteYouTube(row && row.video_url)];
  const fuentes = (row && row.estudio && row.estudio.fuentes) || (row && row.estudio_fuentes);
  if (Array.isArray(fuentes)) keys.push(...fuentes);
  return limpiarFuentes(keys);
}

async function clavesDeEntrada({ link, file } = {}) {
  const keys = [];
  if (link) keys.push(fuenteZoom(link), fuenteYouTube(link));
  if (file) {
    keys.push(fuenteArchivo(file.name, file.size));
    try { keys.push(await fuenteHuella(file)); } catch { /* sin huella igual compara el nombre */ }
  }
  return limpiarFuentes(keys);
}

async function avisarDuplicado(found) {
  alert((found && found.error) || "Ya cargaste esto. Lo detengo para no prepararlo otra vez.");
  if (!found || !found.duplicado) return;
  try { await openClass(found.duplicado); } catch { /* el aviso ya detuvo la carga */ }
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
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    const error = new Error("No pude hablar con ClaseClara en esta computadora. Ábrelo con iniciar.bat y deja esa ventana abierta.");
    error.red = true;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "No se pudo completar.");
    if (data.duplicado) error.duplicado = data.duplicado;
    throw error;
  }
  return data;
}

function stopPoll() {
  clearInterval(poll);
  poll = 0;
}

function wikiHref(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    if (parsed.protocol !== "https:") return "";
    if (!/^[a-z]{2,3}\.wikipedia\.org$/i.test(parsed.hostname)) return "";
    if (parsed.pathname.startsWith("/wiki/") || parsed.pathname === "/w/index.php") return parsed.href;
  } catch {
    return "";
  }
  return "";
}

function linkWiki(html, wiki) {
  const items = (wiki || []).map((item) => ({
    frase: String(item.frase || "").trim(),
    href: wikiHref(item.url || ""),
    articulo: String(item.articulo || item.frase || "").trim(),
  })).filter((item) => item.frase.length >= 3 && item.href)
    .sort((a, b) => b.frase.length - a.frase.length);
  if (!items.length) return html;
  return String(html).split(/(<[^>]+>)/).map((chunk) => {
    if (!chunk || chunk.startsWith("<")) return chunk;
    const slots = [];
    let text = chunk;
    items.forEach((item, index) => {
      const needle = esc(item.frase);
      if (needle.length < 3) return;
      text = text.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (found) => {
        const id = slots.length;
        slots.push({ index, label: found });
        return `\u0000${id}\u0000`;
      });
    });
    return text.replace(/\u0000(\d+)\u0000/g, (_, id) => {
      const slot = slots[Number(id)];
      const item = slot && items[slot.index];
      if (!item) return slot ? slot.label : "";
      const tip = `Wikipedia: ${item.articulo || item.frase}`;
      return `<a class="wiki" href="${esc(item.href)}" target="_blank" rel="noreferrer" title="${esc(tip)}">${slot.label}</a>`;
    });
  }).join("");
}

const wikiSummaries = new Map();
let wikiPeekPlace = null;
let wikiPeekCloser = null;

function wikiTarget(href) {
  let parsed;
  try { parsed = new URL(href); } catch { return null; }
  const lang = parsed.hostname.split(".")[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) return null;
  if (parsed.pathname.startsWith("/wiki/")) {
    let title = parsed.pathname.slice(6);
    try { title = decodeURIComponent(title); } catch { /* el título ya venía legible */ }
    title = title.replace(/_/g, " ").trim();
    return title ? { lang, title } : null;
  }
  if (parsed.pathname === "/w/index.php") {
    const search = (parsed.searchParams.get("search") || "").trim();
    return search ? { lang, search } : null;
  }
  return null;
}

function shortWiki(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 320) return clean;
  const cut = clean.slice(0, 320);
  const dot = cut.lastIndexOf(". ");
  return dot >= 80 ? cut.slice(0, dot + 1) : `${cut.trim()}…`;
}

async function wikiExtract(lang, title) {
  const slug = encodeURIComponent(title.replace(/ /g, "_"));
  const response = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${slug}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return "";
  const data = await response.json().catch(() => ({}));
  return shortWiki(data.extract || data.description || "");
}

async function wikiSearchTitle(lang, search) {
  const params = new URLSearchParams({
    origin: "*",
    format: "json",
    action: "query",
    list: "search",
    srlimit: "1",
    srsearch: search,
  });
  const response = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  if (!response.ok) return "";
  const data = await response.json().catch(() => ({}));
  const hit = data.query && data.query.search && data.query.search[0];
  return hit ? String(hit.title || "") : "";
}

async function wikiSummary(href) {
  if (wikiSummaries.has(href)) return wikiSummaries.get(href);
  const target = wikiTarget(href);
  let text = "";
  if (target && target.title) text = await wikiExtract(target.lang, target.title);
  else if (target && target.search) {
    const title = await wikiSearchTitle(target.lang, target.search);
    if (title) text = await wikiExtract(target.lang, title);
  }
  const summary = text || "Toca para abrir Wikipedia.";
  wikiSummaries.set(href, summary);
  return summary;
}

function closeWikiPeek() {
  document.querySelector(".wiki-peek")?.remove();
  if (wikiPeekPlace) {
    window.removeEventListener("scroll", wikiPeekPlace, true);
    window.removeEventListener("resize", wikiPeekPlace);
    wikiPeekPlace = null;
  }
  if (wikiPeekCloser) {
    document.removeEventListener("pointerdown", wikiPeekCloser, true);
    wikiPeekCloser = null;
  }
}

function placeWikiPeek(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  let left = rect.left;
  if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
  if (left < margin) left = margin;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - margin) top = rect.top - height - 4;
  if (top < margin) top = margin;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function openWikiPeek(anchor) {
  closeWikiPeek();
  const pop = document.createElement("a");
  pop.className = "wiki-peek";
  pop.href = anchor.href;
  pop.target = "_blank";
  pop.rel = "noreferrer";
  pop.setAttribute("aria-label", "Resumen. Toca para abrir Wikipedia.");
  pop.innerHTML = `<span class="wiki-peek-text">Buscando…</span>`;
  document.body.appendChild(pop);
  const place = () => {
    if (!pop.isConnected) return;
    if (!anchor.isConnected) {
      closeWikiPeek();
      return;
    }
    placeWikiPeek(pop, anchor);
  };
  wikiPeekPlace = place;
  place();
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  wikiPeekCloser = (event) => {
    if (pop.contains(event.target)) return;
    closeWikiPeek();
  };
  document.addEventListener("pointerdown", wikiPeekCloser, true);
  pop.addEventListener("click", () => {
    setTimeout(closeWikiPeek, 0);
  });
  wikiSummary(anchor.href).then((text) => {
    if (!pop.isConnected) return;
    const line = pop.querySelector(".wiki-peek-text");
    if (line) line.textContent = text;
    place();
  }).catch(() => {
    if (!pop.isConnected) return;
    const line = pop.querySelector(".wiki-peek-text");
    if (line) line.textContent = "Toca para abrir Wikipedia.";
    place();
  });
}

function applyFondo(value) {
  const fondo = value === "oscuro" ? "oscuro" : "claro";
  if (fondo === "oscuro") document.documentElement.setAttribute("data-fondo", "oscuro");
  else document.documentElement.removeAttribute("data-fondo");
  try { localStorage.setItem("claseclara-fondo", fondo); } catch { /* el aparato puede bloquear el almacenamiento */ }
}

function fondoControl(value) {
  const dark = value === "oscuro";
  return `<span class="fondo" role="group" aria-label="Fondo">
    <button class="texty${dark ? "" : " on"}" id="fondo-claro" type="button" aria-pressed="${dark ? "false" : "true"}">Claro</button>
    <button class="texty${dark ? " on" : ""}" id="fondo-oscuro" type="button" aria-pressed="${dark ? "true" : "false"}">Negro</button>
  </span>`;
}

function fondoActual() {
  if (setup && (setup.fondo === "oscuro" || setup.fondo === "claro")) return setup.fondo;
  return document.documentElement.getAttribute("data-fondo") === "oscuro" ? "oscuro" : "claro";
}

function aplicacionAbierta() {
  if (window.claseClaraCloud) return Boolean(window.CLASECLARA_DENTRO);
  return true;
}

function renderChrome() {
  const dentro = aplicacionAbierta();
  const onPhone = phoneApp();
  const config = dentro && !onPhone
    ? `<button class="texty" id="open-config" type="button">Configurar</button>`
    : "";
  const salir = dentro && window.claseClaraCloud
    ? `<button class="texty" id="salir-cuenta" type="button" aria-label="Salir de la cuenta">Salir</button>`
    : "";
  keybar.innerHTML = `${config}${salir}${fondoControl(fondoActual())}`;
  document.querySelector("#fondo-claro").onclick = () => chooseFondo("claro");
  document.querySelector("#fondo-oscuro").onclick = () => chooseFondo("oscuro");
  const top = document.querySelector(".top");
  const configEnCabecera = () => [...top.children].find((el) => el.id === "open-config");
  if (onPhone) {
    if (dentro && !configEnCabecera()) {
      top.insertAdjacentHTML("afterbegin", `<button class="texty" id="open-config" type="button">Configurar</button>`);
    }
    if (!dentro) configEnCabecera()?.remove();
  }
  const configBtn = document.querySelector("#open-config");
  if (configBtn) configBtn.onclick = openConfig;
  const salirBtn = document.querySelector("#salir-cuenta");
  if (salirBtn) salirBtn.onclick = salirCuenta;
}

function renderKey(status) {
  setup = status || {};
  if (setup.fondo === "oscuro" || setup.fondo === "claro") applyFondo(setup.fondo);
  renderChrome();
}

function salirCuenta() {
  stopSpeech();
  stopPoll();
  closeWikiPeek();
  cerrarCursoModal();
  closeConfig();
  window.claseClaraCloud.salir();
}

async function chooseFondo(fondo) {
  const previous = fondoActual();
  if (fondo === previous) return;
  applyFondo(fondo);
  if (setup) setup.fondo = fondo;
  if (window.claseClaraCloud && !window.CLASECLARA_DENTRO) {
    renderChrome();
    return;
  }
  try {
    const status = await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fondo }),
    });
    renderKey(status);
  } catch (error) {
    applyFondo(previous);
    if (setup) setup.fondo = previous;
    renderChrome();
    alert(error.message);
  }
}

function providerOptions(providers, hearOnly) {
  return (providers || [])
    .filter((item) => (hearOnly ? item.hears : item.explains !== false))
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
      <div class="config-bar">
        <h2>Proveedor de IA</h2>
        <button class="ghost" id="cfg-close" type="button">Cerrar</button>
      </div>
      <p class="note">Al guardar, esta clave queda en tu cuenta. La computadora, la página y el teléfono usan la misma. Si dejas el campo en blanco, se conserva la actual.</p>
      <div class="config-grid">
        <div class="span-2">
          <label for="cfg-fondo">Fondo</label>
          <select id="cfg-fondo">
            <option value="claro">Claro</option>
            <option value="oscuro">Negro, letras blancas</option>
          </select>
        </div>
        <p class="note span-2">En negro, el texto queda blanco. El color se usa para resaltar enlaces, tiempos y avisos. El fondo elegido se ve igual en la computadora, la página y el teléfono.</p>
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
        <p class="note span-2" id="cfg-stt-note"></p>
        <p class="span-2" id="cfg-stt-link-row"><a id="cfg-stt-link" href="" target="_blank" rel="noreferrer">Dónde sacar la clave de la voz</a></p>
      </div>
      <div class="row">
        <button class="primary" id="cfg-save" type="button">Guardar</button>
      </div>
    </section>`;
  document.querySelector("#cfg-chat").value = chat.provider || "grok";
  document.querySelector("#cfg-fondo").value = status.fondo === "oscuro" ? "oscuro" : "claro";
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
  document.querySelector("#cfg-fondo").onchange = () => applyFondo(document.querySelector("#cfg-fondo").value);
  document.querySelector("#cfg-close").onclick = dismissConfig;
  document.querySelector("#cfg-save").onclick = saveConfig;
  if (!history.state || history.state.cc !== "config") history.pushState({ cc: "config" }, "");
}

let ignorePop = false;

function closeConfig() {
  const box = document.querySelector("#config");
  if (!box) return;
  box.hidden = true;
  box.innerHTML = "";
  applyFondo(setup && setup.fondo);
}

function dismissConfig() {
  const wasOpen = history.state && history.state.cc === "config";
  closeConfig();
  if (wasOpen) {
    ignorePop = true;
    history.back();
  }
}

function goHome() {
  if (window.CLASECLARA_HOLD) return;
  if (document.querySelector("#prepare-modal")) {
    cerrarPreparar();
    return;
  }
  const box = document.querySelector("#config");
  if (box && !box.hidden) {
    dismissConfig();
    return;
  }
  if (history.state && history.state.cc === "class") {
    history.back();
    return;
  }
  showHome();
}

window.addEventListener("popstate", () => {
  if (ignorePop) {
    ignorePop = false;
    return;
  }
  if (document.querySelector("#prepare-modal")) {
    cerrarPreparar(true);
    return;
  }
  const box = document.querySelector("#config");
  if (box && !box.hidden) {
    closeConfig();
    return;
  }
  if (document.querySelector("#class-heading") || document.querySelector("#process")) showHome();
});

window.claseClaraAtras = function () {
  if (window.CLASECLARA_HOLD) return false;
  const frame = document.querySelector("#frame-lightbox");
  if (frame && !frame.hidden) {
    closeFrame();
    return true;
  }
  if (document.querySelector(".wiki-peek")) {
    closeWikiPeek();
    return true;
  }
  if (document.querySelector("#course-modal")) {
    cerrarCursoModal();
    return true;
  }
  if (document.querySelector("#prepare-modal")) {
    cerrarPreparar();
    return true;
  }
  const config = document.querySelector("#config");
  if (config && !config.hidden && config.innerHTML) {
    dismissConfig();
    return true;
  }
  if (document.querySelector("#class-heading") || document.querySelector("#process")) {
    goHome();
    return true;
  }
  return false;
};

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
  const voiceSpec = sttId === "same" ? null : (providers.find((item) => item.id === sttId) || null);
  const voiceNote = document.querySelector("#cfg-stt-note");
  const voiceRow = document.querySelector("#cfg-stt-link-row");
  const voiceLink = document.querySelector("#cfg-stt-link");
  if (voiceNote) voiceNote.textContent = voiceSpec && voiceSpec.note ? voiceSpec.note : "";
  if (voiceRow && voiceLink) {
    if (voiceSpec && voiceSpec.key_url) {
      voiceRow.hidden = false;
      voiceLink.href = voiceSpec.key_url;
    } else {
      voiceRow.hidden = true;
    }
  }
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
        fondo: document.querySelector("#cfg-fondo").value,
      }),
    });
    dismissConfig();
    renderKey(status);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
}

function cabezaLista(titulo, hay) {
  const boton = hay
    ? `<button class="ghost" id="ordenar-fecha" type="button">Ordenar por fecha</button>`
    : "";
  return `<div class="list-head"><h2>${esc(titulo)}</h2>${boton}</div>`;
}

function phoneHome(classes, cursos) {
  const list = Array.isArray(classes) ? classes : [];
  const pack = cursos || { items: [], activo: "", nombre: "" };
  const estudio = window.CLASECLARA_ESTUDIO || {};
  const ambito = estudio.universidad ? `${estudio.carrera || ""} · ${estudio.universidad}` : "";
  const mine = list.length
    ? list.map(cardHtml).join("")
    : pack.nombre
      ? `<p class="empty">Todavía no hay clases en ${esc(pack.nombre)}. Carga un video o pega el enlace de Zoom.</p>`
      : `<p class="empty">Crea un curso para guardar aquí las clases${ambito ? ` de ${esc(estudio.carrera)}` : ""}.</p>`;
  return `
    <section class="hero">
      <p class="kicker">${esc(ambito || "Tu clase, en claro")}</p>
      <button class="capsule" id="curso-capsula" type="button">${esc(pack.nombre || "Curso")}</button>
      <h1>La mejor forma de Aprender.</h1>
      <button class="primary prepare-open" id="open-prepare" type="button">Preparar clase</button>
    </section>
    ${cabezaLista(pack.nombre || "Clases", list.length > 0)}
    <div class="grid">${mine}</div>`;
}

function homeHtml(classes, status, cursos) {
  const list = Array.isArray(classes) ? classes : [];
  const state = status || {};
  if (window.claseClaraCloud) return phoneHome(list, cursos);
  const pack = cursos || { items: [], activo: "", nombre: "" };
  const primero = pack.items[0] ? pack.items[0].id : "";
  const conocidos = new Set(pack.items.map((item) => item.id));
  const visibles = pack.activo
    ? list.filter((item) => {
      if (item.curso_id && !conocidos.has(item.curso_id)) return true;
      return (item.curso_id || primero) === pack.activo;
    })
    : list;
  const ordenadas = ordenarClases(visibles, leerOrdenLocal(pack.activo || "pc"));
  const mine = ordenadas.length
    ? ordenadas.map(cardHtml).join("")
    : pack.nombre
      ? `<p class="empty">Todavía no hay clases en ${esc(pack.nombre)}.</p>`
      : '<p class="empty">Todavía no hay clases. La primera aparece aquí.</p>';
  const ffmpeg = state.ffmpeg ? "" : '<p class="banner">Falta ffmpeg en esta computadora. Sin eso no puedo sacar el audio ni las capturas.</p>';
  return `
    <section class="hero">
      <p class="kicker">Tu clase, en claro</p>
      <button class="capsule" id="curso-capsula" type="button">${esc(pack.nombre || "Curso")}</button>
      <h1>Entiende la clase sin volver a verla entera.</h1>
      ${ffmpeg}
    </section>
    <section class="panel">
      <div class="drop" id="drop">
        <div class="fuente" id="fuente-link">
          <label for="path">Enlace de Zoom</label>
          <input id="path" type="text" placeholder="Pega un enlace zoom.us/rec/play/" autocomplete="off">
        </div>
        <div class="fuente" id="fuente-archivo">
          <label>Video de esta computadora</label>
          <button class="ghost" id="pick" type="button">Elegir video</button>
          <p class="picked" id="picked" hidden></p>
        </div>
        <div class="row">
          <button class="primary" id="go" type="button">Procesar</button>
        </div>
        <p class="note">Elegir video abre el explorador en Documentos\Zoom. Si pegas un enlace, la PC lo baja. El nombre de la clase sale de lo que se dijo; si queda mal, se corrige al abrirla.</p>
      </div>
    </section>
    ${cabezaLista(pack.nombre || "Clases ya hechas", ordenadas.length > 0)}
    <div class="grid">${mine}</div>`;
}

function ordenarClases(list, ids) {
  const rank = new Map();
  (Array.isArray(ids) ? ids : []).forEach((id, index) => {
    if (typeof id === "string" && !rank.has(id)) rank.set(id, index);
  });
  const known = [];
  const fresh = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (item && rank.has(item.id)) known.push(item);
    else fresh.push(item);
  });
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return fresh.concat(known);
}

function leerOrdenLocal(cursoId) {
  try {
    const all = JSON.parse(localStorage.getItem("cc-orden") || "{}");
    return all && Array.isArray(all[cursoId]) ? all[cursoId] : [];
  } catch {
    return [];
  }
}

function guardarOrdenLocal(cursoId, ids) {
  let all = {};
  try {
    const parsed = JSON.parse(localStorage.getItem("cc-orden") || "{}");
    if (parsed && typeof parsed === "object") all = parsed;
  } catch { /* se guarda de nuevo */ }
  all[cursoId || "pc"] = ids;
  localStorage.setItem("cc-orden", JSON.stringify(all));
}

function cardHtml(item) {
  const state = item.status === "ready" ? "Lista" : item.status === "error" ? "Se detuvo" : "Preparando";
  const extra = item.status === "error" ? item.error : item.status === "ready" ? durationLabel(item.duration) : item.detail;
  const avisos = Number(item.avisos) || 0;
  const flag = avisos ? `<span class="status alert">${avisos} aviso${avisos === 1 ? "" : "s"}</span>` : "";
  const fecha = fechaIso(item.fecha);
  const hora = horaValida(item.hora);
  const reloj = hora ? `<span class="card-hora">${esc(hora)}</span>` : "";
  return `
    <article class="card" data-id="${esc(item.id)}" data-fecha="${esc(fecha)}" data-hora="${esc(hora)}">
      <div class="card-top">
        <div class="card-marks">
          <span class="status ${esc(item.status)}">${esc(state)}</span>
          ${flag}
        </div>
        <div class="card-when">
          <input class="fecha-clase" type="date" data-id="${esc(item.id)}" value="${esc(fecha)}" aria-label="Fecha de la clase">
          ${reloj}
        </div>
      </div>
      <h3>${esc(item.title || "Clase")}</h3>
      ${extra ? `<p>${esc(extra)}</p>` : ""}
      <div class="actions">
        <button class="primary open-class" type="button" data-id="${esc(item.id)}">Abrir</button>
        <button class="ghost danger delete-class" type="button" data-id="${esc(item.id)}">Borrar</button>
      </div>
    </article>`;
}

const CURSO_PC = "Universidad César Vallejo\u0000Psicología";

function guardarCursoPc(items, activo) {
  const lista = Array.isArray(items) ? items : [];
  const id = lista.some((item) => item.id === activo) ? activo : (lista[0] ? lista[0].id : "");
  let all = {};
  try {
    const parsed = JSON.parse(localStorage.getItem("cc-curso") || "{}");
    if (parsed && typeof parsed === "object") all = parsed;
  } catch { /* se guarda de nuevo */ }
  if (id) all[CURSO_PC] = id;
  else delete all[CURSO_PC];
  localStorage.setItem("cc-curso", JSON.stringify(all));
  const actual = lista.find((item) => item.id === id);
  const pack = { items: lista, activo: id, nombre: actual ? actual.nombre : "" };
  window.CLASECLARA_CURSOS = pack;
  return pack;
}

function resolverCursoPc(cursos) {
  const items = (cursos && cursos.items) || [];
  let saved = "";
  try {
    const all = JSON.parse(localStorage.getItem("cc-curso") || "{}");
    saved = all && all[CURSO_PC] ? all[CURSO_PC] : "";
  } catch { /* sigue el primer curso */ }
  return guardarCursoPc(items, saved);
}

function cursoAccion() {
  if (window.claseClaraCloud) return window.claseClaraCloud;
  return {
    elegirCurso(id) {
      const pack = window.CLASECLARA_CURSOS || { items: [] };
      if (!pack.items.some((item) => item.id === id)) throw new Error("No encuentro ese curso.");
      return guardarCursoPc(pack.items, id);
    },
    async crearCurso(nombre) {
      const data = await api("/api/cursos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre }),
      });
      const limpio = String(nombre || "").trim().replace(/\s+/g, " ");
      const items = data.items || [];
      const creado = [...items].reverse().find((item) => item.nombre === limpio);
      if (!creado) throw new Error("No pude crear el curso.");
      return guardarCursoPc(items, creado.id);
    },
    async renombrarCurso(id, nombre) {
      const data = await api(`/api/cursos/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre }),
      });
      const activo = (window.CLASECLARA_CURSOS && window.CLASECLARA_CURSOS.activo) || id;
      return guardarCursoPc(data.items || [], activo);
    },
    async asignarCurso(classId, cursoId) {
      await api(`/api/classes/${classId}/curso`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ curso_id: cursoId }),
      });
    },
  };
}

function cerrarCursoModal() {
  document.querySelector("#course-modal")?.remove();
  document.removeEventListener("keydown", onCursoEscape);
}

function onCursoEscape(event) {
  if (event.key === "Escape") cerrarCursoModal();
}

let cursoEditHasta = 0;

function marcarFinEdicion() {
  cursoEditHasta = Date.now() + 450;
}

function clicDeEdicion() {
  return Date.now() < cursoEditHasta;
}

function alTocarCurso(elemento, alUnToque, alDosToques) {
  let toques = 0;
  let espera = 0;
  elemento.addEventListener("click", (event) => {
    if (clicDeEdicion() || elemento.hidden || elemento.dataset.editando === "1") return;
    toques += 1;
    if (toques === 1) {
      espera = window.setTimeout(() => {
        toques = 0;
        alUnToque();
      }, 500);
      return;
    }
    window.clearTimeout(espera);
    toques = 0;
    event.preventDefault();
    alDosToques();
  });
}

function nombreCursoNuevo() {
  const items = (window.CLASECLARA_CURSOS && window.CLASECLARA_CURSOS.items) || [];
  const nombres = new Set(items.map((item) => item.nombre));
  let nombre = "Curso nuevo";
  let numero = 2;
  while (nombres.has(nombre)) {
    nombre = `Curso nuevo ${numero}`;
    numero += 1;
  }
  return nombre;
}

function editarNombreCurso(origen, cursoId, alTerminar) {
  if (!cursoId || origen.dataset.editando === "1") return;
  origen.dataset.editando = "1";
  const previo = (origen.textContent || "").trim();
  const input = document.createElement("input");
  input.className = "capsule-edit";
  input.type = "text";
  input.maxLength = 80;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = previo === "Curso" ? "" : previo;
  input.setAttribute("aria-label", "Nombre del curso");
  origen.hidden = true;
  origen.insertAdjacentElement("afterend", input);
  input.focus();
  input.select();
  let listo = false;
  const terminar = async (guardar) => {
    if (listo) return;
    listo = true;
    marcarFinEdicion();
    const escrito = input.value.trim().replace(/\s+/g, " ");
    input.remove();
    origen.hidden = false;
    delete origen.dataset.editando;
    if (!guardar || !escrito || escrito === previo) {
      origen.textContent = previo || "Curso";
      if (alTerminar) alTerminar(previo, false);
      return;
    }
    try {
      const cambiado = await cursoAccion().renombrarCurso(cursoId, escrito);
      const final = (cambiado.items.find((item) => item.id === cursoId) || {}).nombre || escrito;
      origen.textContent = final;
      if (clase && clase.curso_id === cursoId) clase.curso = final;
      if (alTerminar) alTerminar(final, true);
    } catch (error) {
      origen.textContent = previo || "Curso";
      alert(error.message);
      if (alTerminar) alTerminar(previo, false);
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      terminar(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      terminar(false);
    }
  });
  input.addEventListener("blur", () => terminar(true));
}

function abrirCursoModal(destino) {
  cerrarCursoModal();
  const pack = window.CLASECLARA_CURSOS || { items: [], activo: "", nombre: "" };
  const deClase = destino === "clase";
  const actualId = deClase ? (clase && clase.curso_id) || "" : pack.activo;
  const lista = pack.items.map((item) => {
    const on = item.id === actualId ? " on" : "";
    return `<button class="course-pick${on}" type="button" data-id="${esc(item.id)}">${esc(item.nombre)}</button>`;
  }).join("");
  const modal = document.createElement("div");
  modal.id = "course-modal";
  modal.className = "course-modal";
  modal.innerHTML = `
    <div class="course-card" role="dialog" aria-modal="true" aria-labelledby="curso-titulo">
      <p class="kicker" id="curso-titulo">Curso</p>
      <div class="course-list">${lista || '<p class="empty">Todavía no hay cursos.</p>'}</div>
      <button class="primary" id="curso-agregar" type="button">Agregar curso</button>
      <p class="error" id="curso-error" hidden></p>
    </div>`;
  document.body.appendChild(modal);
  document.addEventListener("keydown", onCursoEscape);
  const fallo = (error) => {
    const note = modal.querySelector("#curso-error");
    note.hidden = false;
    note.textContent = error.message || "No pude guardar el curso.";
  };
  modal.addEventListener("click", (event) => {
    if (event.target === modal) cerrarCursoModal();
  });
  const usarCurso = async (id, nombre) => {
    if (deClase) {
      await cursoAccion().asignarCurso(clase.id, id);
      clase.curso_id = id;
      clase.curso = nombre;
      const capsula = document.querySelector("#clase-curso");
      if (capsula) capsula.textContent = nombre || "Curso";
      cerrarCursoModal();
      return;
    }
    cursoAccion().elegirCurso(id);
    cerrarCursoModal();
    await showHome();
  };
  modal.querySelectorAll(".course-pick").forEach((button) => {
    const id = button.dataset.id;
    const elegir = async () => {
      button.disabled = true;
      try {
        await usarCurso(id, button.textContent);
      } catch (error) {
        fallo(error);
        button.disabled = false;
      }
    };
    if (id === actualId) {
      alTocarCurso(button, elegir, () => {
        editarNombreCurso(button, id, (nombre, cambio) => {
          if (!cambio) return;
          if (deClase) {
            const capsula = document.querySelector("#clase-curso");
            if (capsula) capsula.textContent = nombre || "Curso";
            return;
          }
          cerrarCursoModal();
          showHome();
        });
      });
      return;
    }
    button.onclick = () => {
      if (clicDeEdicion()) return;
      elegir();
    };
  });
  modal.querySelector("#curso-agregar").onclick = async () => {
    if (clicDeEdicion()) return;
    const button = modal.querySelector("#curso-agregar");
    button.disabled = true;
    try {
      const creado = await cursoAccion().crearCurso(nombreCursoNuevo());
      if (deClase) {
        await cursoAccion().asignarCurso(clase.id, creado.activo);
        clase.curso_id = creado.activo;
        clase.curso = creado.nombre;
      }
      cerrarCursoModal();
      if (!deClase) await showHome();
      const capsula = document.querySelector(deClase ? "#clase-curso" : "#curso-capsula");
      if (capsula) {
        capsula.textContent = creado.nombre || "Curso";
        editarNombreCurso(capsula, creado.activo, (nombre, cambio) => {
          if (!cambio) return;
          if (deClase && clase) clase.curso = nombre;
          if (!deClase) showHome();
        });
      }
    } catch (error) {
      fallo(error);
      button.disabled = false;
    }
  };
}

function cerrarPreparar(desdeAtras) {
  const modal = document.querySelector("#prepare-modal");
  if (!modal) return;
  if (!desdeAtras && history.state && history.state.cc === "prepare") {
    ignorePop = true;
    history.back();
  }
  modal.remove();
}

function abrirPreparar() {
  if (document.querySelector("#prepare-modal")) return;
  const modal = document.createElement("div");
  modal.id = "prepare-modal";
  modal.className = "course-modal";
  modal.innerHTML = `
    <div class="course-card" role="dialog" aria-modal="true" aria-labelledby="prepare-titulo">
      <div class="config-bar">
        <h2 id="prepare-titulo">Preparar clase</h2>
        <button class="ghost" id="prepare-close" type="button">Cerrar</button>
      </div>
      <div class="drop" id="drop">
        <div class="fuente" id="fuente-link">
          <label for="link">Enlace de Zoom</label>
          <input id="link" type="text" placeholder="https://....zoom.us/rec/play/..." autocomplete="off">
        </div>
        <div class="fuente" id="fuente-archivo">
          <label for="file">Video o audio de este aparato</label>
          <input id="file" type="file" accept="${FILE_ACCEPT}">
        </div>
        <div class="row">
          <button class="primary" id="go" type="button">Preparar clase</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  if (!history.state || history.state.cc !== "prepare") history.pushState({ cc: "prepare" }, "");
  modal.addEventListener("click", (event) => {
    if (event.target === modal) cerrarPreparar();
  });
  modal.querySelector("#prepare-close").onclick = () => cerrarPreparar();
  modal.querySelector("#go").onclick = saveFromPhone;
  const drop = modal.querySelector("#drop");
  const fileInput = modal.querySelector("#file");
  enlazarFuente(drop);
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) setInputFile(fileInput, file);
  });
}

function cursoVisible() {
  const pack = window.CLASECLARA_CURSOS;
  return (pack && pack.activo) || "";
}

function pintarInicio(status, list) {
  const conservar = Boolean(document.querySelector(".grid"));
  const y = conservar ? window.scrollY : 0;
  renderKey(status);
  clearYouTube();
  unbindMiniPlayer();
  const cursos = window.claseClaraCloud ? list.cursos : resolverCursoPc(list.cursos);
  app.innerHTML = homeHtml(list.classes, status, cursos);
  const capsula = document.querySelector("#curso-capsula");
  if (capsula) {
    alTocarCurso(
      capsula,
      () => abrirCursoModal("inicio"),
      () => {
        const pack = window.CLASECLARA_CURSOS;
        if (!pack || !pack.activo) {
          abrirCursoModal("inicio");
          return;
        }
        editarNombreCurso(capsula, pack.activo, (_nombre, cambio) => {
          if (cambio) showHome();
        });
      },
    );
  }
  const pick = document.querySelector("#pick");
  if (pick) pick.onclick = chooseFile;
  const openPrepare = document.querySelector("#open-prepare");
  if (openPrepare) openPrepare.onclick = abrirPreparar;
  const go = document.querySelector("#go");
  if (go) go.onclick = () => {
    const link = document.querySelector("#path")?.value.trim() || "";
    startPath(link || chosenPath);
  };
  const homeDrop = document.querySelector("#drop");
  if (homeDrop && homeDrop.querySelector("#path")) enlazarFuente(homeDrop);
  document.querySelectorAll(".fecha-clase").forEach((input) => {
    input.dataset.prev = input.value;
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("change", () => guardarFecha(input));
  });
  document.querySelectorAll(".card-when").forEach((box) => {
    box.addEventListener("pointerdown", (event) => event.stopPropagation());
  });
  const ordenarFecha = document.querySelector("#ordenar-fecha");
  if (ordenarFecha) ordenarFecha.onclick = () => ordenarPorFecha();
  document.querySelectorAll(".open-class").forEach((button) => {
    button.onclick = () => openClass(button.dataset.id);
  });
  document.querySelectorAll(".delete-class").forEach((button) => {
    button.onclick = () => removeClass(button.dataset.id);
  });
  bindOrder();
  const drop = document.querySelector("#drop");
  const fileInput = document.querySelector("#file");
  if (drop && fileInput) {
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("over");
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) setInputFile(fileInput, file);
    });
  }
  if (drop && document.querySelector("#path")) {
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
  if (y) window.scrollTo(0, y);
}

async function showHome() {
  const token = ++homeToken;
  cerrarPreparar(true);
  cerrarCursoModal();
  closeWikiPeek();
  stopSpeech();
  stopPoll();
  shown = "";
  clase = null;
  document.title = "ClaseClara";
  const curso = cursoVisible();
  if (homeCache && homeCache.curso === curso) pintarInicio(homeCache.status, homeCache.list);
  let status;
  let list;
  try {
    [status, list] = await Promise.all([
      api("/api/status"),
      api("/api/classes"),
    ]);
  } catch (error) {
    if (token !== homeToken || shown !== "") return;
    if (homeCache && homeCache.curso === curso) return;
    throw error;
  }
  if (token !== homeToken || shown !== "") return;
  const cursos = window.claseClaraCloud ? list.cursos : resolverCursoPc(list.cursos);
  homeCache = { curso: (cursos && cursos.activo) || curso, status, list };
  pintarInicio(status, list);
}

function idsDelGrid(grid) {
  return [...grid.querySelectorAll(".card")]
    .map((card) => card.dataset.id)
    .filter((id) => /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id || ""));
}

function claveOrdenFecha(card) {
  const fecha = card.dataset.fecha || card.querySelector(".fecha-clase")?.value || "";
  const hora = card.dataset.hora || "";
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : "0000-00-00";
  const reloj = horaValida(hora) || "00:00";
  return `${dia}T${reloj}`;
}

async function ordenarPorFecha() {
  const grid = document.querySelector(".grid");
  const button = document.querySelector("#ordenar-fecha");
  if (!grid) return;
  const cards = [...grid.querySelectorAll(".card")];
  if (cards.length < 2) return;
  cards.sort((a, b) => claveOrdenFecha(b).localeCompare(claveOrdenFecha(a)));
  cards.forEach((card) => grid.appendChild(card));
  if (button) button.disabled = true;
  try {
    await guardarOrdenVisible(grid);
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

async function guardarOrdenVisible(grid) {
  const ids = idsDelGrid(grid);
  try {
    if (window.claseClaraCloud) {
      await api("/api/classes/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      return;
    }
    const pack = window.CLASECLARA_CURSOS;
    guardarOrdenLocal(pack && pack.activo ? pack.activo : "pc", ids);
  } catch (error) {
    alert(error.message);
    showHome();
  }
}

function prepararMover(event, card, grid) {
  if (event.button != null && event.button !== 0) return;
  if (card.classList.contains("holding") || card.classList.contains("dragging")) return;
  if (event.target.closest("button, a, input, textarea, select, label")) return;
  const origenX = event.clientX;
  const origenY = event.clientY;
  let activo = false;
  let cerrado = false;
  const timer = setTimeout(() => {
    if (cerrado) return;
    activo = true;
    card.classList.remove("holding");
    card.classList.add("dragging");
    try { card.setPointerCapture(event.pointerId); } catch { /* el dedo sigue moviendo la tarjeta */ }
    if (navigator.vibrate) navigator.vibrate(16);
  }, 1000);
  card.classList.add("holding");
  const frenarToque = (ev) => {
    if (activo && ev.cancelable) ev.preventDefault();
  };
  const move = (ev) => {
    if (!activo) {
      if (Math.hypot(ev.clientX - origenX, ev.clientY - origenY) > 12) terminar(false);
      return;
    }
    if (ev.cancelable) ev.preventDefault();
    const borde = 72;
    if (ev.clientY > window.innerHeight - borde) window.scrollBy(0, 28);
    else if (ev.clientY < borde) window.scrollBy(0, -28);
    const x = Math.max(8, Math.min(window.innerWidth - 8, ev.clientX));
    const y = Math.max(8, Math.min(window.innerHeight - 8, ev.clientY));
    const under = document.elementFromPoint(x, y);
    const target = under && under.closest ? under.closest(".card") : null;
    if (!target || target === card || target.parentElement !== grid) return;
    const cards = [...grid.querySelectorAll(".card")];
    const from = cards.indexOf(card);
    const to = cards.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    if (from < to) grid.insertBefore(card, target.nextElementSibling);
    else grid.insertBefore(card, target);
  };
  const terminar = (guardar) => {
    if (cerrado) return;
    cerrado = true;
    clearTimeout(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("touchmove", frenarToque);
    window.removeEventListener("pointerup", alSoltar);
    window.removeEventListener("pointercancel", alSoltar);
    const listo = activo;
    activo = false;
    card.classList.remove("holding", "dragging");
    if (guardar && listo) guardarOrdenVisible(grid);
  };
  const alSoltar = () => terminar(true);
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("touchmove", frenarToque, { passive: false });
  window.addEventListener("pointerup", alSoltar);
  window.addEventListener("pointercancel", alSoltar);
}

function bindOrder() {
  const grid = document.querySelector(".grid");
  if (!grid) return;
  const cards = [...grid.querySelectorAll(".card")];
  if (cards.length < 2) return;
  cards.forEach((card) => {
    card.addEventListener("contextmenu", (event) => {
      if (event.target.closest("button, a")) return;
      event.preventDefault();
    });
    card.addEventListener("pointerdown", (event) => prepararMover(event, card, grid));
  });
}

async function chooseFile() {
  const button = document.querySelector("#pick");
  button.disabled = true;
  button.textContent = "Mira la ventana ClaseClara en la barra…";
  try {
    const data = await api("/api/pick", { method: "POST" });
    if (data.path) {
      chosenPath = data.path;
      const path = document.querySelector("#path");
      if (path) path.value = "";
      const picked = document.querySelector("#picked");
      if (picked) {
        picked.hidden = false;
        picked.textContent = data.path.split(/[\\/]/).pop();
      }
      const drop = document.querySelector("#drop");
      if (drop) pintarFuente(drop);
    }
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
  const youtube = youtubeProgress(job);
  return `
    <section id="process" data-id="${esc(job.id || "")}">
      <p class="kicker">Preparando</p>
      <h1 class="big" id="detail">${esc(job.detail || "Trabajando…")}</h1>
      <div class="player-mark"></div>
      <div class="player-slot" id="process-player"><button class="player-grip" type="button" aria-label="Mover el video"></button></div>
      ${youtube}
      <ul class="steps" id="steps">${stepsHtml(job)}</ul>
      ${error}
      <p class="note">${window.claseClaraCloud
        ? "Se prepara en este aparato. Deja esta pantalla abierta. Una clase de una hora puede tardar varios minutos."
        : "Una clase de una hora suele tardar unos minutos. Puedes dejar esta página abierta."}</p>
    </section>`;
}

function youtubeProgress(job) {
  if ((job.media_kind === "youtube" && job.media_src) || job.youtube_state === "listo" || !job.youtube_state) return "";
  if (job.youtube_state === "error") {
    return `<p class="note">${esc(job.youtube_error || "No se pudo subir el video a YouTube.")}</p>`;
  }
  if (job.youtube_state === "falta") {
    return `<p class="note">Falta conectar el canal de YouTube en la computadora. Sin eso, el otro dispositivo no puede ver el video.</p>`;
  }
  return `<p class="note">El video se está subiendo a YouTube. En otro dispositivo aparecerá en esta clase, sin descargarlo.</p>`;
}

let droppedFile = null;
let chosenPath = "";

function pintarFuente(root) {
  if (!root) return;
  const link = root.querySelector("#path, #link");
  const enlace = root.querySelector("#fuente-link");
  const archivo = root.querySelector("#fuente-archivo");
  if (!link || !enlace || !archivo) return;
  const file = root.querySelector("#file");
  const hayLink = link.value.trim().length > 0;
  const hayArchivo = root.querySelector("#path")
    ? Boolean(chosenPath)
    : Boolean((file && file.files && file.files.length) || (file && droppedFile));
  enlace.classList.toggle("dim", hayArchivo);
  archivo.classList.toggle("dim", hayLink && !hayArchivo);
}

function enlazarFuente(root) {
  if (!root) return;
  const link = root.querySelector("#path, #link");
  const file = root.querySelector("#file");
  if (link) {
    link.addEventListener("input", () => {
      if (link.value.trim()) {
        if (root.querySelector("#path")) chosenPath = "";
        if (file) file.value = "";
        if (root.querySelector("#link")) droppedFile = null;
        const picked = root.querySelector("#picked");
        if (picked) {
          picked.hidden = true;
          picked.textContent = "";
        }
      }
      pintarFuente(root);
    });
  }
  if (file) {
    file.addEventListener("change", () => {
      if (file.files && file.files.length && link) link.value = "";
      pintarFuente(root);
    });
  }
  pintarFuente(root);
}

function setInputFile(input, file) {
  droppedFile = file;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    droppedFile = null;
  } catch { /* Preparar clase usa el archivo soltado */ }
  const root = input.closest("#drop");
  const link = root ? root.querySelector("#link") : null;
  if (link && file) link.value = "";
  if (root) pintarFuente(root);
}

function ensureProcessPlayer(job) {
  const slot = document.querySelector("#process-player");
  if (!slot || slot.dataset.ready === "1") return;
  const videoId = job.media_kind === "youtube" ? youtubeId(job.media_src || "") : "";
  if (videoId) {
    slot.dataset.ready = "1";
    slot.innerHTML = `${playerButtons(true)}<div id="player" class="player yt" data-yt="${esc(videoId)}"></div>`;
    mountYouTube(slot.querySelector("#player"));
    bindMiniPlayer();
    return;
  }
  if (!job.media_src) return;
  slot.dataset.ready = "1";
  const tag = job.media_kind === "audio" ? "audio" : "video";
  slot.innerHTML = `${playerButtons(false)}<${tag} id="player" class="player" controls playsinline preload="metadata" src="${esc(job.media_src)}"></${tag}>`;
  const player = slot.querySelector("#player");
  player?.addEventListener("play", () => stopSpeech());
  player?.addEventListener("error", () => {
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Este aparato todavía no reproduce ese video. Cuando termine de prepararse, vuelve a abrirlo.";
    player.replaceWith(note);
  });
  bindMiniPlayer();
}

function bindProcess(job) {
  const back = document.querySelector("#back");
  if (back) back.onclick = goHome;
  const retry = document.querySelector("#retry");
  if (retry) retry.onclick = () => retryJob(job.id, false);
  const again = document.querySelector("#again");
  if (again) again.onclick = () => retryJob(job.id, true);
}

function renderProcess(job) {
  const same = document.querySelector("#process")?.dataset.id === (job.id || "") && shown === job.status;
  if (!same) {
    homeToken += 1;
    stopSpeech();
    clearYouTube();
    unbindMiniPlayer();
    shown = job.status;
    app.innerHTML = processHtml(job);
    bindProcess(job);
    ensureProcessPlayer(job);
    return;
  }
  ensureProcessPlayer(job);
  const detail = document.querySelector("#detail");
  const clock = document.querySelector("#elapsed");
  const steps = document.querySelector("#steps");
  if (detail) detail.textContent = job.detail || "Trabajando…";
  if (clock) clock.textContent = elapsed(job.started);
  if (steps) steps.innerHTML = stepsHtml(job);
}

async function saveFromPhone() {
  const pack = window.CLASECLARA_CURSOS;
  if (!pack || !pack.activo) {
    abrirCursoModal("inicio");
    return;
  }
  const link = document.querySelector("#link")?.value.trim() || "";
  const file = document.querySelector("#file")?.files?.[0] || droppedFile || null;
  droppedFile = null;
  if (!link && !file) {
    alert("Pega un enlace o carga un video.");
    return;
  }
  const button = document.querySelector("#go");
  button.disabled = true;
  let id = "";
  try {
    id = await window.claseClaraCloud.saveEntry({
      link,
      file,
      fecha: file && !link ? fechaDelArchivo(file) : "",
      onProgress: (text) => { button.textContent = text; },
    });
  } catch (error) {
    alert(error.message);
    if (error && error.duplicado) {
      cerrarPreparar(true);
      try { await openClass(error.duplicado); } catch { /* el aviso ya detuvo la carga */ }
      return;
    }
    button.disabled = false;
    button.textContent = "Preparar clase";
    return;
  }
  cerrarPreparar(true);
  try {
    await openClass(id, { espera: true });
    if (window.claseClaraCloud && window.claseClaraCloud.preparar) {
      window.claseClaraCloud.preparar(id, { file, link });
    }
  } catch (error) {
    if (window.claseClaraCloud && window.claseClaraCloud.preparar) {
      window.claseClaraCloud.preparar(id, { file, link });
    }
    if (error && error.red) {
      shown = "";
      renderProcess({
        id,
        status: "processing",
        stage: "audio",
        detail: "Este aparato prepara la clase",
        started: Math.floor(Date.now() / 1000),
      });
      watch(id);
      return;
    }
    alert(error.message);
  }
}

async function startPath(path) {
  if (!path) {
    alert("Elige un video o pega un enlace.");
    return;
  }
  const pack = window.CLASECLARA_CURSOS;
  if (!pack || !pack.activo) {
    abrirCursoModal("inicio");
    return;
  }
  const isLink = /^https?:\/\//i.test(path);
  try {
    const found = await api("/api/classes/duplicado", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isLink ? { url: path } : { path }),
    });
    if (found && found.duplicado) {
      await avisarDuplicado(found);
      return;
    }
  } catch (error) {
    if (error && error.duplicado) {
      await avisarDuplicado({ duplicado: error.duplicado, error: error.message });
      return;
    }
  }
  shown = "";
  renderProcess({ status: "processing", stage: "audio", detail: isLink ? "Bajando el video del enlace" : "Preparando el video", started: Math.floor(Date.now() / 1000) });
  try {
    const data = await api("/api/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isLink ? { url: path, curso_id: pack.activo } : { path, curso_id: pack.activo }),
    });
    watch(data.id);
  } catch (error) {
    if (error && error.duplicado) {
      await avisarDuplicado({ duplicado: error.duplicado, error: error.message });
      return;
    }
    renderProcess({ status: "error", stage: "error", error: error.message });
  }
}

async function uploadFile(file) {
  try {
    const huella = await fuenteHuella(file);
    const found = await api("/api/classes/duplicado", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, size: file.size, huella }),
    });
    if (found && found.duplicado) {
      await avisarDuplicado(found);
      return;
    }
  } catch (error) {
    if (error && error.duplicado) {
      await avisarDuplicado({ duplicado: error.duplicado, error: error.message });
      return;
    }
  }
  shown = "";
  renderProcess({ status: "processing", stage: "audio", detail: "Subiendo el video…", started: Math.floor(Date.now() / 1000) });
  const body = new FormData();
  body.append("file", file);
  const fecha = fechaDelArchivo(file);
  if (fecha) body.append("fecha", fecha);
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
      if (data.duplicado) {
        avisarDuplicado({ duplicado: data.duplicado, error: data.error });
        return;
      }
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
      if (error && error.red) {
        if (!document.querySelector("#process")) {
          renderProcess({
            id,
            status: "processing",
            stage: "audio",
            detail: "Sin conexión. Sigo intentando…",
            started: Math.floor(Date.now() / 1000),
          });
        } else {
          const detail = document.querySelector("#detail");
          if (detail) detail.textContent = "Sin conexión. Sigo intentando…";
        }
        return;
      }
      stopPoll();
      renderProcess({ id, status: "error", stage: "error", error: error.message });
    }
  };
  tick();
  poll = setInterval(tick, 1000);
}

async function guardarFecha(input) {
  const id = input.dataset.id;
  const value = input.value;
  const anterior = input.dataset.prev || "";
  if (!id) return;
  if (!value) {
    input.value = anterior;
    return;
  }
  input.disabled = true;
  try {
    const saved = await api(`/api/classes/${id}/fecha`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fecha: value }),
    });
    input.value = fechaIso(saved.fecha) || value;
    input.dataset.prev = input.value;
    const card = input.closest(".card");
    if (card) {
      card.dataset.fecha = input.value;
      const hora = horaValida(saved.hora);
      card.dataset.hora = hora;
      const cuando = card.querySelector(".card-when");
      let span = cuando && cuando.querySelector(".card-hora");
      if (cuando && hora && !span) {
        span = document.createElement("span");
        span.className = "card-hora";
        cuando.appendChild(span);
      }
      if (span && hora) span.textContent = hora;
      if (span && !hora) span.remove();
    }
  } catch (error) {
    alert(error.message);
    input.value = anterior;
  } finally {
    input.disabled = false;
  }
}

async function saveTitle() {
  const input = document.querySelector("#class-title");
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
      body: JSON.stringify({ title, materia: clase.materia || "" }),
    });
    clase.title = saved.title;
    clase.materia = saved.materia;
    clase.title_custom = saved.title_custom;
    if (clase.study) clase.study.titulo = saved.title;
    document.querySelector("#class-heading").textContent = saved.title;
    document.title = saved.title;
    const form = document.querySelector("#rename");
    const opener = document.querySelector("#rename-open");
    if (form && form.classList.contains("open")) {
      form.classList.remove("open");
      if (opener) opener.hidden = false;
    }
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
  if (!confirm("Confirma otra vez. La clase se borra y no se puede recuperar.")) return;
  await api(`/api/classes/${id}`, { method: "DELETE" });
  if (homeCache && Array.isArray(homeCache.list?.classes)) {
    homeCache.list.classes = homeCache.list.classes.filter((item) => item.id !== id);
  }
  showHome();
}

function frameNote(study, index) {
  return (study.capturas || []).find((shot) => shot.indice === index + 1);
}

function frameButton(src, time, label, extra, eager) {
  const when = time ? ` data-time="${esc(time)}"` : "";
  const name = time ? `Ampliar captura, ${time}` : "Ampliar captura";
  const loading = eager ? "" : ' loading="lazy"';
  return `<button type="button" class="frame-open" data-src="${esc(src)}"${when} data-label="${esc(label || "")}" aria-label="${esc(name)}">
    <img src="${esc(src)}" alt=""${loading} decoding="async">
    ${extra || ""}
  </button>`;
}

function frameSrc(data, file) {
  const name = String(file || "");
  if (/^(https?:|capacitor:|blob:|data:)/i.test(name)) return name;
  return `/media/${data.id}/frames/${name}`;
}

let frameView = { scale: 1, x: 0, y: 0 };
let frameBox = null;

function zoomFrame(start, next, fx, fy) {
  const scale = Math.min(6, Math.max(1, next));
  const gain = scale / start.scale;
  const view = {
    scale,
    x: fx * (1 - gain) + start.x * gain,
    y: fy * (1 - gain) + start.y * gain,
  };
  if (scale === 1) {
    view.x = 0;
    view.y = 0;
  }
  return view;
}

function paintFrame() {
  const img = frameBox?.querySelector("img");
  if (!img) return;
  img.style.transform = `translate(${frameView.x}px, ${frameView.y}px) scale(${frameView.scale})`;
}

function closeFrame() {
  if (!frameBox || frameBox.hidden) return;
  frameBox.hidden = true;
  document.body.classList.remove("seeing-frame");
  const img = frameBox.querySelector("img");
  if (img) img.removeAttribute("src");
}

function openFrame(button) {
  const src = button.dataset.src || "";
  if (!src) return;
  const box = ensureFrameBox();
  const img = box.querySelector("img");
  frameView = { scale: 1, x: 0, y: 0 };
  img.src = src;
  img.alt = button.dataset.label || "Captura";
  paintFrame();
  box.hidden = false;
  document.body.classList.add("seeing-frame");
}

function ensureFrameBox() {
  if (frameBox) return frameBox;
  const box = document.createElement("div");
  box.id = "frame-lightbox";
  box.hidden = true;
  box.innerHTML = `
    <button type="button" id="frame-close">Cerrar</button>
    <div class="lightbox-stage">
      <img alt="">
    </div>`;
  document.body.appendChild(box);
  const stage = box.querySelector(".lightbox-stage");
  const img = box.querySelector("img");
  img.draggable = false;
  const pointers = new Map();
  let pinch = null;
  let drag = null;
  const center = (clientX, clientY) => {
    const rect = stage.getBoundingClientRect();
    return [clientX - rect.left - rect.width / 2, clientY - rect.top - rect.height / 2];
  };
  const applyZoom = (start, next, clientX, clientY) => {
    const [fx, fy] = center(clientX, clientY);
    frameView = zoomFrame(start, next, fx, fy);
    paintFrame();
  };
  box.querySelector("#frame-close").onclick = closeFrame;
  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyZoom(frameView, frameView.scale * factor, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener("pointerdown", (event) => {
    if (event.button > 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: 0 });
    try { stage.setPointerCapture(event.pointerId); } catch { /* el dedo sigue en la imagen */ }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale: frameView.scale,
        x: frameView.x,
        y: frameView.y,
      };
      drag = null;
    } else if (pointers.size === 1) {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, scale: frameView.scale, panX: frameView.x, panY: frameView.y };
    }
  });
  stage.addEventListener("pointermove", (event) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.moved += Math.abs(event.clientX - point.x) + Math.abs(event.clientY - point.y);
    point.x = event.clientX;
    point.y = event.clientY;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const [fx, fy] = center((a.x + b.x) / 2, (a.y + b.y) / 2);
      frameView = zoomFrame(pinch, pinch.scale * (dist / pinch.dist), fx, fy);
      paintFrame();
      return;
    }
    if (drag && drag.id === event.pointerId && frameView.scale > 1) {
      frameView.x = drag.panX + event.clientX - drag.x;
      frameView.y = drag.panY + event.clientY - drag.y;
      paintFrame();
    }
  });
  stage.addEventListener("pointerup", (event) => endFramePointer(event));
  stage.addEventListener("pointercancel", (event) => endFramePointer(event));
  let lastTap = 0;
  function endFramePointer(event) {
    const point = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    if (!point || point.moved > 12 || pointers.size) return;
    if (event.target === stage && frameView.scale === 1) {
      closeFrame();
      return;
    }
    const now = Date.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      if (frameView.scale > 1) {
        frameView = { scale: 1, x: 0, y: 0 };
        paintFrame();
      } else {
        applyZoom({ scale: 1, x: 0, y: 0 }, 2.5, event.clientX, event.clientY);
      }
      return;
    }
    lastTap = now;
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFrame();
  });
  frameBox = box;
  return box;
}

function playerHtml(data) {
  const yt = data.media_kind === "youtube" ? youtubeId(data.media_src) : "";
  if (yt) {
    return `<div class="player-mark"></div><div class="player-slot">${playerButtons(true)}<div id="player" class="player yt" data-yt="${esc(yt)}"></div></div>`;
  }
  const src = data.media_src || (data.media_kind ? `/media/${data.id}/source` : "");
  if (!src) return "";
  const tag = data.media_kind === "audio" ? "audio" : "video";
  return `<div class="player-mark"></div><div class="player-slot">${playerButtons(false)}<${tag} id="player" class="player" controls playsinline preload="metadata" src="${esc(src)}"></${tag}></div>`;
}

function htmlDelPanel(data, id) {
  const study = data.study || {};
  if (id === "avisos") return noticesHtml(data);
  if (id === "explicacion") return explainHtml(study, data.frames, data.lines);
  if (id === "resumen") return summaryHtml(study);
  if (id === "esquema") return mapHtml(study);
  if (id === "glosario") return termsHtml(study);
  if (id === "repaso") return quizHtml(study);
  if (id === "casos") return casesHtml(study);
  if (id === "capturas") return shotsHtml(data);
  if (id === "links") return linksHtml(study);
  if (id === "texto") return transcriptHtml(data.lines || []);
  return "";
}

function panelDeEstudio(data, id, oculto, activo) {
  const listo = id === activo;
  return `<div data-panel="${id}"${oculto ? " hidden" : ""}${listo ? ' data-listo="1"' : ""}>${listo ? htmlDelPanel(data, id) : ""}</div>`;
}

function studyHtml(data) {
  const study = data.study || {};
  const hasNotices = (study.avisos || []).length > 0;
  const shownTitle = data.title_custom ? (data.title || study.titulo || "Clase") : (study.titulo || data.title || "Clase");
  const frames = data.frames || [];
  const film = frames.map((frame, index) => {
    const note = frameNote(study, index);
    const stamp = durationStamp(frame.time);
    const label = note?.que_muestra || stamp;
    const detail = label !== stamp ? `<span class="film-note">${esc(label)}</span>` : "";
    return frameButton(frameSrc(data, frame.file), stamp, label, `<span class="film-time">${esc(stamp)}</span>${detail}`, index < 4);
  }).join("");
  const player = playerHtml(data);
  const when = durationLabel(data.duration);
  return `
    <div class="class-tools">
      <button class="ghost" id="back" type="button">Inicio</button>
      <button class="ghost danger" id="delete" type="button">Borrar</button>
    </div>
    <div class="layout">
      <section>
        <div class="study-head">
          <div>
            ${when ? `<p class="kicker">${esc(when)}</p>` : ""}
            <button class="capsule" id="clase-curso" type="button">${esc(data.curso || "Curso")}</button>
            <h1 id="class-heading">${esc(shownTitle)}</h1>
            <p class="idea">${esc(study.idea || "")}</p>
            <button class="texty" id="rename-open" type="button">Cambiar nombre</button>
            <form id="rename" class="rename">
              <div class="grow">
                <label for="class-title">Nombre de la clase</label>
                <input id="class-title" type="text" maxlength="140" value="${esc(shownTitle)}">
              </div>
              <button class="ghost" type="submit">Guardar</button>
              <p class="note rename-note">Sale de lo que se dijo en la clase. Cámbialo si el tema no coincide.</p>
            </form>
          </div>
        </div>
        ${player}
        ${data.notice ? `<aside class="banner"><p>${esc(data.notice)}</p></aside>` : ""}
        <div class="film">${film}</div>
        ${noticesBanner(data)}
        <div class="listen">
          <button class="ghost" id="listen" type="button" aria-pressed="false">Escuchar</button>
          <button class="ghost listen-rate" id="listen-rate" type="button" aria-label="Velocidad de la lectura: ${speechRateLabel(speechRate())}">${speechRateLabel(speechRate())}</button>
          <p class="note" id="listen-note" hidden></p>
        </div>
        <div class="tabs" role="tablist">
          ${tab("avisos", "Avisos", hasNotices, hasNotices)}
          ${tab("explicacion", "Explicación", !hasNotices)}
          ${tab("resumen", "Resumen", false)}
          ${tab("esquema", "Esquema", false)}
          ${tab("glosario", "Glosario", false)}
          ${tab("repaso", "Repaso", false)}
          ${(study.casos || []).length ? tab("casos", "Casos", false) : ""}
          ${tab("capturas", "Capturas", false)}
          ${tab("links", "Links", false)}
          ${tab("texto", "Transcripción", false)}
        </div>
        <div id="panels">
          ${panelDeEstudio(data, "avisos", !hasNotices, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "explicacion", hasNotices, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "resumen", true, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "esquema", true, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "glosario", true, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "repaso", true, hasNotices ? "avisos" : "explicacion")}
          ${(study.casos || []).length ? panelDeEstudio(data, "casos", true, hasNotices ? "avisos" : "explicacion") : ""}
          ${panelDeEstudio(data, "capturas", true, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "links", true, hasNotices ? "avisos" : "explicacion")}
          ${panelDeEstudio(data, "texto", true, hasNotices ? "avisos" : "explicacion")}
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
    <button class="aviso-link" id="open-avisos" type="button">Ver el detalle</button>
  </aside>`;
}

function avisoShot(data, index, time) {
  const frame = (data.frames || [])[index - 1];
  if (!frame || index < 1) return "";
  return frameButton(frameSrc(data, frame.file), time || "", "Captura del encargo");
}

function avisoAction() {
  return `<div class="aviso-action">
    <button class="primary" id="find-avisos" type="button">Buscar avisos</button>
    <p class="note">Vuelve a leer lo que se dijo, sin transcribir otra vez. Si ya guardaste el nombre, no lo cambia.</p>
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
  return action + items.map((item, index) => {
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
    const shot = avisoShot(data, Number(item.captura) || 0, item.tiempo);
    const donde = item.donde_ver ? `<p>${esc(item.donde_ver)}</p>` : "";
    const salto = item.tiempo
      ? `<button type="button" class="seek" data-time="${esc(item.tiempo)}">Ver en el video ${esc(item.tiempo)}</button>`
      : "";
    const respuesta = item.tipo === "tarea" ? `
      <div class="tarea-respuesta" data-aviso="${index}">
        <button class="ghost ver-respuesta" type="button">Ver la respuesta</button>
        <div class="respuesta-vista" hidden></div>
        <p class="note respuesta-nota" hidden></p>
      </div>` : "";
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
      ${respuesta}
    </article>`;
  }).join("");
}

function xmlTexto(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nombreArchivo(titulo, ext) {
  const base = String(titulo || "Tarea").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Tarea";
  return `${base}.${ext}`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
  const parts = [];
  const central = [];
  let offset = 0;
  files.forEach((file) => {
    const name = new TextEncoder().encode(file.name);
    const data = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ]);
    parts.push(local, name, data);
    central.push(new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + data.length;
  });
  let centralSize = 0;
  central.forEach((part) => { centralSize += part.length; });
  const end = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(offset), ...u16(0),
  ]);
  return new Blob([...parts, ...central, end], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function parrafoWord(text, bold, size) {
  const marca = bold ? "<w:b/>" : "";
  return `<w:p><w:r><w:rPr>${marca}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlTexto(text)}</w:t></w:r></w:p>`;
}

function wordDeTarea(doc) {
  const paras = [parrafoWord(doc.clase, true, 32), parrafoWord(doc.tarea, true, 28)];
  if (doc.fecha) paras.push(parrafoWord(doc.fecha, false, 22));
  paras.push(parrafoWord("", false, 22));
  if (doc.preguntas && doc.preguntas.length) {
    doc.preguntas.forEach((item) => {
      paras.push(parrafoWord(`${item.numero}. ${item.pregunta}`, true, 24));
      String(item.respuesta || "").split("\n").forEach((line) => paras.push(parrafoWord(line, false, 22)));
      paras.push(parrafoWord("", false, 22));
    });
  } else {
    String(doc.texto || "").split("\n").forEach((line) => paras.push(parrafoWord(line, false, 22)));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    { name: "word/document.xml", data: documentXml },
  ]);
}

function pdfLiteral(text) {
  let out = "";
  for (const ch of String(text || "")) {
    const code = ch.codePointAt(0);
    const byte = code <= 255 ? code : 63;
    if (byte === 92 || byte === 40 || byte === 41) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `(${out})`;
}

function partirLinea(text, max) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let current = "";
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
    } else current = next;
  });
  if (current) lines.push(current);
  return lines;
}

function lineasPdf(doc) {
  const lines = [];
  partirLinea(doc.clase, 62).forEach((text) => lines.push({ text, size: 16, gap: 22 }));
  lines.push({ text: "", size: 12, gap: 8 });
  partirLinea(doc.tarea, 78).forEach((text) => lines.push({ text, size: 13, gap: 18 }));
  if (doc.fecha) lines.push({ text: doc.fecha, size: 11, gap: 18 });
  lines.push({ text: "", size: 11, gap: 10 });
  const bloques = doc.preguntas && doc.preguntas.length
    ? doc.preguntas.flatMap((item) => [`${item.numero}. ${item.pregunta}`, "", ...(String(item.respuesta || "").split("\n")), ""])
    : String(doc.texto || "").split("\n");
  bloques.forEach((paragraph) => {
    if (!paragraph.trim()) {
      lines.push({ text: "", size: 11, gap: 10 });
      return;
    }
    const pregunta = /^\d{1,2}\.\s+\S/.test(paragraph.trim());
    partirLinea(paragraph.trim(), 90).forEach((text) => lines.push({ text, size: pregunta ? 12 : 11, gap: 15 }));
    lines.push({ text: "", size: 11, gap: 8 });
  });
  return lines;
}

function pdfBlob(lines) {
  const pages = [];
  let current = [];
  let y = 790;
  lines.forEach((line) => {
    if (y - line.gap < 56) {
      pages.push(current);
      current = [];
      y = 790;
    }
    y -= line.gap;
    current.push({ text: line.text, size: line.size, y });
  });
  if (current.length || !pages.length) pages.push(current);
  const objs = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"];
  const kids = [];
  pages.forEach((page) => {
    const commands = ["BT"];
    page.forEach((line) => {
      if (!line.text) return;
      commands.push(`/F1 ${line.size} Tf`);
      commands.push(`1 0 0 1 56 ${line.y} Tm`);
      commands.push(`${pdfLiteral(line.text)} Tj`);
    });
    commands.push("ET");
    const stream = commands.join("\n");
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contentId = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  });
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(" ")}] >>`;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((obj, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([body], { type: "application/pdf" });
}

function pdfDeTarea(doc) {
  return pdfBlob(lineasPdf(doc));
}

function blobABase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = () => reject(new Error("No pude preparar el archivo."));
    reader.readAsDataURL(blob);
  });
}

async function entregarArchivo(blob, name, nota) {
  if (!phoneApp()) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return;
  }
  const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  const fs = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
  if (!fs) throw new Error("No pude guardar el archivo en este teléfono.");
  await fs.writeFile({ path: name, data: await blobABase64(blob), directory: "DOCUMENTS" });
  if (nota) {
    nota.hidden = false;
    nota.textContent = "Se guardó en Documentos de la aplicación.";
  }
}

function preguntasDeRespuesta(data) {
  const payload = data && typeof data === "object" ? data : { texto: data };
  const lista = Array.isArray(payload.preguntas) ? payload.preguntas : [];
  const limpias = [];
  lista.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const pregunta = String(item.pregunta || "").replace(/\s+/g, " ").trim();
    const respuesta = String(item.respuesta || "").trim();
    if (!pregunta && !respuesta) return;
    const numero = Number(item.numero);
    limpias.push({
      numero: Number.isInteger(numero) && numero > 0 ? numero : index + 1,
      pregunta: pregunta.slice(0, 2000),
      respuesta: respuesta.slice(0, 8000),
    });
  });
  const numeros = limpias.map((item) => item.numero);
  if (limpias.length >= 2 && new Set(numeros).size === numeros.length) {
    limpias.sort((a, b) => a.numero - b.numero);
  }
  if (limpias.length) {
    return limpias.map((item, index) => ({ ...item, numero: index + 1 }));
  }
  const lineas = String(payload.texto || "").split("\n");
  const marcas = [];
  lineas.forEach((line, index) => {
    const match = line.trim().match(/^(?:pregunta\s*)?(\d{1,2})\s*[.)]\s+(\S.*)$/i);
    if (!match) return;
    marcas.push({ index, numero: Number(match[1]), pregunta: match[2].trim() });
  });
  if (marcas.length < 2 || marcas[0].numero !== 1) return [];
  const chosen = [marcas[0]];
  for (let i = 1; i < marcas.length; i += 1) {
    if (marcas[i].numero !== chosen[chosen.length - 1].numero + 1) break;
    chosen.push(marcas[i]);
  }
  if (chosen.length < 2) return [];
  return chosen.map((mark, pos) => {
    const end = chosen[pos + 1] ? chosen[pos + 1].index : lineas.length;
    return {
      numero: pos + 1,
      pregunta: mark.pregunta.slice(0, 2000),
      respuesta: lineas.slice(mark.index + 1, end).join("\n").trim().slice(0, 8000),
    };
  });
}

function documentoTarea(indice, data) {
  const study = (clase && clase.study) || {};
  const aviso = (study.avisos || [])[indice] || {};
  const payload = data && typeof data === "object" ? data : { texto: data };
  return {
    clase: study.titulo || (clase && clase.title) || "Clase",
    tarea: aviso.titulo || "Tarea",
    fecha: aviso.fecha ? `Presentar: ${aviso.fecha}` : "",
    texto: String(payload.texto || ""),
    preguntas: preguntasDeRespuesta(payload),
  };
}

async function exportarTarea(indice, data, formato) {
  const doc = documentoTarea(indice, data);
  const blob = formato === "pdf" ? pdfDeTarea(doc) : wordDeTarea(doc);
  const box = document.querySelector(`.tarea-respuesta[data-aviso="${indice}"]`);
  const nota = box ? box.querySelector(".respuesta-nota") : null;
  try {
    await entregarArchivo(blob, nombreArchivo(doc.tarea, formato === "pdf" ? "pdf" : "docx"), nota);
  } catch (error) {
    if (!nota) return;
    nota.hidden = false;
    nota.textContent = error.message || "No pude exportar.";
  }
}

function pintarRespuesta(box, data, indice) {
  const payload = data && typeof data === "object" ? data : { texto: data };
  const preguntas = preguntasDeRespuesta(payload);
  const cuerpo = preguntas.length
    ? preguntas.map((item) => `
      <article class="respuesta-pregunta">
        <p class="respuesta-enunciado"><span class="respuesta-num">${item.numero}.</span> <span>${esc(item.pregunta)}</span></p>
        ${item.respuesta ? `<div class="respuesta-cuerpo">${rich(item.respuesta)}</div>` : ""}
      </article>`).join("")
    : `<div class="respuesta-texto">${rich(String(payload.texto || ""))}</div>`;
  const vista = box.querySelector(".respuesta-vista");
  vista.hidden = false;
  vista.innerHTML = `
    <p class="kicker">Vista previa</p>
    ${cuerpo}
    <div class="row">
      <button class="ghost export-word" type="button">Word</button>
      <button class="ghost export-pdf" type="button">PDF</button>
    </div>`;
  vista.querySelector(".export-word").onclick = () => exportarTarea(indice, payload, "word");
  vista.querySelector(".export-pdf").onclick = () => exportarTarea(indice, payload, "pdf");
}

async function verRespuesta(button) {
  const box = button.closest(".tarea-respuesta");
  const indice = Number(box.dataset.aviso);
  const nota = box.querySelector(".respuesta-nota");
  button.disabled = true;
  button.textContent = "Preparando la respuesta…";
  nota.hidden = true;
  try {
    const data = await api(`/api/classes/${clase.id}/respuesta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ indice }),
    });
    if (!data.puede) {
      nota.hidden = false;
      nota.textContent = data.texto || "Con lo dicho en clase no alcanza para armar esta respuesta.";
      button.hidden = true;
      return;
    }
    pintarRespuesta(box, data, indice);
    button.hidden = true;
  } catch (error) {
    button.disabled = false;
    button.textContent = "Ver la respuesta";
    nota.hidden = false;
    nota.textContent = error.message || "No pude preparar la respuesta.";
  }
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

const TOPIC_STOP = new Set("para como esta este esto estas estos desde entre sobre tambien tiene tienen puede pueden clase tema parte ejemplo cuando donde porque pero cada todo toda todos todas hacia durante mediante segun cual cuales estan sido video minuto explicacion explica explicar aquella aquellos aquella bajo tras contra hasta".split(" "));

function foldWords(text) {
  const folded = String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return new Set((folded.match(/[a-z0-9]{4,}/g) || []).filter((word) => !TOPIC_STOP.has(word)));
}

function wordHit(word, other) {
  if (other.has(word)) return true;
  if (word.length < 5) return false;
  for (const item of other) {
    if (item.length >= 5 && (word.startsWith(item) || item.startsWith(word))) return true;
  }
  return false;
}

function overlapCount(left, right) {
  let count = 0;
  for (const word of left) if (wordHit(word, right)) count += 1;
  return count;
}

function topicScore(part, anchorWords) {
  return overlapCount(foldWords(part.titulo), anchorWords);
}

function clockStamp(value) {
  const text = String(value || "").trim();
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text) ? text : "";
}

function bestTopicTime(part, anchors) {
  let bestScore = 0;
  let bestSeconds = -1;
  let bestTime = "";
  for (const anchor of anchors) {
    const score = topicScore(part, anchor.words);
    if (score < 1) continue;
    if (score > bestScore || (score === bestScore && anchor.seconds >= bestSeconds)) {
      bestScore = score;
      bestSeconds = anchor.seconds;
      bestTime = anchor.tiempo;
    }
  }
  return bestTime;
}

function blockedMoment(lines) {
  if (!Array.isArray(lines) || lines.length !== 1) return null;
  const line = lines[0] || {};
  const seconds = Number(line.time);
  if (Number.isFinite(seconds) && seconds > 1) return seconds;
  const parsed = parseTime(line.stamp || "");
  return parsed > 1 ? parsed : null;
}

function topicTimes(study, frames, lines) {
  const parts = study.explicacion || [];
  const anchors = [];
  for (const point of study.puntos || []) {
    const when = clockStamp(point.tiempo);
    const words = foldWords(point.texto);
    if (when && words.size) anchors.push({ tiempo: when, seconds: parseTime(when) || 0, words });
  }
  for (const shot of study.capturas || []) {
    const index = Number(shot.indice);
    if (!index || index < 1 || index > (frames || []).length) continue;
    const frame = frames[index - 1];
    const words = foldWords(shot.que_muestra || "");
    if (!words.size) continue;
    const seconds = Number(frame.time) || 0;
    anchors.push({ tiempo: durationStamp(seconds), seconds, words });
  }
  const blocked = blockedMoment(lines);
  const usable = blocked == null
    ? anchors
    : anchors.filter((anchor) => Math.abs(anchor.seconds - blocked) > 2);
  usable.sort((left, right) => left.seconds - right.seconds || String(left.tiempo).localeCompare(String(right.tiempo)));
  return parts.map((part) => clockStamp(part.tiempo) || bestTopicTime(part, usable));
}

function explainHtml(study, frames, lines) {
  const wiki = study.wiki || [];
  const hard = study.dificil ? `<article class="hard"><p class="kicker">Para entenderlo</p><p>${linkWiki(esc(study.dificil), wiki)}</p></article>` : "";
  const times = topicTimes(study, frames, lines);
  const parts = (study.explicacion || []).map((part, index) => {
    const when = times[index];
    const title = esc(part.titulo || "Tema");
    const heading = when
      ? `<h3><button type="button" class="seek topic-mark" data-time="${esc(when)}"><b>${esc(when)}</b> ${title}</button></h3>`
      : `<h3>${linkWiki(title, wiki)}</h3>`;
    return `
    <article class="block explain">
      ${heading}
      ${linkWiki(rich(part.texto), wiki)}
      ${part.ejemplo ? `<p class="example"><strong>Ejemplo. </strong>${linkWiki(linkify(esc(part.ejemplo)), wiki)}</p>` : ""}
      ${youtubeCards(part.videos)}
    </article>`;
  }).join("");
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

function casesHtml(study) {
  return (study.casos || []).map((item) => {
    const when = clockStamp(item.tiempo);
    const salto = when
      ? `<button type="button" class="seek" data-time="${esc(when)}">Ver en el video ${esc(when)}</button>`
      : "";
    const questions = (item.preguntas || []).map((question) => {
      const answer = question.respuesta || "En la clase no se cerró la respuesta.";
      return `
      <div class="case-q">
        <h3>${esc(question.pregunta)}</h3>
        <button class="ghost reveal" type="button">Ver respuesta</button>
        <p class="answer" hidden>${esc(answer)}</p>
      </div>`;
    }).join("");
    return `<article class="block">
      <p class="kicker">Caso</p>
      <h3>${esc(item.titulo || "Caso")}</h3>
      ${rich(item.caso || "")}
      ${salto}
      ${questions || '<p class="note">El profesor presentó el caso y no hizo una pregunta.</p>'}
    </article>`;
  }).join("");
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
    const label = note?.que_muestra || "Captura de la clase";
    return `<figure class="shot">
      ${frameButton(frameSrc(data, frame.file), durationStamp(frame.time), label)}
      <figcaption><b>${esc(durationStamp(frame.time))}</b> ${esc(label)}
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

function decirMinuto(stamp) {
  const parts = String(stamp || "").trim().split(":");
  if (parts.length < 2 || parts.length > 3) return "";
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return "";
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (parts.length === 3) {
    hours = numbers[0];
    minutes = numbers[1];
    seconds = numbers[2];
    if (hours > 99 || minutes > 59 || seconds > 59) return "";
  } else {
    seconds = numbers[1];
    if (seconds > 59 || numbers[0] > 59 * 99) return "";
    hours = Math.floor(numbers[0] / 60);
    minutes = numbers[0] % 60;
  }
  if (!hours && !minutes && !seconds) return "el comienzo";
  const bits = [];
  if (hours) bits.push(hours === 1 ? "1 hora" : `${hours} horas`);
  if (minutes) bits.push(minutes === 1 ? "1 minuto" : `${minutes} minutos`);
  if (seconds) bits.push(seconds === 1 ? "1 segundo" : `${seconds} segundos`);
  if (bits.length === 1) return bits[0];
  if (bits.length === 2) return `${bits[0]} y ${bits[1]}`;
  return `${bits[0]}, ${bits[1]} y ${bits[2]}`;
}

function fraseMinuto(stamp) {
  const said = decirMinuto(stamp);
  if (!said) return "";
  if (said === "el comienzo") return "Al comienzo del video.";
  return said.startsWith("1 hora") ? `A la ${said} del video.` : `A los ${said} del video.`;
}

function hablarTiempos(text) {
  return String(text || "").replace(/\d{1,2}:\d{2}(?::\d{2})?/g, (stamp, offset, source) => {
    const before = offset > 0 ? source[offset - 1] : "";
    const after = source[offset + stamp.length] || "";
    if (/\d/.test(before) || /\d/.test(after)) return stamp;
    return decirMinuto(stamp) || stamp;
  });
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
    const times = topicTimes(study, data.frames, data.lines);
    (study.explicacion || []).forEach((part, index) => {
      const when = fraseMinuto(times[index]);
      const block = [when, part.titulo, part.texto, part.ejemplo ? `Ejemplo. ${part.ejemplo}` : ""].map(cleanSpeech).filter(Boolean).join(". ");
      if (block) parts.push(block);
    });
    return parts.join("\n");
  }
  if (tab === "resumen") {
    const points = (study.puntos || []).map((point) => {
      const when = fraseMinuto(point.tiempo);
      return cleanSpeech(`${when ? `${when} ` : ""}${point.texto || ""}`);
    });
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
  if (tab === "casos") {
    return (study.casos || []).map((item) => {
      const questions = (item.preguntas || []).map((question) => {
        const answer = question.respuesta || "En la clase no se cerró la respuesta.";
        return cleanSpeech(`Pregunta. ${question.pregunta}. Respuesta. ${answer}`);
      }).filter(Boolean);
      return [cleanSpeech(`Caso. ${item.titulo}. ${item.caso}`), ...questions].filter(Boolean).join(". ");
    }).filter(Boolean).join("\n");
  }
  if (tab === "capturas") {
    return (data.frames || []).map((frame, index) => {
      const note = frameNote(study, index);
      return cleanSpeech(`${fraseMinuto(durationStamp(frame.time))} ${note?.que_muestra || "Captura de la clase"}. ${note?.por_que_importa || ""}`);
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

function speechChunks(text, maxLen) {
  const limit = Math.max(80, maxLen || 180);
  const pieces = String(text || "").split(/\n+/).flatMap((line) => line.split(/(?<=[.!?;:])\s+/));
  const chunks = [];
  let current = "";
  const pushLong = (bit) => {
    const parts = bit.split(/(?<=,)\s+/);
    let piece = "";
    const take = (value) => {
      const clean = value.trim();
      if (!clean) return;
      if (clean.length <= limit) {
        if (piece && `${piece} ${clean}`.length > limit) {
          chunks.push(piece);
          piece = clean;
        } else {
          piece = piece ? `${piece} ${clean}` : clean;
        }
        return;
      }
      if (piece) chunks.push(piece);
      piece = "";
      for (let i = 0; i < clean.length; i += limit) {
        const slice = clean.slice(i, i + limit).trim();
        if (slice) chunks.push(slice);
      }
    };
    parts.forEach(take);
    return piece;
  };
  for (const piece of pieces) {
    const bit = piece.trim();
    if (!bit) continue;
    if (bit.length > limit) {
      if (current) chunks.push(current);
      current = pushLong(bit);
      continue;
    }
    if (current && `${current} ${bit}`.length > limit) {
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
let speechPace = 0;
let speechPulse = 0;
let speechToggleAt = 0;
let phoneSpeech = null;
let speechKeepSrc = "";
let speechKeepAudio = null;
let speechKeepCtx = null;
let speechKeepOsc = null;
let speechRestart = null;
const SPEECH_RATES = [1, 1.25, 1.5, 2];

function speechRate() {
  try {
    const saved = Number(localStorage.getItem("cc-speech-rate"));
    if (SPEECH_RATES.includes(saved)) return saved;
  } catch { /* este aparato no guarda la velocidad */ }
  return 1;
}

function speechRateLabel(rate) {
  return `${String(rate).replace(".", ",")}×`;
}

function cycleSpeechRate() {
  const current = speechRate();
  const next = SPEECH_RATES[(SPEECH_RATES.indexOf(current) + 1) % SPEECH_RATES.length];
  try { localStorage.setItem("cc-speech-rate", String(next)); } catch { /* este aparato no guarda la velocidad */ }
  const button = document.querySelector("#listen-rate");
  if (button) {
    const label = speechRateLabel(next);
    button.textContent = label;
    button.setAttribute("aria-label", `Velocidad de la lectura: ${label}`);
  }
  if (document.querySelector("#listen")?.getAttribute("aria-pressed") !== "true") return;
  speechPace += 1;
  try { window.speechSynthesis?.cancel(); } catch { /* la voz cambia de velocidad */ }
  try { phoneSpeech?.stop(); } catch { /* la voz del teléfono cambia de velocidad */ }
}

function primeVoices() {
  try { window.speechSynthesis?.getVoices?.(); } catch { /* este aparato no tiene voz del navegador */ }
}

primeVoices();
window.speechSynthesis?.addEventListener?.("voiceschanged", primeVoices);

function phoneReader() {
  const cap = window.Capacitor;
  const injected = cap && cap.Plugins && cap.Plugins.ClaseClaraSpeech;
  if (injected && typeof injected.speak === "function" && typeof injected.stop === "function") {
    phoneSpeech = injected;
    return phoneSpeech;
  }
  if (!cap || typeof cap.registerPlugin !== "function") return null;
  const native = Boolean(window.androidBridge || (typeof cap.isNativePlatform === "function" && cap.isNativePlatform()));
  if (!native) return null;
  if (!phoneSpeech) phoneSpeech = cap.registerPlugin("ClaseClaraSpeech");
  return phoneSpeech;
}

function listenNote(message) {
  const note = document.querySelector("#listen-note");
  if (!note) return;
  note.hidden = !message;
  note.textContent = message || "";
}

function spanishVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const prefer = ["es-PE", "es-MX", "es-419", "es-ES", "es-US", "es-AR", "es-CL", "es-CO"];
  const spanish = voices.filter((voice) => String(voice.lang || "").toLowerCase().replace("_", "-").startsWith("es"));
  const ranked = [];
  for (const code of prefer) {
    spanish.forEach((voice) => {
      const lang = String(voice.lang || "").toLowerCase().replace("_", "-");
      if (lang === code.toLowerCase() && !ranked.includes(voice)) ranked.push(voice);
    });
  }
  spanish.forEach((voice) => {
    if (!ranked.includes(voice)) ranked.push(voice);
  });
  return ranked.find((voice) => voice.localService) || ranked[0] || null;
}

function speechKeepWav() {
  if (speechKeepSrc) return speechKeepSrc;
  const rate = 22050;
  const samples = rate;
  const data = samples * 2;
  const buffer = new ArrayBuffer(44 + data);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + data, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, data, true);
  for (let i = 0; i < samples; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 140 * i) / rate) * 900);
    view.setInt16(44 + i * 2, sample, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  speechKeepSrc = `data:audio/wav;base64,${btoa(binary)}`;
  return speechKeepSrc;
}

function holdSpeechTone() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!speechKeepCtx) {
      speechKeepCtx = new AudioCtx();
      const osc = speechKeepCtx.createOscillator();
      const gain = speechKeepCtx.createGain();
      osc.frequency.value = 140;
      osc.type = "sine";
      gain.gain.value = 0.004;
      osc.connect(gain);
      gain.connect(speechKeepCtx.destination);
      osc.start();
      speechKeepOsc = osc;
    }
    if (speechKeepCtx.state !== "running") {
      const again = speechKeepCtx.resume();
      if (again && again.catch) again.catch(() => {});
    }
  } catch { /* el navegador no sostiene el audio */ }
}

function releaseSpeechTone() {
  try { if (speechKeepOsc) speechKeepOsc.stop(); } catch { /* el tono ya se detuvo */ }
  speechKeepOsc = null;
  const ctx = speechKeepCtx;
  speechKeepCtx = null;
  try { if (ctx) ctx.close(); } catch { /* el audio ya se cerró */ }
}

function holdSpeechAlive() {
  holdSpeechTone();
  try {
    if (!speechKeepAudio) {
      speechKeepAudio = new Audio(speechKeepWav());
      speechKeepAudio.loop = true;
      speechKeepAudio.preload = "auto";
      speechKeepAudio.setAttribute("playsinline", "");
      speechKeepAudio.volume = 0.08;
      speechKeepAudio.addEventListener("timeupdate", () => {
        if (document.querySelector("#listen")?.getAttribute("aria-pressed") !== "true") return;
        holdSpeechTone();
        const synth = window.speechSynthesis;
        if (synth && synth.paused) {
          try { synth.resume(); } catch { /* la voz sigue */ }
        }
        if (document.hidden && typeof speechRestart === "function") speechRestart();
        if (!speechKeepAudio.paused) return;
        const again = speechKeepAudio.play();
        if (again && again.catch) again.catch(() => {});
      });
    }
    const playing = speechKeepAudio.play();
    if (playing && playing.catch) playing.catch(() => {});
  } catch { /* el navegador no sostiene el audio */ }
  try {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = "playing";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "ClaseClara está leyendo",
      artist: "ClaseClara",
    });
    const stop = () => {
      if (document.querySelector("#listen")?.getAttribute("aria-pressed") === "true") stopSpeech();
    };
    navigator.mediaSession.setActionHandler("pause", stop);
    navigator.mediaSession.setActionHandler("stop", stop);
  } catch { /* este aparato no muestra la lectura en la pantalla de bloqueo */ }
}

function releaseSpeechAlive() {
  releaseSpeechTone();
  try {
    if (speechKeepAudio) {
      speechKeepAudio.pause();
      speechKeepAudio.currentTime = 0;
    }
  } catch { /* el audio ya se detuvo */ }
  try {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = "none";
    navigator.mediaSession.setActionHandler("pause", null);
    navigator.mediaSession.setActionHandler("stop", null);
    navigator.mediaSession.metadata = null;
  } catch { /* sin controles de medios */ }
}

function stopSpeech() {
  speechToken += 1;
  speechRestart = null;
  clearInterval(speechPulse);
  releaseSpeechAlive();
  try { window.speechSynthesis?.cancel(); } catch { /* la voz ya se detuvo */ }
  try { phoneSpeech?.stop(); } catch { /* la voz del teléfono ya se detuvo */ }
  const button = document.querySelector("#listen");
  if (button) {
    button.textContent = "Escuchar";
    button.setAttribute("aria-pressed", "false");
  }
}

function resumeHiddenSpeech() {
  if (document.querySelector("#listen")?.getAttribute("aria-pressed") !== "true") return;
  holdSpeechTone();
  const synth = window.speechSynthesis;
  if (synth && synth.paused) {
    try { synth.resume(); } catch { /* la voz sigue */ }
  }
  if (speechKeepAudio && speechKeepAudio.paused) {
    const again = speechKeepAudio.play();
    if (again && again.catch) again.catch(() => {});
  }
  if (document.hidden && typeof speechRestart === "function") speechRestart();
}

document.addEventListener("visibilitychange", () => {
  resumeHiddenSpeech();
  setTimeout(resumeHiddenSpeech, 250);
  setTimeout(resumeHiddenSpeech, 1000);
});

function startSpeech() {
  const button = document.querySelector("#listen");
  if (!button) return;
  const now = Date.now();
  if (button.getAttribute("aria-pressed") === "true") {
    if (now - speechToggleAt < 450) return;
    stopSpeech();
    return;
  }
  const tab = document.querySelector("[data-tab][aria-selected='true']")?.dataset.tab || "";
  const reader = phoneReader();
  const mobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  const leido = speechFor(tab, clase);
  const chunks = speechChunks(tab === "texto" ? leido : hablarTiempos(leido), reader ? 380 : (mobileBrowser ? 140 : 900));
  if (!chunks.length) {
    listenNote("Esta parte no tiene texto para leer.");
    return;
  }
  const synth = window.speechSynthesis;
  if (!reader && !synth) {
    listenNote("Este aparato no lee en voz alta.");
    return;
  }
  listenNote("");
  ignoreVideoPlayUntil = Date.now() + 1600;
  pauseClassVideo();
  speechToggleAt = now;
  if (reader) {
    startPhoneSpeech(reader, chunks);
    return;
  }
  startBrowserSpeech(synth, chunks);
}

function markListening() {
  const button = document.querySelector("#listen");
  if (!button) return;
  button.textContent = "Detener";
  button.setAttribute("aria-pressed", "true");
}

function phoneSpeechNote(error) {
  const message = String((error && (error.message || error)) || "");
  if (message.includes("volumen")) return "Sube el volumen del teléfono y vuelve a tocar Escuchar.";
  return "El teléfono no pudo leer en voz alta. En Ajustes, abre Texto a voz y descarga una voz en español.";
}

function speakWithLimit(reader, texts) {
  const list = Array.isArray(texts) ? texts : [String(texts || "")];
  const text = list.join("\n");
  const budget = Math.min(21600000, Math.max(60000, (text.length / (4 * Math.max(speechRate(), 0.5))) * 1000 + 120000));
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { reader.stop(); } catch { /* la voz no contestó */ }
      reject(new Error("tiempo"));
    }, budget);
    reader.speak({ text, texts: list, rate: speechRate() }).then(
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function startPhoneSpeech(reader, chunks) {
  const token = ++speechToken;
  markListening();
  let index = 0;
  let indexBase = 0;
  const onPiece = (event) => {
    const next = Number(event && event.index);
    if (!Number.isFinite(next) || next < 0) return;
    index = Math.min(chunks.length - 1, indexBase + next);
  };
  let handle = null;
  try {
    const added = reader.addListener("piece", onPiece);
    if (added && typeof added.then === "function") added.then((next) => { handle = next; }).catch(() => {});
    else handle = added;
  } catch { /* la voz sigue sin avisar el tramo */ }
  try {
    while (index < chunks.length) {
      if (token !== speechToken) return;
      const pace = speechPace;
      indexBase = index;
      try {
        await speakWithLimit(reader, chunks.slice(indexBase));
      } catch (error) {
        if (token !== speechToken) return;
        if (pace !== speechPace) continue;
        if (String((error && error.message) || error) !== "tiempo") listenNote(phoneSpeechNote(error));
        stopSpeech();
        return;
      }
      if (token !== speechToken) return;
      if (pace !== speechPace) continue;
      break;
    }
  } finally {
    try { await handle?.remove(); } catch { /* el aviso ya se quitó */ }
  }
  if (token === speechToken) stopSpeech();
}

function startBrowserSpeech(synth, chunks) {
  const token = ++speechToken;
  markListening();
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  if (mobile) holdSpeechAlive();
  let index = 0;
  let nudgeUntil = 0;
  let fastFails = 0;
  let generation = 0;
  let spokenAt = 0;
  let pieceOpen = false;
  let pieceUntil = 0;
  let restarting = false;
  const android = /Android/i.test(navigator.userAgent || "");
  clearInterval(speechPulse);
  const speakNext = () => {
    if (token !== speechToken) return;
    if (index >= chunks.length) {
      stopSpeech();
      return;
    }
    const pace = speechPace;
    generation += 1;
    const mine = generation;
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    const voice = spanishVoice();
    utterance.lang = voice?.lang || "es-ES";
    // En Chrome de Android, fijar la voz corta la lectura a las pocas frases.
    if (voice && !android) utterance.voice = voice;
    utterance.rate = speechRate();
    let settled = false;
    const started = Date.now();
    spokenAt = started;
    pieceOpen = false;
    const seconds = utterance.text.length / (10 * Math.max(utterance.rate || 1, 0.5));
    pieceUntil = seconds * 1000;
    const watch = setTimeout(() => {
      if (settled || token !== speechToken || mine !== generation) return;
      if (document.hidden) return;
      settled = true;
      try { synth.cancel(); } catch { /* el navegador no avisó que terminó */ }
      index += 1;
      setTimeout(speakNext, 50);
    }, Math.min(180000, Math.max(8000, seconds * 1000 + 5000)));
    const advance = (delay) => {
      if (settled || token !== speechToken || mine !== generation) return;
      settled = true;
      clearTimeout(watch);
      pieceOpen = false;
      spokenAt = Date.now();
      index += 1;
      if (delay) setTimeout(speakNext, delay);
      else speakNext();
    };
    const finish = (error) => {
      if (settled || token !== speechToken || mine !== generation) return;
      if (pace !== speechPace) {
        settled = true;
        clearTimeout(watch);
        pieceOpen = false;
        speakNext();
        return;
      }
      if ((error === "interrupted" || error === "canceled") && document.hidden) {
        settled = true;
        clearTimeout(watch);
        pieceOpen = false;
        spokenAt = 0;
        setTimeout(() => {
          if (token !== speechToken || mine !== generation) return;
          if (typeof speechRestart === "function") speechRestart();
        }, 350);
        return;
      }
      if (error === "interrupted" || error === "canceled") {
        if (Date.now() < nudgeUntil) return;
        if (Date.now() - started < 400) {
          fastFails += 1;
          if (fastFails >= 2) {
            settled = true;
            clearTimeout(watch);
            listenNote("Este aparato no pudo leer en voz alta.");
            stopSpeech();
            return;
          }
        } else {
          fastFails = 0;
        }
        advance(android ? 50 : 0);
        return;
      }
      fastFails = 0;
      if (error) {
        settled = true;
        clearTimeout(watch);
        listenNote("Este aparato no pudo leer en voz alta.");
        stopSpeech();
        return;
      }
      advance(0);
    };
    utterance.onstart = () => {
      if (mine !== generation) return;
      pieceOpen = true;
      spokenAt = Date.now();
      fastFails = 0;
    };
    utterance.onend = () => finish("");
    utterance.onerror = (event) => finish((event && event.error) || "error");
    try { synth.resume(); } catch { /* sigue con la voz */ }
    try { synth.speak(utterance); } catch { finish("error"); }
  };
  if (mobile) {
    speechRestart = () => {
      if (token !== speechToken || !document.hidden || restarting) return;
      if (synth.paused) {
        try { synth.resume(); } catch { /* la voz sigue */ }
        return;
      }
      if (synth.speaking) return;
      const waited = Date.now() - spokenAt;
      if (pieceOpen) {
        if (waited < pieceUntil) return;
      } else if (waited < 1200) {
        return;
      }
      restarting = true;
      pieceOpen = false;
      generation += 1;
      try { synth.cancel(); } catch { /* la voz se vuelve a decir */ }
      setTimeout(() => {
        restarting = false;
        if (token !== speechToken) return;
        speakNext();
      }, 80);
    };
  }
  speakNext();
  if (android) return;
  speechPulse = setInterval(() => {
    if (token !== speechToken || document.hidden || !synth.speaking) return;
    nudgeUntil = Date.now() + 500;
    try {
      synth.pause();
      synth.resume();
    } catch { /* el navegador sigue solo */ }
  }, 10000);
}

function chatHtml(messages) {
  if (!messages.length) return '<p class="empty" id="chat-empty">Pregunta con tus palabras. La respuesta sale de esta clase.</p>';
  return messages.map((message) => `<div class="bubble ${message.role === "user" ? "user" : ""}">${rich(message.content)}</div>`).join("");
}

let miniOnScroll = null;
let miniFrame = 0;
let miniPlace = null;
let miniShownPlace = null;
let miniDrag = null;
let ignoreVideoPlayUntil = 0;
const MINI_PEEK = 32;
const HIDE_PEEK = 56;

function playerButtons(youtube) {
  const hide = youtube
    ? `<button class="player-hide" type="button" aria-label="Ocultar el video">Ocultar</button>`
    : "";
  return `<button class="player-grip" type="button" aria-label="Mover el video"></button>${hide}`;
}

function phoneApp() {
  const cap = window.Capacitor;
  return Boolean(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());
}

if (phoneApp()) document.documentElement.classList.add("phone-app");

function miniPlayerNext(isMini, markTop, headerHeight) {
  return isMini ? markTop < headerHeight + 48 : markTop < headerHeight - 8;
}

function clampMiniPlace(left, top, width, height) {
  const boxWidth = Math.max(width, MINI_PEEK);
  const boxHeight = Math.max(height, MINI_PEEK);
  return {
    left: Math.round(Math.min(window.innerWidth - MINI_PEEK, Math.max(MINI_PEEK - boxWidth, left))),
    top: Math.round(Math.min(window.innerHeight - MINI_PEEK, Math.max(MINI_PEEK - boxHeight, top))),
  };
}

function clearMiniOffset(slot) {
  slot.style.left = "";
  slot.style.top = "";
  slot.style.right = "";
  slot.style.bottom = "";
  slot.classList.remove("peek-top");
}

function syncHideButton(slot) {
  const button = slot.querySelector(".player-hide");
  if (!button) return;
  const hidden = slot.classList.contains("video-hidden");
  button.textContent = hidden ? "Ver" : "Ocultar";
  button.setAttribute("aria-label", hidden ? "Mostrar el video" : "Ocultar el video");
}

function toggleMiniVideo(slot) {
  if (!slot.classList.contains("mini")) return;
  const button = slot.querySelector(".player-hide");
  if (!button) return;
  if (slot.classList.contains("video-hidden")) {
    slot.classList.remove("video-hidden");
    if (phoneApp()) miniPlace = miniShownPlace;
    syncHideButton(slot);
    if (phoneApp() && miniPlace) applyMiniPlace(slot);
    else clearMiniOffset(slot);
    return;
  }
  const box = slot.getBoundingClientRect();
  miniShownPlace = miniPlace
    ? { left: miniPlace.left, top: miniPlace.top }
    : { left: Math.round(box.left), top: Math.round(box.top) };
  slot.classList.add("video-hidden");
  syncHideButton(slot);
  applyMiniPlace(slot);
}

function applyMiniPlace(slot) {
  if (!slot.classList.contains("mini")) {
    clearMiniOffset(slot);
    return;
  }
  if (slot.classList.contains("video-hidden")) {
    const width = Math.max(slot.offsetWidth, 220);
    const top = miniShownPlace ? miniShownPlace.top : (miniPlace ? miniPlace.top : 80);
    const place = {
      left: HIDE_PEEK - width,
      top: Math.round(Math.min(window.innerHeight - 48, Math.max(8, top))),
    };
    if (phoneApp()) miniPlace = place;
    slot.style.right = "auto";
    slot.style.bottom = "auto";
    slot.style.left = `${place.left}px`;
    slot.style.top = `${place.top}px`;
    slot.classList.remove("peek-top");
    return;
  }
  if (!phoneApp() || !miniPlace) {
    clearMiniOffset(slot);
    return;
  }
  const place = clampMiniPlace(miniPlace.left, miniPlace.top, slot.offsetWidth, slot.offsetHeight);
  miniPlace = place;
  slot.style.right = "auto";
  slot.style.bottom = "auto";
  slot.style.left = `${place.left}px`;
  slot.style.top = `${place.top}px`;
  slot.classList.toggle("peek-top", place.top < 8);
}

function unbindMiniDrag() {
  if (!miniDrag) return;
  const { grip, down, move, up } = miniDrag;
  grip.removeEventListener("pointerdown", down);
  grip.removeEventListener("pointermove", move);
  grip.removeEventListener("pointerup", up);
  grip.removeEventListener("pointercancel", up);
  miniDrag = null;
}

function bindMiniDrag(slot) {
  unbindMiniDrag();
  const grip = slot.querySelector(".player-grip");
  if (!grip || !phoneApp()) return;
  let drag = null;
  const down = (event) => {
    if (!slot.classList.contains("mini") || event.button > 0) return;
    const box = slot.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
    };
    try { grip.setPointerCapture(event.pointerId); } catch { /* el dedo sigue moviendo el video */ }
    event.preventDefault();
  };
  const move = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    miniPlace = clampMiniPlace(event.clientX - drag.dx, event.clientY - drag.dy, slot.offsetWidth, slot.offsetHeight);
    applyMiniPlace(slot);
    event.preventDefault();
  };
  const up = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag = null;
  };
  grip.addEventListener("pointerdown", down);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
  miniDrag = { grip, down, move, up };
}

function unbindMiniPlayer() {
  unbindMiniDrag();
  if (miniOnScroll) {
    window.removeEventListener("scroll", miniOnScroll);
    window.removeEventListener("resize", miniOnScroll);
  }
  miniOnScroll = null;
  if (miniFrame) cancelAnimationFrame(miniFrame);
  miniFrame = 0;
  const slot = document.querySelector(".player-slot");
  const mark = slot?.previousElementSibling;
  if (mark?.classList.contains("player-mark")) mark.style.height = "";
  if (slot) {
    delete slot.dataset.fullHeight;
    slot.classList.remove("mini", "video-hidden");
    syncHideButton(slot);
    clearMiniOffset(slot);
  }
  miniShownPlace = null;
}

function bindMiniPlayer() {
  unbindMiniPlayer();
  const slot = document.querySelector(".player-slot");
  const mark = slot?.previousElementSibling;
  if (!slot || !mark || !mark.classList.contains("player-mark")) return;
  if (!slot.querySelector("video, audio, iframe, [data-yt]")) return;
  document.documentElement.classList.toggle("phone-app", phoneApp());
  let needMeasure = true;
  let headerHeight = 0;
  const watch = () => {
    miniFrame = 0;
    if (!slot.isConnected) return;
    if (!slot.classList.contains("mini") && (needMeasure || !slot.dataset.fullHeight)) {
      const style = getComputedStyle(slot);
      const box = slot.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      slot.dataset.fullHeight = String(Math.round(box));
      needMeasure = false;
    }
    if (!headerHeight) headerHeight = document.querySelector(".top")?.getBoundingClientRect().height || 0;
    const top = mark.getBoundingClientRect().top;
    const next = miniPlayerNext(slot.classList.contains("mini"), top, headerHeight);
    mark.style.height = next ? `${slot.dataset.fullHeight || 0}px` : "";
    const wasMini = slot.classList.contains("mini");
    slot.classList.toggle("mini", next);
    if (next) applyMiniPlace(slot);
    else {
      if (wasMini) {
        slot.classList.remove("video-hidden");
        syncHideButton(slot);
        miniShownPlace = null;
      }
      clearMiniOffset(slot);
    }
  };
  const schedule = () => {
    if (miniFrame) return;
    miniFrame = requestAnimationFrame(watch);
  };
  miniOnScroll = (event) => {
    if (!event || event.type === "resize") {
      needMeasure = true;
      headerHeight = 0;
    }
    schedule();
  };
  window.addEventListener("scroll", miniOnScroll, { passive: true });
  window.addEventListener("resize", miniOnScroll, { passive: true });
  bindMiniDrag(slot);
  watch();
}

function llenarPanel(id) {
  if (!clase) return;
  const panel = document.querySelector(`[data-panel="${id}"]`);
  if (!panel || panel.dataset.listo === "1") return;
  panel.innerHTML = htmlDelPanel(clase, id);
  panel.dataset.listo = "1";
  panel.querySelectorAll(".ver-respuesta").forEach((button) => {
    button.onclick = () => verRespuesta(button);
  });
  panel.querySelectorAll(".reveal").forEach((button) => {
    button.onclick = () => {
      const answer = button.parentElement.querySelector(".answer");
      answer.hidden = !answer.hidden;
      button.textContent = answer.hidden ? "Ver respuesta" : "Ocultar respuesta";
    };
  });
  const findAvisos = panel.querySelector("#find-avisos");
  if (findAvisos) findAvisos.onclick = () => retryJob(clase.id, false);
}

function programarPaneles() {
  const tarde = new Set(["texto", "capturas"]);
  const pendientes = [...document.querySelectorAll("[data-panel]")].filter((panel) => panel.dataset.listo !== "1" && !tarde.has(panel.dataset.panel));
  const paso = () => {
    if (shown !== "study" || !clase) return;
    const panel = pendientes.shift();
    if (!panel) return;
    llenarPanel(panel.dataset.panel);
    if (!pendientes.length) return;
    if (window.requestIdleCallback) requestIdleCallback(paso, { timeout: 500 });
    else setTimeout(paso, 40);
  };
  if (window.requestIdleCallback) requestIdleCallback(paso, { timeout: 500 });
  else setTimeout(paso, 40);
}

function elegirPestana(id) {
  stopSpeech();
  closeWikiPeek();
  llenarPanel(id);
  document.querySelectorAll("[data-tab]").forEach((tabButton) => {
    tabButton.setAttribute("aria-selected", tabButton.dataset.tab === id ? "true" : "false");
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== id;
  });
}

function abrirAvisos() {
  elegirPestana("avisos");
  document.querySelector("[data-panel='avisos']")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindStudy() {
  document.querySelector("#back").onclick = goHome;
  const cursoClase = document.querySelector("#clase-curso");
  if (cursoClase) {
    alTocarCurso(
      cursoClase,
      () => abrirCursoModal("clase"),
      () => {
        if (!clase || !clase.curso_id) {
          abrirCursoModal("clase");
          return;
        }
        editarNombreCurso(cursoClase, clase.curso_id, (nombre) => {
          cursoClase.textContent = nombre || "Curso";
        });
      },
    );
  }
  bindMiniPlayer();
  const rename = document.querySelector("#rename");
  const renameOpen = document.querySelector("#rename-open");
  if (renameOpen && rename) {
    renameOpen.onclick = () => {
      rename.classList.add("open");
      renameOpen.hidden = true;
      document.querySelector("#class-title")?.focus();
    };
  }
  if (rename) rename.onsubmit = (event) => {
    event.preventDefault();
    saveTitle();
  };
  const findAvisos = document.querySelector("#find-avisos");
  if (findAvisos) findAvisos.onclick = () => retryJob(clase.id, false);
  document.querySelectorAll(".ver-respuesta").forEach((button) => {
    button.onclick = () => verRespuesta(button);
  });
  const openAvisos = document.querySelector("#open-avisos");
  if (openAvisos) openAvisos.onclick = () => abrirAvisos();
  document.querySelector("#delete").onclick = () => removeClass(clase.id);
  const listen = document.querySelector("#listen");
  if (listen) listen.onclick = startSpeech;
  const rate = document.querySelector("#listen-rate");
  if (rate) rate.onclick = cycleSpeechRate;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => {
      elegirPestana(button.dataset.tab);
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
    const frame = event.target.closest(".frame-open");
    if (frame && app.contains(frame)) {
      openFrame(frame);
      return;
    }
    const button = event.target.closest(".seek, .jump");
    if (!button || !app.contains(button)) return;
    const seconds = parseTime(button.dataset.time || button.textContent);
    if (seconds == null) return;
    seekClass(seconds);
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
  const player = document.querySelector("video#player, audio#player");
  if (player) {
    player.addEventListener("play", () => stopSpeech());
    player.addEventListener("error", () => {
      const note = document.createElement("p");
      note.className = "note";
      note.textContent = "El navegador no reproduce este formato. El resumen, las capturas y el chat sí están.";
      player.replaceWith(note);
    });
  }
  const ytNode = document.querySelector("#player[data-yt]");
  if (ytNode) mountYouTube(ytNode);
}

let ytPlayer = null;
let pendingSeek = null;
const ytReadyQueue = [];

function clearYouTube() {
  pendingSeek = null;
  const player = ytPlayer;
  ytPlayer = null;
  if (player && typeof player.destroy === "function") {
    try { player.destroy(); } catch { /* la pantalla ya cambió */ }
  }
}

function ensureYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  return new Promise((resolve) => {
    ytReadyQueue.push(resolve);
    if (document.querySelector("script[data-yt-api]")) return;
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      ytReadyQueue.splice(0).forEach((done) => done());
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.dataset.ytApi = "1";
    document.head.appendChild(script);
  });
}

function mountYouTube(node) {
  const videoId = node.dataset.yt;
  if (!videoId) return;
  ensureYouTubeApi().then(() => {
    if (!document.body.contains(node)) return;
    ytPlayer = new YT.Player(node, {
      videoId,
      host: "https://www.youtube-nocookie.com",
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
        origin: location.origin,
      },
      events: {
        onReady: (event) => {
          if (pendingSeek == null) return;
          const seconds = pendingSeek;
          pendingSeek = null;
          event.target.seekTo(seconds, true);
          event.target.playVideo();
        },
        onStateChange: (event) => {
          if (event.data === 1 && Date.now() >= ignoreVideoPlayUntil) stopSpeech();
        },
        onError: () => {
          const slot = document.querySelector(".player-slot");
          if (!slot || slot.querySelector(".note")) return;
          slot.insertAdjacentHTML("beforeend", '<p class="note">YouTube no abrió el video. El enlace tiene que permitir inserción.</p>');
        },
      },
    });
  }).catch(() => {});
}

function pauseClassVideo() {
  if (ytPlayer && typeof ytPlayer.pauseVideo === "function") {
    try { ytPlayer.pauseVideo(); } catch { /* todavía no está listo */ }
    return;
  }
  const player = document.querySelector("video#player, audio#player");
  if (player && !player.paused) player.pause();
}

function seekClass(seconds) {
  stopSpeech();
  const youtube = document.querySelector("#player[data-yt], iframe#player");
  if (youtube) {
    if (ytPlayer && typeof ytPlayer.seekTo === "function") {
      ytPlayer.seekTo(seconds, true);
      if (typeof ytPlayer.playVideo === "function") ytPlayer.playVideo();
    } else {
      pendingSeek = seconds;
    }
    return;
  }
  const player = document.querySelector("video#player, audio#player");
  if (!player) return;
  player.currentTime = seconds;
  player.play().catch(() => {});
}

async function openClass(id, opciones) {
  homeToken += 1;
  closeWikiPeek();
  stopSpeech();
  clearYouTube();
  stopPoll();
  const data = await api(`/api/classes/${id}`);
  const study = data.study || {};
  const hasStudy = (study.explicacion || []).length || study.resumen;
  if (data.status === "processing" || (data.status === "error" && !hasStudy)) {
    if (data.status === "processing") {
      watch(id);
      const detail = String(data.detail || "");
      const deAqui = /este aparato|transcribiendo|escribiendo la explicación|enviando el audio/i.test(detail);
      if (deAqui && !(opciones && opciones.espera) && window.claseClaraCloud && window.claseClaraCloud.preparar) {
        window.claseClaraCloud.preparar(id);
      }
    } else renderProcess(data);
    return;
  }
  clase = data;
  shown = "study";
  document.title = data.study?.titulo || data.title || "ClaseClara";
  app.innerHTML = studyHtml(data);
  bindStudy();
  programarPaneles();
  if (history.state && history.state.cc === "prepare") history.replaceState({ cc: "class" }, "");
  else if (!history.state || history.state.cc !== "class") history.pushState({ cc: "class" }, "");
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

document.addEventListener("click", (event) => {
  const button = event.target.closest(".player-hide");
  if (!button) return;
  const slot = button.closest(".player-slot.mini");
  if (!slot) return;
  event.preventDefault();
  event.stopPropagation();
  toggleMiniVideo(slot);
});

document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  goHome();
});

document.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("a.wiki") : null;
  if (!link) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openWikiPeek(link);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWikiPeek();
});

function startClaseClara() {
  showHome().catch((error) => {
    const raw = String((error && error.message) || "");
    const message = /cannot read properties|is not a function|is not defined/i.test(raw)
      ? "No pude abrir las clases. Cierra la aplicación y ábrela otra vez."
      : (raw || "No pude abrir las clases.");
    app.innerHTML = `<p class="error">${esc(message)}</p>`;
  });
}

window.renderChrome = renderChrome;
window.startClaseClara = startClaseClara;
renderChrome();
if (!window.CLASECLARA_HOLD) startClaseClara();
