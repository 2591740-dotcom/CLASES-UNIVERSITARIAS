(function () {
  const cfg = window.CLASECLARA_CLOUD;
  const cap = window.Capacitor;
  const native = Boolean(
    window.androidBridge
    || (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform())
  );
  const host = location.hostname;
  const onPc = host === "127.0.0.1" || host === "localhost";
  const onWeb = !native && !onPc;
  // El APK también abre en localhost. En el teléfono igual se usa la cuenta.
  if (!cfg || !cfg.url || !cfg.anon || (onPc && !native)) return;

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
    if (!url || String(url).startsWith("entrada:")) return "";
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
    if (native || !cfg.password) throw new Error("La sesión venció. Recarga la página para entrar de nuevo.");
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
    if (path === "opfs" && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(`${id}.bin`);
        const stored = await handle.getFile();
        memory[id] = URL.createObjectURL(stored);
        return memory[id];
      } catch {
        return "";
      }
    }
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

  const mediaExt = [".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".m4a", ".mp3", ".wav", ".aac", ".ogg"];

  function acceptedMedia(file) {
    const name = String(file && file.name || "").toLowerCase();
    if (mediaExt.some((ext) => name.endsWith(ext))) return true;
    const type = String(file && file.type || "").toLowerCase();
    return type.startsWith("video/") || type.startsWith("audio/");
  }

  function rememberBrowser(id, file) {
    try { if (memory[id]) URL.revokeObjectURL(memory[id]); } catch { /* el anterior ya se soltó */ }
    memory[id] = URL.createObjectURL(file);
  }

  async function persistBrowser(id, file) {
    if (navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(`${id}.bin`, { create: true });
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        const map = videoMap();
        map[id] = "opfs";
        localStorage.setItem(videosKey, JSON.stringify(map));
        return;
      } catch { /* sigue el intento corto de abajo */ }
    }
    if (file.size > 80 * 1024 * 1024) return;
    try {
      await idbPut(id, file);
      const map = videoMap();
      map[id] = "navegador";
      localStorage.setItem(videosKey, JSON.stringify(map));
    } catch { /* este navegador igual reproduce el video en esta visita */ }
  }

  async function forgetBrowser(id) {
    const map = videoMap();
    const kind = map[id];
    delete map[id];
    localStorage.setItem(videosKey, JSON.stringify(map));
    if (memory[id]) {
      try { URL.revokeObjectURL(memory[id]); } catch { /* ya se soltó */ }
      delete memory[id];
    }
    idbDelete(id);
    if (kind === "opfs" && navigator.storage && navigator.storage.getDirectory) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(`${id}.bin`);
      } catch { /* ya no estaba */ }
    }
  }

  async function saveFile(id, file, onProgress) {
    const fs = window.Capacitor?.Plugins?.Filesystem;
    if (!fs || !file.stream) {
      rememberBrowser(id, file);
      await persistBrowser(id, file);
      if (onProgress) onProgress("Video listo en este navegador");
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
    if (estado === "pendiente" || estado === "procesando") {
      return "Puedes ver el video en este aparato. La explicación se escribe en la computadora donde ClaseClara está abierto.";
    }
    return "";
  }

  function stageOf(estado, detalle) {
    const text = String(detalle || "").toLowerCase();
    if (estado === "lista" || estado === "local") return "ready";
    if (text.includes("explica") || text.includes("esquema")) return "study";
    if (text.includes("pizarra") || text.includes("captura") || text.includes("diapositiva")) return "frames";
    if (text.includes("transcrib")) return "transcript";
    return "audio";
  }

  function viewStatus(estado) {
    if (estado === "error") return "error";
    if (estado === "pendiente" || estado === "procesando") return "processing";
    return "ready";
  }

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

  function horaClase(value) {
    const text = String(value || "").trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(text) ? text : "";
  }

  function card(row) {
    const estado = row.estado || "lista";
    const started = Date.parse(row.creado || "");
    const avisos = Array.isArray(row.estudio?.avisos) ? row.estudio.avisos.length : 0;
    const watch = typeof youtubeHref === "function" ? youtubeHref(row.video_url || "") : "";
    const remote = watch ? "" : playback(row.video_url || "");
    const estudio = row.estudio || {};
    const custom = Boolean(estudio.titulo_custom);
    const titulo = custom
      ? (estudio.titulo || row.titulo || "Clase")
      : (row.titulo || estudio.titulo || "Clase");
    return {
      id: row.id,
      title: titulo,
      materia: row.materia || "",
      curso_id: row.curso_id || "",
      status: viewStatus(estado),
      stage: stageOf(estado, row.detalle),
      detail: row.detalle || "",
      error: estado === "error" ? (row.detalle || "Se detuvo.") : "",
      created: row.creado || "",
      fecha: fechaIso(row.estudio && row.estudio.fecha_clase),
      hora: horaClase(row.estudio && row.estudio.hora_clase),
      started: Number.isFinite(started) ? Math.floor(started / 1000) : 0,
      duration: row.duracion || 0,
      avisos,
      title_custom: custom,
      media_kind: watch ? "youtube" : (remote ? "video" : ""),
      media_src: watch || remote,
      youtube_state: watch ? "listo" : "",
    };
  }

  async function withLocal(item) {
    if (item.media_src) return item;
    const local = await localSrc(item.id);
    if (!local) return item;
    return { ...item, media_kind: "video", media_src: local };
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
    const watch = typeof youtubeHref === "function" ? youtubeHref(row.video_url || "") : "";
    const local = watch ? "" : await localSrc(id);
    const remote = watch ? "" : playback(row.video_url || "");
    const transcript = row.transcripcion || {};
    return {
      ...card(row),
      curso: await nombreCurso(row.curso_id),
      study: row.estudio || {},
      lines: Array.isArray(transcript.lines) ? transcript.lines : [],
      chat: Array.isArray(row.chat) ? row.chat : [],
      frames,
      media_kind: watch ? "youtube" : (local || remote ? "video" : ""),
      media_src: watch || local || remote,
      notice: noticeFor(row),
    };
  }

  async function putPart(path, blob, failMessage) {
    const fail = failMessage || "No pude enviar el video para prepararlo.";
    await session();
    const safe = path.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`${cfg.url}/storage/v1/object/diapositivas/${safe}`, {
      method: "POST",
      headers: {
        apikey: cfg.anon,
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/octet-stream",
        "x-upsert": "true",
      },
      body: blob,
    });
    if (response.status === 401) {
      localStorage.removeItem(sessionKey);
      access = "";
      await session();
      const again = await fetch(`${cfg.url}/storage/v1/object/diapositivas/${safe}`, {
        method: "POST",
        headers: {
          apikey: cfg.anon,
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/octet-stream",
          "x-upsert": "true",
        },
        body: blob,
      });
      if (!again.ok) throw new Error(fail);
      return;
    }
    if (!response.ok) throw new Error(fail);
  }

  async function uploadEntrada(id, file, onProgress) {
    const part = 8 * 1024 * 1024;
    const total = Math.max(1, Math.ceil(file.size / part));
    for (let index = 0; index < total; index += 1) {
      const blob = file.slice(index * part, Math.min(file.size, (index + 1) * part));
      const name = `${id}/entrada/${String(index).padStart(3, "0")}`;
      await putPart(name, blob);
      if (onProgress) onProgress(`Enviando el video… ${Math.round(((index + 1) / total) * 100)}%`);
    }
    return total;
  }

  function studyReady(row) {
    const study = (row && row.estudio) || {};
    return Boolean((study.explicacion || []).length || study.resumen);
  }

  async function saveEntry({ link, file, materia, classId, onProgress, fecha }) {
    if (link) assertZoom(link);
    if (file && file.size > 2500000000) throw new Error("Ese video pasa de 2.5 GB.");
    if (file && !file.size) throw new Error("Ese archivo está vacío.");
    if (file && !acceptedMedia(file)) {
      throw new Error("Ese archivo no es el video. Elige el .mp4, .mkv o el audio .m4a.");
    }
    let claves = [];
    if (typeof clavesDeEntrada === "function") {
      try {
        claves = await clavesDeEntrada({ link, file });
      } catch {
        claves = [];
      }
    }
    claves = (Array.isArray(claves) ? claves : [])
      .filter((key) => !String(key).startsWith("ruta:"))
      .slice(0, 8);
    if (claves.length && typeof avisoDuplicado === "function" && typeof clavesDeFila === "function") {
      let rows = null;
      try {
        rows = await rest("GET", "/rest/v1/clases?select=id,titulo,video_url,estudio&limit=1000");
      } catch {
        rows = null;
      }
      if (Array.isArray(rows)) {
        const wanted = new Set(claves);
        for (const row of rows) {
          const rowId = String((row && row.id) || "");
          if (!rowId || rowId === classId) continue;
          const hit = clavesDeFila(row).filter((key) => wanted.has(key));
          if (!hit.length) continue;
          const tipo = hit.some((key) => key.startsWith("zoom:") || key.startsWith("yt:")) ? "enlace" : "video";
          const error = new Error(avisoDuplicado(row.titulo, tipo));
          error.duplicado = rowId;
          throw error;
        }
      }
    }
    const id = classId || newId();
    const course = (materia || "").slice(0, 120);
    const nativeStore = Boolean(file && window.Capacitor?.Plugins?.Filesystem && file.stream);
    if (file && nativeStore) await saveFile(id, file, onProgress);
    else if (file) rememberBrowser(id, file);
    if (!classId) {
      const titulo = (file ? file.name.replace(/\.[^.]+$/, "") : "Clase por enlace").slice(0, 140);
      const estudio = estudioActual();
      if (!estudio) throw new Error("Entra de nuevo para preparar la clase.");
      const cursoId = readCursoId();
      if (!esIdCurso(cursoId)) throw new Error("Elige o crea un curso.");
      const cuando = fechaIso(fecha);
      const estudioCuerpo = {};
      if (cuando) estudioCuerpo.fecha_clase = cuando;
      if (claves.length) estudioCuerpo.fuentes = claves;
      await rest("POST", "/rest/v1/clases", {
        id,
        titulo,
        materia: course,
        universidad: estudio.universidad,
        carrera: estudio.carrera,
        curso_id: cursoId,
        video_url: link || "",
        estudio: estudioCuerpo,
        transcripcion: {},
        chat: [],
        estado: "pendiente",
        detalle: "La computadora prepara el video y lo publica",
      });
    }
    if (file && !link) {
      if (classId && studyReady(await one(classId))) return id;
      try {
        const count = await uploadEntrada(id, file, onProgress);
        const patch = {
          video_url: `entrada:${count}`,
          materia: course,
          estado: "pendiente",
          detalle: "La computadora prepara el video y lo publica",
        };
        const cuando = fechaIso(fecha);
        if (cuando || claves.length) {
          try {
            const row = await one(id);
            const previo = { ...(row.estudio || {}) };
            if (claves.length) previo.fuentes = claves;
            if (cuando && !previo.fecha_custom) previo.fecha_clase = cuando;
            patch.estudio = previo;
          } catch { /* el video ya se envió; la fecha puede guardarse después */ }
        }
        await rest("PATCH", `/rest/v1/clases?id=eq.${id}`, patch);
        if (!nativeStore) persistBrowser(id, file);
      } catch (error) {
        try {
          await rest("PATCH", `/rest/v1/clases?id=eq.${id}`, {
            estado: "error",
            detalle: "No pude enviar el video",
          });
        } catch { /* el aviso de abajo explica el fallo */ }
        throw error;
      }
      return id;
    }
    if (link) {
      let keep = false;
      if (classId) {
        keep = studyReady(await one(classId));
      }
      const patch = { video_url: link };
      if (course) patch.materia = course;
      if (!keep) {
        patch.estado = "pendiente";
        patch.detalle = "La computadora prepara el video y lo publica";
      }
      if (claves.length && classId) {
        try {
          const row = await one(id);
          const previo = { ...(row.estudio || {}) };
          previo.fuentes = claves;
          patch.estudio = previo;
        } catch { /* sigue sin pisar el estudio */ }
      }
      if (classId || course) await rest("PATCH", `/rest/v1/clases?id=eq.${id}`, patch);
      return id;
    }
    return id;
  }

  async function saveYouTube(classId, url) {
    const watch = typeof youtubeHref === "function" ? youtubeHref(url) : "";
    if (!watch) throw new Error("Pega un enlace de YouTube, el de youtube.com/watch o youtu.be.");
    await rest("PATCH", `/rest/v1/clases?id=eq.${classId}`, { video_url: watch });
    return watch;
  }

  const phoneProviders = [
    { id: "grok", label: "Grok (xAI)", hears: true, vision: true, default_model: "grok-4.7", default_stt_model: "grok-voice-transcribe-2.0", key_url: "https://console.x.ai", note: "Una sola clave transcribe y explica. Si se acaban los créditos, elige otro proveedor." },
    { id: "openai", label: "OpenAI", hears: true, vision: true, default_model: "gpt-4.1", default_stt_model: "gpt-transcribe", key_url: "https://platform.openai.com/api-keys", note: "La misma clave transcribe y mira las diapositivas." },
    { id: "gemini", label: "Gemini (Google)", hears: true, vision: true, default_model: "gemini-2.5-flash", default_stt_model: "gemini-2.5-flash", key_url: "https://aistudio.google.com/apikey", note: "La misma clave transcribe el audio por tramos y mira las diapositivas." },
    { id: "claude", label: "Claude (Anthropic)", hears: false, vision: true, default_model: "claude-sonnet-4-5", default_stt_model: "", key_url: "https://console.anthropic.com", note: "Claude no oye el audio. Abajo elige quién transcribe." },
    { id: "mistral", label: "Mistral", hears: true, vision: true, default_model: "pixtral-large-latest", default_stt_model: "voxtral-mini-transcribe-3", key_url: "https://console.mistral.ai", note: "Pixtral mira las diapositivas y Voxtral transcribe." },
    { id: "groq", label: "Groq", hears: true, vision: false, default_model: "llama-3.3-70b-versatile", default_stt_model: "whisper-large-v3-turbo", key_url: "https://console.groq.com/keys", note: "Whisper transcribe. Este chat no recibe las diapositivas. Para que las mire, usa Grok, OpenAI, Gemini, Claude o Mistral." },
    { id: "openrouter", label: "OpenRouter", hears: false, vision: true, default_model: "openai/gpt-4.1", default_stt_model: "", key_url: "https://openrouter.ai/keys", note: "No transcribe. Elige abajo quién oye la clase. El modelo se escribe como proveedor/modelo." },
    { id: "deepgram", label: "Deepgram", explains: false, hears: true, vision: false, default_model: "", default_stt_model: "nova-3", key_url: "https://console.deepgram.com", note: "Solo transcribe. Arriba elige quién explica y pega aquí la clave de Deepgram. El modelo nova-3 oye español." },
    { id: "assemblyai", label: "AssemblyAI", explains: false, hears: true, vision: false, default_model: "", default_stt_model: "universal-3-5-pro", key_url: "https://www.assemblyai.com/dashboard/home", note: "Solo transcribe. Arriba elige quién explica y pega aquí la clave de AssemblyAI." },
    { id: "elevenlabs", label: "ElevenLabs", explains: false, hears: true, vision: false, default_model: "", default_stt_model: "scribe_v2", key_url: "https://elevenlabs.io/app/settings/api-keys", note: "Solo transcribe. Arriba elige quién explica y pega aquí la clave de ElevenLabs." },
    { id: "compatible", label: "Otro (compatible con OpenAI)", hears: true, vision: true, default_model: "", default_stt_model: "", key_url: "", note: "Pega una URL compatible con OpenAI, por ejemplo https://tu-servidor/v1." },
  ];

  let iaCache = null;

  const chatUrls = {
    grok: "https://api.x.ai/v1/chat/completions",
    openai: "https://api.openai.com/v1/chat/completions",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    mistral: "https://api.mistral.ai/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    claude: "https://api.anthropic.com/v1/messages",
  };

  function safeError(text) {
    return String(text || "La IA no respondió.").replace(/sk-[A-Za-z0-9_-]{8,}/g, "la clave").slice(0, 180);
  }

  async function loadIa() {
    const previous = iaCache;
    try {
      await session();
      const response = await fetch(`${cfg.url}/storage/v1/object/diapositivas/ajustes/ia.json?t=${Date.now()}`, {
        cache: "no-store",
        headers: { apikey: cfg.anon, Authorization: `Bearer ${access}` },
      });
      if (!response.ok) return previous;
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object" || (!data.chat_key && !data.stt_key)) return previous;
      iaCache = data;
      return iaCache;
    } catch {
      return previous;
    }
  }

  function cleanBase(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text.length > 300) throw new Error("La URL es demasiado larga.");
    let parsed;
    try { parsed = new URL(text); } catch { throw new Error("La URL tiene que empezar por https://."); }
    const host = (parsed.hostname || "").toLowerCase();
    const local = host === "127.0.0.1" || host === "localhost";
    if (parsed.protocol === "https:" && host) return text.replace(/\/+$/, "");
    if (parsed.protocol === "http:" && local) return text.replace(/\/+$/, "");
    throw new Error("La URL tiene que empezar por https://.");
  }

  function keepKey(posted, oldKey, providerChanged) {
    const text = String(posted || "").replace(/[\r\n]/g, "").trim();
    if (text) {
      if (text.length > 500) throw new Error("Esa clave es demasiado larga.");
      return text;
    }
    if (providerChanged) return "";
    return oldKey || "";
  }

  function postedText(posted, field, fallback, limit) {
    if (!Object.prototype.hasOwnProperty.call(posted, field)) return String(fallback || "");
    return String(posted[field] || "").replace(/[\r\n]/g, "").trim().slice(0, limit);
  }

  async function saveIa(posted) {
    const current = (await loadIa()) || {};
    const incoming = posted && typeof posted === "object" ? posted : {};
    const has = (field) => Object.prototype.hasOwnProperty.call(incoming, field);
    const previousChat = String(current.chat_provider || "");
    const chatProvider = has("chat_provider")
      ? String(incoming.chat_provider || previousChat || "openai")
      : (previousChat || "openai");
    const chatSpec = phoneProviders.find((item) => item.id === chatProvider);
    if (!chatSpec) throw new Error("Ese proveedor no está en la lista.");
    if (chatSpec.explains === false) throw new Error(chatSpec.label + " solo transcribe. Elige otro para explicar y pon su clave en la voz.");
    const previousStt = String(current.stt_provider || "same");
    const sttProvider = has("stt_provider") ? String(incoming.stt_provider || "same") : previousStt;
    if (sttProvider !== "same") {
      const spec = phoneProviders.find((item) => item.id === sttProvider);
      if (!spec || !spec.hears) throw new Error("Ese proveedor no transcribe audio.");
    }
    const fondo = has("fondo")
      ? (incoming.fondo === "oscuro" ? "oscuro" : "claro")
      : (current.fondo === "oscuro" ? "oscuro" : "claro");
    const data = {
      chat_provider: chatProvider,
      chat_key: keepKey(incoming.chat_key, current.chat_key, has("chat_provider") && chatProvider !== previousChat),
      chat_model: postedText(incoming, "chat_model", current.chat_model, 120),
      chat_base: has("chat_base") ? cleanBase(incoming.chat_base) : String(current.chat_base || ""),
      stt_provider: sttProvider,
      stt_key: keepKey(incoming.stt_key, current.stt_key, has("stt_provider") && sttProvider !== previousStt),
      stt_model: postedText(incoming, "stt_model", current.stt_model, 120),
      stt_base: has("stt_base") ? cleanBase(incoming.stt_base) : String(current.stt_base || ""),
      fondo,
      actualizado: Math.floor(Date.now() / 1000),
    };
    if (!data.chat_key && !data.stt_key) throw new Error("Pega la clave de este proveedor.");
    const blob = new Blob([JSON.stringify(data)], { type: "application/octet-stream" });
    await putPart("ajustes/ia.json", blob, "No pude guardar la clave en la cuenta.");
    iaCache = data;
    return statusBody(data);
  }

  function answerText(data) {
    const openai = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (openai) return String(openai).trim();
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    return blocks
      .filter((block) => block && block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n")
      .trim();
  }

  async function postJson(url, headers, body) {
    const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    const native = window.Capacitor && typeof window.Capacitor.isNativePlatform === "function" && window.Capacitor.isNativePlatform();
    if (http && native) {
      const result = await http.request({ url, method: "POST", headers, data: body });
      const status = Number(result && result.status) || 0;
      let data = result ? result.data : {};
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { data = {}; }
      }
      if (status >= 400) throw new Error(safeError(data && data.error && data.error.message));
      return data || {};
    }
    const throughPage = onWeb;
    const response = await fetch(throughPage ? "/.netlify/functions/ai" : url, {
      method: "POST",
      headers: throughPage ? { "Content-Type": "application/json" } : headers,
      body: JSON.stringify(throughPage ? { url, headers, body } : body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(safeError(data && data.error && data.error.message));
    return data;
  }

  function clipText(text) {
    const value = String(text || "");
    if (value.length <= 70000) return value;
    const head = Math.floor(70000 * 2 / 3);
    return `${value.slice(0, head)}\n\n[...trozo del medio omitido por largo...]\n\n${value.slice(value.length - (70000 - head))}`;
  }

  function chatEndpoint(ia) {
    const provider = (ia && ia.chat_provider) || "";
    if (provider === "compatible") {
      const root = String(ia.chat_base || "").trim().replace(/\/+$/, "");
      if (!root) return "";
      if (root.endsWith("/chat/completions")) return root;
      return `${root}/chat/completions`;
    }
    return chatUrls[provider] || "";
  }

  async function askRemote(id, message) {
    const ia = await loadIa();
    if (!ia || !ia.chat_key) {
      throw new Error("Pega la clave en Configurar.");
    }
    const spec = phoneProviders.find((item) => item.id === ia.chat_provider);
    if (spec && spec.explains === false) {
      throw new Error(spec.label + " solo transcribe. Elige en Configurar quién explica.");
    }
    const url = chatEndpoint(ia);
    if (!url) throw new Error("Ese proveedor responde desde la computadora.");
    const anthropic = ia.chat_provider === "claude";
    const row = await one(id);
    const study = row.estudio || {};
    const transcript = row.transcripcion || {};
    const spoken = transcript.text || (Array.isArray(transcript.lines)
      ? transcript.lines.map((line) => `[${line.stamp || ""}] ${line.speaker || ""}: ${line.text || ""}`).join("\n")
      : "");
    const history = Array.isArray(row.chat) ? row.chat : [];
    const messages = [
      {
        role: "system",
        content: "Eres el profesor particular de una clase ya grabada. Respondes en español claro, con frases cortas. Usas la transcripción y el material de estudio. Si algo no está en la clase, lo dices. No inventas citas. Cuando nombres un momento, escribe el tiempo como MM:SS.",
      },
      {
        role: "user",
        content: `Materia: ${row.materia || "no indicada"}\n\nMaterial:\n${JSON.stringify(study)}\n\nTranscripción:\n${clipText(spoken)}`,
      },
      { role: "assistant", content: "Listo. Pregunta sobre esta clase." },
    ];
    history.slice(-8).forEach((turn) => {
      if ((turn.role === "user" || turn.role === "assistant") && turn.content) {
        messages.push({ role: turn.role, content: String(turn.content) });
      }
    });
    messages.push({ role: "user", content: message });
    const model = ia.chat_model || (spec && spec.default_model) || "gpt-4.1";
    const data = anthropic
      ? await postJson(url, {
        "x-api-key": ia.chat_key,
        "anthropic-version": "2023-06-01",
      }, {
        model,
        max_tokens: 4000,
        system: messages[0].content,
        messages: messages.slice(1),
      })
      : await postJson(url, {
        Authorization: `Bearer ${ia.chat_key}`,
        "Content-Type": "application/json",
      }, { model, messages });
    const answer = answerText(data);
    if (!answer) throw new Error("La IA no devolvió una respuesta.");
    const chat = history.concat([
      { role: "user", content: message },
      { role: "assistant", content: String(answer).trim() },
    ]);
    await rest("PATCH", `/rest/v1/clases?id=eq.${id}`, { chat });
    return { chat };
  }

  function textoDePreguntas(preguntas) {
    return preguntas.map((item) => {
      const cabeza = `${item.numero}. ${item.pregunta}`.trim();
      return item.respuesta ? `${cabeza}\n\n${item.respuesta}` : cabeza;
    }).join("\n\n").trim();
  }

  function partirPreguntas(texto) {
    const lineas = String(texto || "").split("\n");
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

  function preguntasDeLista(raw) {
    if (!Array.isArray(raw)) return [];
    const preguntas = [];
    raw.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      const pregunta = String(item.pregunta || "").replace(/\s+/g, " ").trim();
      const respuesta = String(item.respuesta || "").trim();
      if (!pregunta && !respuesta) return;
      const numero = Number(item.numero);
      preguntas.push({
        numero: Number.isInteger(numero) && numero > 0 ? numero : index + 1,
        pregunta: pregunta.slice(0, 2000),
        respuesta: respuesta.slice(0, 8000),
      });
    });
    const numeros = preguntas.map((item) => item.numero);
    if (preguntas.length >= 2 && new Set(numeros).size === numeros.length) {
      preguntas.sort((a, b) => a.numero - b.numero);
    }
    return preguntas.slice(0, 40).map((item, index) => ({ ...item, numero: index + 1 }));
  }

  function parseRespuesta(raw) {
    let text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const data = JSON.parse(text.slice(start, end + 1));
        let preguntas = preguntasDeLista(data && data.preguntas);
        let texto = String(data && data.texto || "").trim();
        if (!preguntas.length) preguntas = partirPreguntas(texto);
        if (preguntas.length) texto = textoDePreguntas(preguntas);
        if (texto) {
          return {
            puede: data.puede === true || data.puede === "true",
            texto: texto.slice(0, 20000),
            preguntas,
          };
        }
      } catch { /* el texto largo de abajo todavía puede servir */ }
    }
    if (text.length > 200) {
      let preguntas = partirPreguntas(text);
      let texto = text.slice(0, 20000);
      if (preguntas.length) texto = textoDePreguntas(preguntas);
      return { puede: true, texto, preguntas };
    }
    throw new Error("No pude leer la respuesta. Inténtalo otra vez.");
  }

  async function askRespuesta(id, indice) {
    const ia = await loadIa();
    if (!ia || !ia.chat_key) throw new Error("Pega la clave en Configurar.");
    const spec = phoneProviders.find((item) => item.id === ia.chat_provider);
    if (spec && spec.explains === false) {
      throw new Error(spec.label + " solo transcribe. Elige en Configurar quién explica.");
    }
    const url = chatEndpoint(ia);
    if (!url) throw new Error("Ese proveedor responde desde la computadora.");
    const row = await one(id);
    const study = row.estudio || {};
    const avisos = Array.isArray(study.avisos) ? study.avisos : [];
    const aviso = avisos[indice];
    if (!aviso || aviso.tipo !== "tarea") throw new Error("Esto no es una tarea.");
    const transcript = row.transcripcion || {};
    const spoken = transcript.text || (Array.isArray(transcript.lines)
      ? transcript.lines.map((line) => `[${line.stamp || ""}] ${line.speaker || ""}: ${line.text || ""}`).join("\n")
      : "");
    const system = "Preparas la entrega de una tarea usando solo esta clase. Devuelves un JSON con puede, texto y preguntas. puede es true solo cuando la transcripción y el material alcanzan para redactar la entrega sin inventar datos, lecturas que no se leyeron, entrevistas, encuestas ni experiencias personales que la clase no contó. Si la tarea pide responder preguntas, o el caso trae varias preguntas, llenas preguntas en el mismo orden del encargo. Cada elemento tiene numero, pregunta y respuesta. numero empieza en 1 y sigue de uno en uno. pregunta es el enunciado tal como se encargó, sin contestarlo. respuesta es solo la respuesta de esa pregunta, con lo explicado en clase. No juntes dos preguntas en una respuesta ni cambies el orden. Si una pregunta no se puede responder con la clase, su respuesta dice qué falta y no inventa el resto. Si además piden citas o una experiencia que la clase no contó, igual respondes lo que sí se explicó y en esa respuesta dices que ese dato no se dio en clase. puede es false solo cuando no se puede responder ninguna parte. Entonces preguntas va vacía y texto dice en una frase qué falta. Cuando hay preguntas, texto queda vacío. Si la tarea no tiene preguntas separadas, preguntas va vacía y texto es la entrega en párrafos, en español, sin repetir el título y sin decir que eres una IA. No cites autores, cifras, fechas ni ejemplos que no estén en la clase. No escribas nada fuera del JSON.";
    const encargo = `Tarea a responder ahora:\nTítulo: ${aviso.titulo || "Tarea"}\nPresentar: ${aviso.fecha || "no se dijo"}\nQué encargó: ${aviso.detalle || "no hay más detalle"}\nTexto o lectura leída en clase: ${aviso.texto || "no se leyó un texto en la clase"}`;
    const messages = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Materia: ${row.materia || "no indicada"}\n\nMaterial:\n${JSON.stringify(study)}\n\nTranscripción:\n${clipText(spoken)}\n\n${encargo}`,
      },
    ];
    const anthropic = ia.chat_provider === "claude";
    const model = ia.chat_model || (spec && spec.default_model) || "gpt-4.1";
    const data = anthropic
      ? await postJson(url, {
        "x-api-key": ia.chat_key,
        "anthropic-version": "2023-06-01",
      }, {
        model,
        max_tokens: 4000,
        system: messages[0].content,
        messages: messages.slice(1),
      })
      : await postJson(url, {
        Authorization: `Bearer ${ia.chat_key}`,
        "Content-Type": "application/json",
      }, { model, max_tokens: 4000, messages });
    const answer = answerText(data);
    if (!answer) throw new Error("La IA no devolvió una respuesta.");
    return parseRespuesta(answer);
  }

  function statusBody(ia) {
    const data = ia || {};
    const provider = data.chat_provider || "openai";
    const spec = phoneProviders.find((item) => item.id === provider) || phoneProviders.find((item) => item.id === "openai");
    const sttChoice = data.stt_provider || "same";
    const sttId = sttChoice === "same" ? provider : sttChoice;
    const sttSpec = phoneProviders.find((item) => item.id === sttId) || spec;
    const model = data.chat_model || (spec && spec.default_model) || "";
    const sttModel = data.stt_model || (sttSpec && sttSpec.default_stt_model) || "";
    const hasChat = Boolean(data.chat_key);
    const hasStt = sttChoice === "same" ? hasChat : Boolean(data.stt_key);
    return {
      ready: hasChat,
      remote: true,
      has_key: hasChat,
      missing: hasChat ? "" : "Pega la clave en Configurar.",
      ffmpeg: false,
      chat: {
        provider,
        label: spec ? spec.label : "OpenAI",
        model,
        base: data.chat_base || "",
        has_key: hasChat,
        from_env: false,
        vision: Boolean(spec && spec.vision),
        hears: Boolean(spec && spec.hears),
        key_url: (spec && spec.key_url) || "",
        note: (spec && spec.note) || "",
      },
      stt: {
        provider: sttChoice,
        label: sttChoice === "same" ? "El mismo proveedor" : (sttSpec ? sttSpec.label : ""),
        model: sttModel,
        base: data.stt_base || "",
        has_key: hasStt,
        from_env: false,
      },
      providers: phoneProviders,
      fondo: data.fondo === "oscuro" ? "oscuro" : "claro",
    };
  }

  async function api(url, options) {
    const method = ((options && options.method) || "GET").toUpperCase();
    if (url === "/api/status") return statusBody(await loadIa());
    if (url === "/api/settings" && method === "POST") {
      const posted = JSON.parse((options && options.body) || "{}");
      return saveIa(posted);
    }
    if (url === "/api/zoom") return { recordings: [] };
    if (url === "/api/classes" && method === "GET") {
      const cursos = await cursosDeEstudio();
      const pack = publicarCursos(cursos, readCursoId());
      if (!pack.activo) return { classes: [], cursos: pack };
      const rows = await rest("GET", `/rest/v1/clases?select=id,titulo,materia,universidad,carrera,curso_id,duracion,estado,detalle,creado,estudio&curso_id=eq.${pack.activo}&order=creado.desc`);
      const estudio = estudioActual();
      const list = (Array.isArray(rows) ? rows : []).filter((row) => (
        estudio
        && row.universidad === estudio.universidad
        && row.carrera === estudio.carrera
        && row.curso_id === pack.activo
      ));
      const orden = await loadOrden();
      return { classes: ordenarClases(list.map(card), orden[pack.activo]), cursos: pack };
    }
    if (url === "/api/classes/order" && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      return saveOrden(body.ids);
    }
    if (url === "/api/classes" && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const id = await saveEntry({ link: body.url || "", materia: body.materia || "" });
      return { id };
    }
    const job = url.match(/^\/api\/jobs\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})$/);
    if (job) return withLocal(card(await one(job[1])));
    const title = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/title$/);
    if (title && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const nombre = String(body.title || "").replace(/\s+/g, " ").trim().slice(0, 140);
      if (!nombre) throw new Error("Escribe un nombre.");
      const row = await one(title[1]);
      const estudio = {
        ...(row.estudio || {}),
        titulo: nombre,
        titulo_custom: true,
        titulo_en: Math.floor(Date.now() / 1000),
      };
      await rest("PATCH", `/rest/v1/clases?id=eq.${title[1]}`, {
        titulo: nombre,
        materia: String(body.materia || "").slice(0, 120),
        estudio,
      });
      return card(await one(title[1]));
    }
    const fechaClase = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/fecha$/);
    if (fechaClase && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const iso = fechaIso(body.fecha);
      if (!iso) throw new Error("Escribe una fecha válida.");
      const row = await one(fechaClase[1]);
      const estudio = { ...(row.estudio || {}), fecha_clase: iso, fecha_custom: true };
      await rest("PATCH", `/rest/v1/clases?id=eq.${fechaClase[1]}`, { estudio });
      return card(await one(fechaClase[1]));
    }
    const item = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})$/);
    if (item && method === "GET") return detail(item[1]);
    if (item && method === "DELETE") {
      await rest("DELETE", `/rest/v1/clases?id=eq.${item[1]}`);
      try {
        await session();
        await fetch(`${cfg.url}/storage/v1/object/diapositivas`, {
          method: "DELETE",
          headers: {
            apikey: cfg.anon,
            Authorization: `Bearer ${access}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prefixes: [item[1]] }),
        });
      } catch { /* la clase ya se borró */ }
      await forgetBrowser(item[1]);
      return { ok: true };
    }
    const retry = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/retry$/);
    if (retry && method === "POST") {
      const row = await one(retry[1]);
      if (!row.video_url) throw new Error("Esa clase ya no tiene el video para prepararla de nuevo.");
      if (typeof youtubeHref === "function" && youtubeHref(row.video_url)) {
        throw new Error("Esta clase se ve por YouTube. Para prepararla de nuevo pega el enlace de Zoom o el archivo.");
      }
      await rest("PATCH", `/rest/v1/clases?id=eq.${retry[1]}`, {
        estado: "pendiente",
        detalle: "La computadora prepara el video y lo publica",
      });
      return withLocal(card(await one(retry[1])));
    }
    const chat = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/chat$/);
    if (chat && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const message = String(body.message || "").trim();
      if (!message) throw new Error("Escribe una pregunta.");
      return askRemote(chat[1], message);
    }
    const respuesta = url.match(/^\/api\/classes\/([0-9]{8}-[0-9]{6}-[0-9a-f]{6})\/respuesta$/);
    if (respuesta && method === "POST") {
      const body = JSON.parse((options && options.body) || "{}");
      const indice = Number(body.indice);
      if (!Number.isInteger(indice) || indice < 0) throw new Error("Esa tarea no está en la clase.");
      return askRespuesta(respuesta[1], indice);
    }
    throw new Error("Esa acción no está en esta página.");
  }

  window.claseClaraCloud = {
    api,
    saveEntry,
    saveYouTube,
    elegirCurso,
    crearCurso,
    renombrarCurso,
    asignarCurso,
    salir,
  };

  const cursoStore = "cc-curso";

  function esIdCurso(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ""));
  }

  function esIdClase(id) {
    return /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(String(id || ""));
  }

  function ordenarClases(list, ids) {
    const rank = new Map();
    (Array.isArray(ids) ? ids : []).forEach((id, index) => {
      if (esIdClase(id) && !rank.has(id)) rank.set(id, index);
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

  async function loadOrden() {
    try {
      await session();
      const response = await fetch(`${cfg.url}/storage/v1/object/diapositivas/ajustes/orden.json?t=${Date.now()}`, {
        cache: "no-store",
        headers: { apikey: cfg.anon, Authorization: `Bearer ${access}` },
      });
      if (!response.ok) return {};
      const data = await response.json().catch(() => null);
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  async function saveOrden(ids) {
    const curso = window.CLASECLARA_CURSOS && window.CLASECLARA_CURSOS.activo;
    if (!esIdCurso(curso)) throw new Error("Elige un curso antes de ordenar las clases.");
    const clean = [];
    const seen = new Set();
    (Array.isArray(ids) ? ids : []).forEach((id) => {
      const text = String(id || "");
      if (!esIdClase(text) || seen.has(text) || clean.length >= 200) return;
      seen.add(text);
      clean.push(text);
    });
    const all = await loadOrden();
    all[curso] = clean;
    const blob = new Blob([JSON.stringify(all)], { type: "application/octet-stream" });
    await putPart("ajustes/orden.json", blob, "No pude guardar el orden de las clases.");
    return { ok: true };
  }

  function estudioLlave() {
    const estudio = estudioActual();
    if (!estudio) return "";
    return `${estudio.universidad}\u0000${estudio.carrera}`;
  }

  function readCursoId() {
    try {
      const all = JSON.parse(localStorage.getItem(cursoStore) || "{}");
      return String((all && all[estudioLlave()]) || "");
    } catch {
      return "";
    }
  }

  function writeCursoId(id) {
    const key = estudioLlave();
    if (!key) return;
    let all = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(cursoStore) || "{}");
      if (parsed && typeof parsed === "object") all = parsed;
    } catch { /* se vuelve a guardar solo esta carrera */ }
    if (id) all[key] = id;
    else delete all[key];
    localStorage.setItem(cursoStore, JSON.stringify(all));
  }

  function cursoNombre(nombre) {
    const text = String(nombre || "").trim().replace(/\s+/g, " ");
    if (!text) throw new Error("Escribe el nombre del curso.");
    if (text.length > 80) throw new Error("El nombre del curso es muy largo.");
    return text;
  }

  function publicarCursos(rows, activo) {
    const items = (Array.isArray(rows) ? rows : []).map((item) => ({
      id: item.id,
      nombre: item.nombre,
    }));
    const id = items.some((item) => item.id === activo) ? activo : (items[0] ? items[0].id : "");
    writeCursoId(id);
    const actual = items.find((item) => item.id === id);
    const pack = { items, activo: id, nombre: actual ? actual.nombre : "" };
    window.CLASECLARA_CURSOS = pack;
    return pack;
  }

  async function cursosDeEstudio() {
    const rows = await rest("GET", "/rest/v1/cursos?select=id,nombre,creado&order=creado.asc");
    return Array.isArray(rows) ? rows : [];
  }

  async function nombreCurso(id) {
    if (!esIdCurso(id)) return "";
    const pack = window.CLASECLARA_CURSOS;
    const known = pack && Array.isArray(pack.items) ? pack.items.find((item) => item.id === id) : null;
    if (known) return known.nombre || "";
    const rows = await rest("GET", `/rest/v1/cursos?id=eq.${id}&select=nombre`);
    return rows && rows[0] ? rows[0].nombre || "" : "";
  }

  function elegirCurso(id) {
    const pack = window.CLASECLARA_CURSOS || { items: [] };
    if (!pack.items.some((item) => item.id === id)) throw new Error("No encuentro ese curso.");
    return publicarCursos(pack.items, id);
  }

  function errorCurso(error, fallo) {
    if (/23505|duplicate key/i.test(String(error && error.message))) {
      throw new Error("Ya hay un curso con ese nombre.");
    }
    throw new Error(fallo);
  }

  async function crearCurso(nombre) {
    const limpio = cursoNombre(nombre);
    const estudio = estudioActual();
    if (!estudio) throw new Error("Entra de nuevo para crear el curso.");
    try {
      await rest("POST", "/rest/v1/cursos", {
        universidad: estudio.universidad,
        carrera: estudio.carrera,
        nombre: limpio,
      });
    } catch (error) {
      errorCurso(error, "No pude crear el curso.");
    }
    const rows = await cursosDeEstudio();
    const creado = rows.find((item) => item.nombre === limpio);
    if (!creado) throw new Error("No pude crear el curso.");
    return publicarCursos(rows, creado.id);
  }

  async function renombrarCurso(id, nombre) {
    if (!esIdCurso(id)) throw new Error("No encuentro ese curso.");
    const limpio = cursoNombre(nombre);
    try {
      await rest("PATCH", `/rest/v1/cursos?id=eq.${id}`, { nombre: limpio });
    } catch (error) {
      errorCurso(error, "No pude renombrar el curso.");
    }
    const rows = (window.CLASECLARA_CURSOS?.items || []).map((item) => (
      item.id === id ? { id: item.id, nombre: limpio } : item
    ));
    return publicarCursos(rows, readCursoId());
  }

  async function asignarCurso(classId, cursoId) {
    if (!/^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(String(classId || ""))) {
      throw new Error("No encuentro esa clase.");
    }
    if (!esIdCurso(cursoId)) throw new Error("Elige un curso.");
    await rest("PATCH", `/rest/v1/clases?id=eq.${classId}`, { curso_id: cursoId });
  }

  const cuentaKey = "cc-cuenta";

  function escGate(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  const universidades = [
    "Universidad César Vallejo",
    "Universidad Privada del Norte",
    "Universidad Autónoma",
  ];
  const carreras = ["Psicología"];

  function readCuenta() {
    try {
      const parsed = JSON.parse(localStorage.getItem(cuentaKey) || "null");
      if (!parsed || !parsed.email || !parsed.clave) return null;
      return {
        email: String(parsed.email),
        clave: String(parsed.clave),
        universidad: String(parsed.universidad || ""),
        carrera: String(parsed.carrera || ""),
      };
    } catch {
      return null;
    }
  }

  function writeCuenta(email, clave, universidad, carrera) {
    localStorage.setItem(cuentaKey, JSON.stringify({
      email,
      clave,
      universidad: String(universidad || ""),
      carrera: String(carrera || ""),
    }));
  }

  function estudioActual() {
    const saved = readCuenta();
    if (!saved || !saved.universidad || !saved.carrera) return null;
    return { universidad: saved.universidad, carrera: saved.carrera };
  }

  function clearSession() {
    localStorage.removeItem(sessionKey);
    access = "";
  }

  function clearCuenta() {
    localStorage.removeItem(cuentaKey);
    clearSession();
  }

  function correoGuardado() {
    try {
      const parsed = JSON.parse(localStorage.getItem(cuentaKey) || "null");
      return parsed && parsed.email ? String(parsed.email) : "";
    } catch {
      return "";
    }
  }

  function salir() {
    const saved = readCuenta();
    clearSession();
    const email = correoGuardado();
    if (email) {
      localStorage.setItem(cuentaKey, JSON.stringify({
        email,
        clave: "",
        universidad: saved ? saved.universidad : "",
        carrera: saved ? saved.carrera : "",
      }));
    } else {
      localStorage.removeItem(cuentaKey);
    }
    window.CLASECLARA_ESTUDIO = null;
    window.CLASECLARA_CURSOS = null;
    window.CLASECLARA_DENTRO = false;
    window.CLASECLARA_HOLD = true;
    showLanding("entrar");
  }

  function rememberSession(data) {
    access = data.access_token;
    localStorage.setItem(sessionKey, JSON.stringify({
      access: data.access_token,
      refresh: data.refresh_token,
      exp: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    }));
  }

  function openApp() {
    const saved = readCuenta();
    window.CLASECLARA_ESTUDIO = saved && saved.universidad
      ? { universidad: saved.universidad, carrera: saved.carrera }
      : null;
    window.CLASECLARA_DENTRO = true;
    window.CLASECLARA_HOLD = false;
    window.startClaseClara?.();
  }

  async function pedirCuenta(accion, email, clave, estudio) {
    const payload = { accion, email, clave };
    if (estudio) {
      payload.universidad = estudio.universidad;
      payload.carrera = estudio.carrera;
    }
    if (native) {
      const http = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
      if (!http) throw new Error("No pude hablar con la cuenta.");
      const result = await http.request({
        url: "https://clases-universitarias.netlify.app/.netlify/functions/cuenta",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: payload,
      });
      let data = result ? result.data : {};
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch { data = {}; }
      }
      if (!data || !data.estado) throw new Error("No pude hablar con la cuenta.");
      return data;
    }
    const response = await fetch("/.netlify/functions/cuenta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!data.estado) throw new Error("No pude hablar con la cuenta.");
    return data;
  }

  function gateMessage(estado) {
    if (estado === "existe") return "Ese correo ya está anotado. Si borras su fila en la tabla cuentas, se puede crear otra vez.";
    if (estado === "correo") return "Escribe un correo válido.";
    if (estado === "corta") return "La contraseña necesita al menos 6 caracteres.";
    if (estado === "estudio") return "Elige la universidad y la carrera.";
    if (estado === "mal") return "Ese correo y esa contraseña no coinciden.";
    if (estado === "no") return "Ese correo no está anotado. Crea la cuenta.";
    return "No pude completar la cuenta.";
  }

  function showWaiting(email) {
    clearSession();
    const root = document.querySelector("#app");
    if (!root) return;
    root.innerHTML = `
      <section class="hero">
        <p class="kicker">Cuenta anotada</p>
        <h1>Falta activar ${escGate(email)}.</h1>
        <p class="lede">El correo y la contraseña quedaron guardados en este aparato. En Supabase abre Table Editor, tabla cuentas, y pon activo en true. Luego pulsa Revisar.</p>
      </section>
      <section class="panel gate">
        <div class="row">
          <button class="primary" id="gate-check" type="button">Revisar</button>
          <button class="ghost" id="gate-other" type="button">Usar otro correo</button>
        </div>
        <p class="note" id="gate-error" hidden></p>
      </section>`;
    document.querySelector("#gate-check").onclick = () => checkSaved();
    window.CLASECLARA_DENTRO = false;
    window.renderChrome?.();
    document.querySelector("#gate-other").onclick = () => {
      clearCuenta();
      showLanding("entrar");
    };
  }

  function showLanding(mode, message) {
    const root = document.querySelector("#app");
    if (!root) return;
    const crear = mode === "crear";
    const correo = correoGuardado();
    root.innerHTML = `
      <section class="hero">
        <p class="kicker">ClaseClara</p>
        <h1>Entra a tus clases.</h1>
        <p class="lede">Crea una cuenta con tu correo, tu universidad y tu carrera. Entras enseguida. En este aparato se guardan el correo y la contraseña.</p>
      </section>
      <section class="panel gate">
        <h2>${crear ? "Crear cuenta" : "Entrar"}</h2>
        <label for="gate-email">Correo</label>
        <input id="gate-email" type="email" autocomplete="username" value="${escGate(correo)}">
        <label for="gate-pass">Contraseña</label>
        <div class="pass-line">
          <input id="gate-pass" type="password" autocomplete="${crear ? "new-password" : "current-password"}" autocapitalize="off" spellcheck="false">
          <button class="ghost" id="gate-show" type="button" aria-pressed="false" aria-controls="gate-pass">Ver</button>
        </div>
        ${crear ? `
        <label for="gate-uni">Universidad</label>
        <select id="gate-uni">
          <option value="">Elige la universidad</option>
          ${universidades.map((nombre) => `<option value="${escGate(nombre)}">${escGate(nombre)}</option>`).join("")}
        </select>
        <label for="gate-carrera">Carrera</label>
        <select id="gate-carrera">
          ${carreras.map((nombre) => `<option value="${escGate(nombre)}">${escGate(nombre)}</option>`).join("")}
        </select>` : ""}
        <div class="row">
          <button class="primary" id="gate-go" type="button">${crear ? "Crear cuenta" : "Entrar"}</button>
          <button class="ghost" id="gate-switch" type="button">${crear ? "Ya tengo cuenta" : "Crear cuenta"}</button>
        </div>
        <p class="note" id="gate-error" ${message ? "" : "hidden"}>${escGate(message || "")}</p>
      </section>`;
    document.querySelector("#gate-switch").onclick = () => showLanding(crear ? "entrar" : "crear");
    document.querySelector("#gate-show").onclick = () => {
      const input = document.querySelector("#gate-pass");
      const button = document.querySelector("#gate-show");
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.textContent = visible ? "Ocultar" : "Ver";
      button.setAttribute("aria-pressed", visible ? "true" : "false");
      input.focus();
    };
    document.querySelector("#gate-go").onclick = async () => {
      const button = document.querySelector("#gate-go");
      const note = document.querySelector("#gate-error");
      const email = document.querySelector("#gate-email").value.trim();
      const clave = document.querySelector("#gate-pass").value;
      const estudio = crear ? {
        universidad: document.querySelector("#gate-uni").value,
        carrera: document.querySelector("#gate-carrera").value,
      } : null;
      button.disabled = true;
      note.hidden = true;
      try {
        const data = await pedirCuenta(crear ? "crear" : "entrar", email, clave, estudio);
        if (data.estado === "ok") {
          writeCuenta(email, clave, data.universidad, data.carrera);
          rememberSession(data);
          openApp();
          return;
        }
        if (data.estado === "pendiente") {
          writeCuenta(email, clave, data.universidad, data.carrera);
          showWaiting(email);
          return;
        }
        if (data.estado === "no" || data.estado === "mal") clearCuenta();
        note.hidden = false;
        note.textContent = gateMessage(data.estado);
        button.disabled = false;
      } catch (error) {
        note.hidden = false;
        note.textContent = error.message;
        button.disabled = false;
      }
    };
    window.CLASECLARA_DENTRO = false;
    window.renderChrome?.();
  }

  async function checkSaved() {
    const saved = readCuenta();
    if (!saved) {
      showLanding("entrar");
      return;
    }
    try {
      const data = await pedirCuenta("entrar", saved.email, saved.clave);
      if (data.estado === "ok") {
        writeCuenta(saved.email, saved.clave, data.universidad || saved.universidad, data.carrera || saved.carrera);
        rememberSession(data);
        openApp();
        return;
      }
      if (data.estado === "pendiente") {
        showWaiting(saved.email);
        return;
      }
      clearCuenta();
      showLanding("entrar", data.estado === "mal"
        ? "La contraseña guardada ya no coincide. Escríbela de nuevo."
        : "Ese correo ya no está. Puedes crear la cuenta otra vez.");
    } catch (error) {
      showLanding("entrar", error.message);
    }
  }

  if (native || (onWeb && !cfg.password)) {
    window.CLASECLARA_HOLD = true;
    queueMicrotask(() => { checkSaved(); });
  }
})();
