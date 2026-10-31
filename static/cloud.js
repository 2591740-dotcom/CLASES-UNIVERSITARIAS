(function () {
  const cfg = window.CLASECLARA_CLOUD;
  const native = window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
  const host = location.hostname;
  const onPc = host === "127.0.0.1" || host === "localhost";
  const onWeb = !native && !onPc;
  if (!cfg || !cfg.url || !cfg.anon || onPc) return;

  const videosKey = "cc-videos";
  const sessionKey = "cc-session";
  const memory = {};
  let access = "";

  function videoMap() {
    try {
      const parsed = JSON.parse(localStorage.getItem(videosKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function newId() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const hex = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
    return `${stamp}-${hex}`;
  }

  function assertZoom(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("Pega un enlace https de Zoom, el de reproducir."); }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || !host.endsWith("zoom.us")) {
      throw new Error("Pega un enlace https de Zoom, el que empieza por zoom.us/rec/play/.");
    }
    if (!["/rec/play/", "/rec/share/", "/rec/download/"].some((piece) => parsed.pathname.includes(piece))) {
      throw new Error("Ese enlace de Zoom no es la grabación. Usa el de reproducir, /rec/play/.");
    }
  }

  function playback(url) {
    if (!url) return "";
    return url.replace("/rec/play/", "/rec/download/").replace("/rec/share/", "/rec/download/");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
  }

  async function auth(body) {
    const response = await fetch(`${cfg.url}/auth/v1/token?grant_type=${body.grant_type}`, {
      method: "POST",
      headers: { apikey: cfg.anon, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error("No pude entrar a las clases.");
    access = data.access_token;
    localStorage.setItem(sessionKey, JSON.stringify({
      access: data.access_token,
      refresh: data.refresh_token,
      exp: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    }));
  }

  async function session() {
    const saved = JSON.parse(localStorage.getItem(sessionKey) || "null");
    if (saved && saved.access && saved.exp > Date.now() + 60000) {
      access = saved.access;
      return;
    }
    if (saved && saved.refresh) {
      try {
        await auth({ grant_type: "refresh_token", refresh_token: saved.refresh });
        return;
      } catch { /* entra de nuevo */ }
    }
    if (!cfg.password) throw new Error("La sesión venció. Recarga la página para entrar de nuevo.");
    await auth({ grant_type: "password", email: cfg.email, password: cfg.password });
  }

  async function rest(method, path, body, retry) {
    await session();
    const headers = { apikey: cfg.anon, Authorization: `Bearer ${access}` };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers.Prefer = "return=minimal";
      payload = JSON.stringify(body);
    }
    const response = await fetch(cfg.url + path, { method, headers, body: payload });
    if (response.status === 401 && !retry) {
      localStorage.removeItem(sessionKey);
      access = "";
      await session();
      return rest(method, path, body, true);
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text.slice(0, 180) || "Supabase no respondió.");
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function sign(path) {
    const safe = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${cfg.url}/storage/v1/object/sign/diapositivas/${safe}`, {
      method: "POST",
      headers: {
        apikey: cfg.anon,
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!response.ok) return "";
    const data = await response.json().catch(() => ({}));
    const signed = data.signedURL || data.signedUrl || "";
    if (!signed) return "";
    return signed.startsWith("http") ? signed : `${cfg.url}/storage/v1${signed}`;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("claseclara", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("videos");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction("videos").objectStore("videos").get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbPut(id, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("videos", "readwrite");
      tx.objectStore("videos").put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(id) {
    const db = await openDb();
    return new Promise((resolve) => {
      const tx = db.transaction("videos", "readwrite");
      tx.objectStore("videos").delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async function localSrc(id) {
    if (memory[id]) return memory[id];
    const path = videoMap()[id];
    if (path === "navegador") {
      const blob = await idbGet(id).catch(() => null);
      if (blob) {
        memory[id] = URL.createObjectURL(blob);
        return memory[id];
      }
    }
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (!path || !fs || path === "navegador") return "";
    try {
      const got = await fs.getUri({ directory: "DATA", path });
      return window.Capacitor.convertFileSrc(got.uri);
    } catch {
      return "";
    }
  }

  async function saveFile(id, file, onProgress) {
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (!fs || !file.stream) {
      await idbPut(id, file);
      const map = videoMap();
      map[id] = "navegador";
      localStorage.setItem(videosKey, JSON.stringify(map));
      memory[id] = URL.createObjectURL(file);
      if (onProgress) onProgress("Video guardado en este navegador");
      return;
    }
    const path = `videos/${id}.mp4`;
    try {
      await fs.deleteFile({ path, directory: "DATA" });
    } catch { /* todavía no estaba */ }
    const reader = file.stream().getReader();
    let first = true;
    let doneBytes = 0;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const bytes = step.value;
      for (let offset = 0; offset < bytes.length; offset += 262144) {
        const slice = bytes.subarray(offset, Math.min(offset + 262144, bytes.length));
        const data = bytesToBase64(slice);
        if (first) {
          await fs.writeFile({ path, data, directory: "DATA" });
          first = false;
        } else {
          await fs.appendFile({ path, data, directory: "DATA" });
        }
        doneBytes += slice.length;
        if (onProgress && file.size) {
          onProgress(`Guardando el video… ${Math.min(99, Math.round(doneBytes / file.size * 100))}%`);
        }
      }
    }
    const map = videoMap();
    map[id] = path;
    localStorage.setItem(videosKey, JSON.stringify(map));
    delete memory[id];
  }

  function noticeFor(row) {
    const estado = row.estado || "lista";
    if (estado === "local") {
      const donde = onWeb ? "en este navegador" : "en el teléfono";
      return `Este video quedó ${donde}. Para tener la explicación en todos los dispositivos, pega el enlace de Zoom: la PC lo prepara.`;
    }
    if (estado === "pendiente" || estado === "procesando") {
      return "El video ya se puede ver. La explicación, las diapositivas y la transcripción llegan cuando la PC termine esta clase.";
    }
    return "";
  }

  function card(row) {
    const estado = row.estado || "lista";
    const avisos = Array.isArray(row.estudio?.avisos) ? row.estudio.avisos.length : 0;
    return {
      id: row.id,
      title: row.titulo || "Clase",
      materia: row.materia || "",
      status: estado === "error" ? "error" : "ready",
      stage: estado,
      detail: row.detalle || "",
      error: estado === "error" ? (row.detalle || "Se detuvo.") : "",
      created: row.creado || "",
      duration: row.duracion || 0,
      avisos,
      title_custom: false,
    };
  }

  async function one(id) {
    const rows = await rest("GET", `/rest/v1/clases?id=eq.${id}&select=*`);
    if (!Array.isArray(rows) || !rows[0]) throw new Error("No encuentro esa clase.");
    return rows[0];
  }

  async function detail(id) {
    const row = await one(id);
    const slides = await rest("GET", `/rest/v1/diapositivas?clase_id=eq.${id}&select=orden,tiempo,imagen_path&order=orden.asc`) || [];
    const frames = [];
    for (const slide of slides) {
      const file = await sign(slide.imagen_path || "");
      if (!file) continue;
      frames.push({ file, time: slide.tiempo || 0 });
    }
    const local = await localSrc(id);
    const remote = playback(row.video_url || "");
    const transcript = row.transcripcion || {};
    return {
      ...card(row),
      study: row.estudio || {},
      lines: Array.isArray(transcript.lines) ? transcript.lines : [],
      chat: Array.isArray(row.chat) ? row.chat : [],
      frames,
      media_kind: local || remote ? "video" : "",
      media_src: local || remote,
      notice: noticeFor(row),
    };
  }

  async function saveEntry({ link, file, materia, classId, onProgress }) {
    if (link) assertZoom(link);
    const id = classId || newId();
    if (file) await saveFile(id, file, onProgress);
    if (classId) {
      const patch = {};
      if (link) patch.video_url = link;
      if (materia) patch.materia = materia.slice(0, 120);
      if (link) {
        const current = await one(classId);
        const study = current.estudio || {};
        const ready = (study.explicacion || []).length || study.resumen;
        if (!ready) {
          patch.estado = "pendiente";
          patch.detalle = "Esperando a la PC";
        }
      }
      if (Object.keys(patch).length) await rest("PATCH", `/rest/v1/clases?id=eq.${id}`, patch);
      return id;
    }
    const titulo = (file ? file.name.replace(/\.[^.]+$/, "") : "Clase por enlace").slice(0, 140);
    await rest("POST", "/rest/v1/clases", {
      id,
      titulo,
      materia: (materia || "").slice(0, 120),
      video_url: link || "",
      estudio: {},
      transcripcion: {},
      chat: [],
      estado: link ? "pendiente" : "local",
      detalle: link ? "Esperando a la PC" : "Video solo en este teléfono",
    });
    return id;
  }

  function statusBody() {
    return {
      ready: true,
      has_key: true,
      missing: "",
      ffmpeg: false,
      chat: {
        provider: "grok",
        label: "Supabase",
        model: "",
        base: "",
        has_key: true,
        from_env: false,
        vision: false,
        hears: false,
        key_url: cfg.url,
        note: "La explicación se prepara en la PC y llega aquí.",
      },
      stt: { provider: "same", label: "El mismo proveedor", model: "", base: "", has_key: true, from_env: false },
      providers: [],
    };
  }

  async function api(url, options) {
    const method = ((options && options.method) || "GET").toUpperCase();
    if (url === "/api/status") return statusBody();
    if (url === "/api/settings" && method === "POST") return statusBody();
    if (url === "/api/zoom") return { recordings: [] };
    if (url === "/api/classes" && method === "GET") {
      const rows = await rest("GET", "/rest/v1/clases?select=id,titulo,materia,duracion,estado,detalle,creado,estudio&order=creado.desc") || [];
      return { classes: rows.map(card) };
    }
    if (url === "/api/classes" && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const id = await saveEntry({ link: body.url || "", materia: body.materia || "" });
      return { id };
    }
    const job = url.match(/^\/api\/jobs\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})$/);
    if (job) return card(await one(job[1]));
    const title = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/title$/);
    if (title && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      await rest("PATCH", `/rest/v1/clases?id=eq.${title[1]}`, {
        titulo: String(body.title || "").slice(0, 140),
        materia: String(body.materia || "").slice(0, 120),
      });
      return card(await one(title[1]));
    }
    const item = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})$/);
    if (item && method === "GET") return detail(item[1]);
    if (item && method === "DELETE") {
      await rest("DELETE", `/rest/v1/clases?id=eq.${item[1]}`);
      const map = videoMap();
      delete map[item[1]];
      localStorage.setItem(videosKey, JSON.stringify(map));
      delete memory[item[1]];
      idbDelete(item[1]);
      return { ok: true };
    }
    if (/\/chat$/.test(url)) {
      throw new Error("Las preguntas nuevas se hacen en la computadora. Aquí puedes leer las que ya se guardaron.");
    }
    if (/\/retry$/.test(url)) throw new Error("Esta clase se prepara en la computadora.");
    throw new Error("Esa acción no está en esta página.");
  }

  window.claseClaraCloud = { api, saveEntry };

  function showLogin() {
    const root = document.querySelector("#app");
    if (!root) return;
    const email = cfg.email || "";
    root.innerHTML = `
      <section class="panel">
        <h2>Entrar a tus clases</h2>
        <label for="login-email">Correo</label>
        <input id="login-email" type="email" autocomplete="username" value="${email.replace(/"/g, "")}">
        <label for="login-pass">Contraseña</label>
        <input id="login-pass" type="password" autocomplete="current-password">
        <div class="row"><button class="primary" id="login-go" type="button">Entrar</button></div>
        <p class="note" id="login-error" hidden></p>
      </section>`;
    document.querySelector("#login-go").onclick = async () => {
      const button = document.querySelector("#login-go");
      const note = document.querySelector("#login-error");
      button.disabled = true;
      note.hidden = true;
      try {
        await auth({
          grant_type: "password",
          email: document.querySelector("#login-email").value.trim(),
          password: document.querySelector("#login-pass").value,
        });
        window.CLASECLARA_HOLD = false;
        window.startClaseClara();
      } catch (error) {
        note.hidden = false;
        note.textContent = "No pude entrar. Revisa el correo y la contraseña.";
        button.disabled = false;
      }
    };
  }

  if (onWeb && !cfg.password) {
    window.CLASECLARA_HOLD = true;
    queueMicrotask(async () => {
      const saved = JSON.parse(localStorage.getItem(sessionKey) || "null");
      if (saved && saved.access && saved.exp > Date.now() + 60000) {
        access = saved.access;
        window.CLASECLARA_HOLD = false;
        window.startClaseClara?.();
        return;
      }
      showLogin();
    });
  }
})();
