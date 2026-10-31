const app = document.querySelector("#app");
const keybar = document.querySelector("#keybar");

const FILE_ACCEPT = "video/*,audio/*,.mp4,.mkv,.webm,.mov,.m4v,.avi,.m4a,.mp3,.wav,.aac,.ogg";

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

function youtubeId(raw) {
  const href = youtubeHref(raw);
  const found = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return found ? found[1] : "";
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
  const box = document.querySelector("#config");
  if (box && !box.hidden) {
    closeConfig();
    return;
  }
  if (document.querySelector("#class-heading") || document.querySelector("#process")) showHome();
});

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
      <h1>La misma clase, en este aparato.</h1>
    </section>
    <section class="panel">
      <div class="drop" id="drop">
        <label for="link">Enlace de Zoom</label>
        <input id="link" type="text" placeholder="https://....zoom.us/rec/play/...">
        <label for="file">Video o audio de este aparato</label>
        <input id="file" type="file" accept="${FILE_ACCEPT}">
        <div class="row">
          <button class="primary" id="go" type="button">Preparar clase</button>
        </div>
      </div>
    </section>
    <h2>${esc(pack.nombre || "Clases")}</h2>
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
  const mine = visibles.length
    ? visibles.map(cardHtml).join("")
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
        <label for="path">Enlace de Zoom o video</label>
        <input id="path" type="text" placeholder="Pega un enlace zoom.us/rec/play/">
        <div class="row">
          <button class="ghost" id="pick" type="button">Elegir video</button>
          <button class="primary" id="go" type="button">Procesar</button>
        </div>
        <p class="note">Elegir video abre el explorador en Documentos\Zoom. Si pegas un enlace, la PC lo baja. El nombre de la clase sale de lo que se dijo; si queda mal, se corrige al abrirla.</p>
      </div>
    </section>
    <h2>${esc(pack.nombre || "Clases ya hechas")}</h2>
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

async function showHome() {
  cerrarCursoModal();
  closeWikiPeek();
  stopSpeech();
  stopPoll();
  shown = "";
  clase = null;
  document.title = "ClaseClara";
  const [status, list] = await Promise.all([
    api("/api/status"),
    api("/api/classes"),
  ]);
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
  const go = document.querySelector("#go");
  if (go) {
    go.onclick = window.claseClaraCloud
      ? saveFromPhone
      : () => startPath(document.querySelector("#path").value.trim());
  }
  document.querySelectorAll(".open-class").forEach((button) => {
    button.onclick = () => openClass(button.dataset.id);
  });
  document.querySelectorAll(".delete-class").forEach((button) => {
    button.onclick = () => removeClass(button.dataset.id);
  });
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
        ? "Una clase de una hora suele tardar unos minutos. Deja esta pantalla abierta. La explicación se escribe en la computadora donde ClaseClara está abierto."
        : "Una clase de una hora suele tardar unos minutos. Puedes dejar esta página abierta."}</p>
    </section>`;
}

function youtubeProgress(job) {
  if ((job.media_kind === "youtube" && job.media_src) || job.youtube_state === "listo") return "";
  if (job.youtube_state === "error") {
    return `<p class="note">${esc(job.youtube_error || "No se pudo subir el video a YouTube.")}</p>`;
  }
  if (job.youtube_state === "falta") {
    return `<p class="note">Falta conectar el canal de YouTube en la computadora. Sin eso, el otro dispositivo no puede ver el video.</p>`;
  }
  return `<p class="note">El video se está subiendo a YouTube. En otro dispositivo aparecerá en esta clase, sin descargarlo.</p>`;
}

let droppedFile = null;

function setInputFile(input, file) {
  droppedFile = file;
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    droppedFile = null;
  } catch { /* Preparar clase usa el archivo soltado */ }
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
    note.textContent = "Este aparato todavía no reproduce ese video. Cuando la computadora lo publique, queda aquí.";
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
  try {
    const id = await window.claseClaraCloud.saveEntry({
      link,
      file,
      onProgress: (text) => { button.textContent = text; },
    });
    await openClass(id);
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = "Preparar clase";
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
  shown = "";
  const isLink = /^https?:\/\//i.test(path);
  renderProcess({ status: "processing", stage: "audio", detail: isLink ? "Bajando el video del enlace" : "Preparando el video", started: Math.floor(Date.now() / 1000) });
  try {
    const data = await api("/api/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(isLink ? { url: path, curso_id: pack.activo } : { path, curso_id: pack.activo }),
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
  showHome();
}

function frameNote(study, index) {
  return (study.capturas || []).find((shot) => shot.indice === index + 1);
}

function frameButton(src, time, label, extra) {
  const when = time ? ` data-time="${esc(time)}"` : "";
  const name = time ? `Ampliar captura, ${time}` : "Ampliar captura";
  return `<button type="button" class="frame-open" data-src="${esc(src)}"${when} data-label="${esc(label || "")}" aria-label="${esc(name)}">
    <img src="${esc(src)}" alt="">
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
    return frameButton(frameSrc(data, frame.file), stamp, label, `<span class="film-time">${esc(stamp)}</span>${detail}`);
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
          <div data-panel="avisos" ${hasNotices ? "" : "hidden"}>${noticesHtml(data)}</div>
          <div data-panel="explicacion" ${hasNotices ? "hidden" : ""}>${explainHtml(study, data.frames, data.lines)}</div>
          <div data-panel="resumen" hidden>${summaryHtml(study)}</div>
          <div data-panel="esquema" hidden>${mapHtml(study)}</div>
          <div data-panel="glosario" hidden>${termsHtml(study)}</div>
          <div data-panel="repaso" hidden>${quizHtml(study)}</div>
          ${(study.casos || []).length ? `<div data-panel="casos" hidden>${casesHtml(study)}</div>` : ""}
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
    const shot = avisoShot(data, Number(item.captura) || 0, item.tiempo);
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
      const when = times[index] ? `En el video, minuto ${times[index]}.` : "";
      const block = [when, part.titulo, part.texto, part.ejemplo ? `Ejemplo. ${part.ejemplo}` : ""].map(cleanSpeech).filter(Boolean).join(". ");
      if (block) parts.push(block);
    });
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
let speechPace = 0;
let speechPulse = 0;
let speechToggleAt = 0;
let phoneSpeech = null;
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
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return null;
  if (typeof cap.registerPlugin !== "function") return null;
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
  for (const code of prefer) {
    const found = voices.find((voice) => voice.lang.toLowerCase().replace("_", "-") === code.toLowerCase());
    if (found) return found;
  }
  return voices.find((voice) => voice.lang.toLowerCase().startsWith("es")) || null;
}

function stopSpeech() {
  speechToken += 1;
  clearInterval(speechPulse);
  try { window.speechSynthesis?.cancel(); } catch { /* la voz ya se detuvo */ }
  try { phoneSpeech?.stop(); } catch { /* la voz del teléfono ya se detuvo */ }
  const button = document.querySelector("#listen");
  if (button) {
    button.textContent = "Escuchar";
    button.setAttribute("aria-pressed", "false");
  }
}

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
  const chunks = speechChunks(speechFor(tab, clase));
  if (!chunks.length) {
    listenNote("Esta parte no tiene texto para leer.");
    return;
  }
  const reader = phoneReader();
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

async function startPhoneSpeech(reader, chunks) {
  const token = ++speechToken;
  markListening();
  let index = 0;
  while (index < chunks.length) {
    if (token !== speechToken) return;
    const pace = speechPace;
    try {
      await reader.speak({ text: chunks[index], rate: speechRate() });
    } catch {
      if (token !== speechToken) return;
      if (pace !== speechPace) continue;
      listenNote("El teléfono no pudo leer en voz alta. En Ajustes, abre Texto a voz y descarga una voz en español.");
      stopSpeech();
      return;
    }
    if (token !== speechToken) return;
    if (pace !== speechPace) continue;
    index += 1;
  }
  if (token === speechToken) stopSpeech();
}

function startBrowserSpeech(synth, chunks) {
  const token = ++speechToken;
  markListening();
  let index = 0;
  const speakNext = () => {
    if (token !== speechToken) return;
    if (index >= chunks.length) {
      stopSpeech();
      return;
    }
    const pace = speechPace;
    const utterance = new SpeechSynthesisUtterance(chunks[index]);
    const voice = spanishVoice();
    utterance.lang = voice?.lang || "es-ES";
    if (voice) utterance.voice = voice;
    utterance.rate = speechRate();
    let settled = false;
    const finish = (error) => {
      if (settled || token !== speechToken) return;
      settled = true;
      if (pace !== speechPace) {
        speakNext();
        return;
      }
      if (error === "interrupted" || error === "canceled") return;
      if (error) {
        listenNote("Este aparato no pudo leer en voz alta.");
        stopSpeech();
        return;
      }
      index += 1;
      speakNext();
    };
    utterance.onend = () => finish("");
    utterance.onerror = (event) => finish(event.error || "error");
    synth.speak(utterance);
  };
  try { synth.resume(); } catch { /* sigue con la voz */ }
  speakNext();
  speechPulse = setInterval(() => {
    if (token !== speechToken || !synth.speaking) return;
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
  const watch = () => {
    miniFrame = 0;
    if (!slot.isConnected) return;
    if (!slot.classList.contains("mini")) {
      const style = getComputedStyle(slot);
      const box = slot.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      slot.dataset.fullHeight = String(Math.round(box));
    }
    const header = document.querySelector(".top")?.getBoundingClientRect().height || 0;
    const top = mark.getBoundingClientRect().top;
    const next = miniPlayerNext(slot.classList.contains("mini"), top, header);
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
  miniOnScroll = schedule;
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  bindMiniDrag(slot);
  watch();
}

function elegirPestana(id) {
  stopSpeech();
  closeWikiPeek();
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
      button.scrollIntoView({ inline: "nearest", block: "nearest" });
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

async function openClass(id) {
  closeWikiPeek();
  stopSpeech();
  clearYouTube();
  stopPoll();
  const data = await api(`/api/classes/${id}`);
  const study = data.study || {};
  const hasStudy = (study.explicacion || []).length || study.resumen;
  if (data.status === "processing" || (data.status === "error" && !hasStudy)) {
    if (data.status === "processing") watch(id);
    else renderProcess(data);
    return;
  }
  clase = data;
  shown = "study";
  document.title = data.study?.titulo || data.title || "ClaseClara";
  app.innerHTML = studyHtml(data);
  bindStudy();
  if (!history.state || history.state.cc !== "class") history.pushState({ cc: "class" }, "");
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
