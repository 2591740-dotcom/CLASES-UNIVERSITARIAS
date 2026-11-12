// Con la PC apagada, la web baja la grabación de Zoom y la sube a YouTube.
// No guarda la contraseña ni escribe los enlaces en el registro.
import { env } from "./linkeo-turno.mjs";

const UNI = "Universidad César Vallejo";
const CARRERA = "Psicología";
const CHUNK = 8 * 1024 * 1024;
const MAX_VIDEO = 2_500_000_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClaseClara";
const UA_PAGINA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

export class Aviso extends Error {
  constructor(motivo) {
    super(motivo);
    this.motivo = motivo;
  }
}

function partesLima(epoch) {
  const lima = new Date(Number(epoch) * 1000 - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = lima.getUTCMonth() + 1;
  const d = lima.getUTCDate();
  const p = (n) => String(n).padStart(2, "0");
  return {
    y, m, d,
    hh: lima.getUTCHours(),
    mm: lima.getUTCMinutes(),
    iso: `${y}-${p(m)}-${p(d)}`,
  };
}

export function nombreCurso(nombre) {
  const text = String(nombre || "").replace(/\s+/g, " ").trim();
  if (text.length <= 80) return text;
  let corto = text.slice(0, 80).replace(/\s+$/, "");
  const espacio = corto.lastIndexOf(" ");
  if (espacio >= 40) corto = corto.slice(0, espacio);
  return corto.replace(/[ .\-]+$/, "");
}

function hostDe(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostPublico(host) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!name || name === "localhost" || name.endsWith(".local")) return false;
  if (name === "::1" || name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80")) return false;
  const v4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return true;
  const n = v4.slice(1).map(Number);
  if (n.some((x) => x > 255)) return false;
  const [a, b] = n;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 192 && b === 168) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function esUrlPublica(url) {
  try {
    const parts = new URL(url);
    if (parts.protocol !== "https:" || parts.username || parts.password) return false;
    return hostPublico(parts.hostname);
  } catch {
    return false;
  }
}

export function zoomRec(url) {
  const text = String(url || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 2000) return "";
  let parts;
  try {
    parts = new URL(text);
  } catch {
    return "";
  }
  const host = parts.hostname.toLowerCase();
  if (parts.protocol !== "https:" || !host.endsWith("zoom.us")) return "";
  if (!["/rec/play/", "/rec/share/", "/rec/download/"].some((piece) => parts.pathname.includes(piece))) return "";
  return text;
}

export function fuenteZoom(url) {
  const cleaned = zoomRec(url);
  if (!cleaned) return "";
  const parts = new URL(cleaned);
  const path = parts.pathname;
  for (const marker of ["/rec/play/", "/rec/share/", "/rec/download/"]) {
    const at = path.indexOf(marker);
    if (at < 0) continue;
    const token = path.slice(at + marker.length).replace(/^\/+|\/+$/g, "").split("/")[0];
    if (token.length >= 8 && token.length <= 240) return `zoom:${parts.hostname.toLowerCase()}/${token}`;
  }
  return "";
}

export function fuenteYouTube(url) {
  const match = String(url || "").match(/[?&]v=([A-Za-z0-9_-]{11})/);
  return match ? `yt:${match[1]}` : "";
}

function playbackUrl(url) {
  const cleaned = zoomRec(url);
  if (!cleaned) return "";
  const parts = new URL(cleaned);
  parts.pathname = parts.pathname.replace("/rec/play/", "/rec/download/").replace("/rec/share/", "/rec/download/");
  return parts.toString();
}

function urlReproductor(url) {
  const parts = new URL(url);
  if (!parts.pathname.includes("/rec/download/")) return url;
  parts.pathname = parts.pathname.replace("/rec/download/", "/rec/play/");
  return parts.toString();
}

export function fechaCita(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100) return "";
  const found = new Date(Date.UTC(year, month - 1, day));
  if (found.getUTCFullYear() !== year || found.getUTCMonth() !== month - 1 || found.getUTCDate() !== day) return "";
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export function fechaParaClase(value, epoch) {
  const iso = fechaCita(value);
  if (!iso) return "";
  const hoy = partesLima(epoch);
  const tope = new Date(Date.UTC(hoy.y, hoy.m - 1, hoy.d));
  tope.setUTCDate(tope.getUTCDate() + 1);
  const [y, m, d] = iso.split("-").map(Number);
  const found = new Date(Date.UTC(y, m - 1, d));
  if (found > tope) return "";
  return iso;
}

function horaInicio(valor) {
  const match = String(valor || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "";
  const hora = Number(match[1]);
  const minuto = Number(match[2]);
  if (hora > 23 || minuto > 59) return "";
  return `${String(hora).padStart(2, "0")}:${match[2]}`;
}

function esAsincronica(nombre) {
  return /asincr[oó]nic/i.test(String(nombre || ""));
}

function tituloClase(sesion) {
  const numero = String(sesion.numero || "").trim();
  const titulo = String(sesion.titulo || "").replace(/\s+/g, " ").trim();
  const ya = numero && new RegExp(`^sesi[oó]n\\s+0*${numero}\\b`, "i").test(titulo);
  let text = "Clase";
  if (numero && titulo && !ya) text = `Sesión ${numero} · ${titulo}`;
  else if (titulo) text = titulo;
  else if (numero) text = `Sesión ${numero}`;
  return text.slice(0, 140);
}

function tituloAsincronico(titulo) {
  let text = String(titulo || "").replace(/\s+/g, " ").trim();
  if (esAsincronica(text)) return text.slice(0, 140);
  const marca = text.match(/^(sesi[oó]n\s+\d+)\s*·\s*(.*)$/i);
  text = marca ? `${marca[1]} · Asincrónica · ${marca[2]}` : `Asincrónica · ${text}`;
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function citaAsincronica(nombre, anio) {
  const texto = String(nombre || "").replace(/\s+/g, " ").trim();
  let fecha = "";
  const match = texto.match(/(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?/i);
  if (match) {
    const year = Number(match[3] || anio || 0);
    const month = MESES[match[2].toLowerCase()];
    const day = Number(match[1]);
    if (year >= 2000 && year <= 2100 && month) {
      const found = new Date(Date.UTC(year, month - 1, day));
      if (found.getUTCFullYear() === year && found.getUTCMonth() === month - 1 && found.getUTCDate() === day) {
        fecha = found.toISOString().slice(0, 10);
      }
    }
  }
  const reloj = texto.match(/(\d{1,2}):(\d{2})/);
  const hora = reloj ? horaInicio(`${Number(reloj[1])}:${reloj[2]}`) : "";
  return { fecha, hora };
}

function esFutura(fecha, hora, epoch) {
  const iso = fechaCita(fecha);
  if (!iso) return false;
  const ahora = partesLima(epoch);
  const clock = horaInicio(hora);
  if (!clock) return iso > ahora.iso;
  if (iso !== ahora.iso) return iso > ahora.iso;
  const [hh, mm] = clock.split(":").map(Number);
  return hh > ahora.hh || (hh === ahora.hh && mm > ahora.mm);
}

function tieneGrabacion(sesion) {
  const enlaces = Array.isArray(sesion.enlaces) ? sesion.enlaces : [];
  return enlaces.some((item) => item && zoomRec(item.url));
}

export function entradasDe(cursos, epoch) {
  const salida = [];
  const vistos = new Set();
  for (const curso of Array.isArray(cursos) ? cursos : []) {
    if (!curso || typeof curso !== "object") continue;
    const nombre = nombreCurso(curso.nombre || "");
    if (!nombre) continue;
    for (const sesion of Array.isArray(curso.sesiones) ? curso.sesiones : []) {
      if (!sesion || typeof sesion !== "object") continue;
      const futura = esFutura(sesion.fecha_iso, sesion.hora, epoch) && !tieneGrabacion(sesion);
      if (futura) continue;
      const titulo = tituloClase(sesion);
      const fecha = fechaCita(sesion.fecha_iso);
      const hora = horaInicio(sesion.hora);
      for (const enlace of Array.isArray(sesion.enlaces) ? sesion.enlaces : []) {
        if (!enlace || typeof enlace !== "object") continue;
        const url = zoomRec(enlace.url);
        if (!url || vistos.has(url)) continue;
        vistos.add(url);
        let tituloItem = titulo;
        let fechaItem = fecha;
        let horaItem = hora;
        if (esAsincronica(enlace.nombre)) {
          tituloItem = tituloAsincronico(titulo);
          const cita = citaAsincronica(enlace.nombre, fecha.slice(0, 4));
          if (cita.fecha) fechaItem = cita.fecha;
          if (cita.hora) horaItem = cita.hora;
        }
        salida.push({
          curso: nombre,
          titulo: tituloItem,
          fecha: fechaItem,
          hora: horaItem,
          url,
          profesor: profesorLimpio(curso.profesor),
          presentaciones: archivosHttps(sesion.presentaciones, "Presentación"),
          lecturas: lecturasDe(sesion.enlaces),
        });
      }
    }
  }
  return salida;
}

function profesorLimpio(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.toLowerCase() === "sin profesor visible") return "";
  return text.slice(0, 160);
}

function urlSinToken(url) {
  const text = String(url || "").trim();
  if (!text.startsWith("https://") || text.length > 800) return "";
  let parts;
  try { parts = new URL(text); } catch { return ""; }
  const host = parts.hostname.toLowerCase();
  if (!host || !hostPublico(host)) return "";
  if (host === "uvcv.edu.pe" || host.endsWith(".uvcv.edu.pe")) {
    parts.pathname = parts.pathname.replace("/webservice/pluginfile.php/", "/pluginfile.php/");
    if (parts.pathname.includes("/pluginfile.php/")) parts.search = "";
  }
  const cleaned = parts.toString();
  return cleaned.startsWith("https://") && cleaned.length <= 800 ? cleaned : "";
}

function esZoomHost(url) {
  const host = hostDe(url);
  return host === "zoom.us" || host.endsWith(".zoom.us");
}

function archivosHttps(value, fallback) {
  if (!Array.isArray(value)) return [];
  const salida = [];
  const vistos = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const url = urlSinToken(item.url);
    if (!url || esZoomHost(url) || vistos.has(url)) continue;
    vistos.add(url);
    const nombre = String(item.nombre || "").replace(/\s+/g, " ").trim().slice(0, 160) || fallback;
    salida.push({ nombre, url });
    if (salida.length >= 6) break;
  }
  return salida;
}

function lecturasDe(enlaces) {
  const crudas = [];
  for (const item of Array.isArray(enlaces) ? enlaces : []) {
    if (!item || typeof item !== "object" || zoomRec(item.url)) continue;
    const nombre = String(item.nombre || "");
    const url = String(item.url || "");
    if (/(?:pptx?|ppsx?|diapositivas?|presentaci[oó]n)/i.test(`${nombre} ${url}`)) continue;
    crudas.push(item);
  }
  return archivosHttps(crudas, "Lectura");
}

function visible(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
}

function pideClave(html) {
  return /<form\b[^>]*\b(?:id|name)\s*=\s*['"]password_form['"]/i.test(visible(html));
}

function idSeguro(value) {
  return /^[A-Za-z0-9_.+\-=~]{1,500}$/.test(String(value || ""));
}

function idEnPagina(texto, clave) {
  const match = String(texto || "").match(new RegExp(`["']?${clave}["']?\\s*[:=]\\s*['"]([^'"]+)['"]`));
  return match && idSeguro(match[1]) ? match[1] : "";
}

function datosReproductor(html) {
  const text = String(html || "").replace(/^\uFEFF/, "");
  const salida = {};
  for (const clave of ["fileId", "meetingId"]) {
    const directo = idEnPagina(text, clave);
    const plano = directo || idEnPagina(text.replace(/\\"/g, '"'), clave);
    if (plano) salida[clave] = plano;
  }
  return salida;
}

function elegirMp4(info, base) {
  const result = info && typeof info.result === "object" ? info.result : info;
  const bolsa = result && typeof result === "object" ? result : {};
  for (const clave of ["viewMp4WithshareUrl", "viewMp4Url", "shareMp4Url"]) {
    const crudo = String(bolsa[clave] || "").trim();
    if (!crudo) continue;
    let absoluto = crudo;
    if (!/^https:\/\//i.test(crudo)) {
      try { absoluto = new URL(crudo, base).toString(); } catch { continue; }
    }
    if (esUrlPublica(absoluto) && absoluto.length <= 16000) return absoluto;
  }
  return "";
}

function urlPlaySeguro(redirect, base) {
  if (!redirect) return "";
  let absoluto;
  try { absoluto = new URL(String(redirect).trim(), base).toString(); } catch { return ""; }
  if (!esUrlPublica(absoluto) || absoluto.length > 2000) return "";
  const path = new URL(absoluto).pathname;
  if (!path.includes("/rec/play/") && !path.includes("/rec/share/")) return "";
  if (!hostDe(absoluto).endsWith("zoom.us")) return "";
  return absoluto;
}

export async function resolverGrabacion(url, pedir) {
  const cleaned = zoomRec(url);
  if (!cleaned) throw new Aviso("video");
  let pagina = urlReproductor(cleaned);
  let html = await pedir(pagina);
  if (typeof html !== "string") html = JSON.stringify(html || "");
  if (pideClave(html)) throw new Aviso("clave");
  let continuo = false;
  if (new URL(pagina).pathname.includes("/rec/share/")) {
    const meeting = datosReproductor(html).meetingId || "";
    if (!meeting) throw new Aviso("video");
    const base = new URL(pagina).origin + "/";
    const info = await pedir(base + "nws/recording/1.0/play/share-info/" + encodeURIComponent(meeting));
    const data = typeof info === "string" ? JSON.parse(info) : info;
    const result = data && typeof data.result === "object" ? data.result : {};
    const play = urlPlaySeguro(result.redirectUrl, base);
    if (!play) throw new Aviso("video");
    html = await pedir(play);
    if (typeof html !== "string") html = JSON.stringify(html || "");
    if (pideClave(html)) throw new Aviso("clave");
    pagina = play;
    continuo = true;
  }
  const fileId = datosReproductor(html).fileId || "";
  if (!fileId) throw new Aviso("video");
  const base = new URL(pagina).origin + "/";
  const consulta = continuo ? "?continueMode=true" : "";
  const info = await pedir(base + "nws/recording/1.0/play/info/" + encodeURIComponent(fileId) + consulta);
  const data = typeof info === "string" ? JSON.parse(info) : info;
  const media = elegirMp4(data, base);
  if (!media) throw new Aviso("video");
  return media;
}

function totalDe(response) {
  const range = response.headers.get("content-range") || "";
  const match = range.match(/\/(\d+)\s*$/);
  if (match) return Number(match[1]);
  if (response.status === 200) {
    const n = Number(response.headers.get("content-length") || 0);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function cookiesDe(response, previas) {
  const jar = new Map();
  for (const parte of String(previas || "").split(";")) {
    const trozo = parte.trim();
    const eq = trozo.indexOf("=");
    if (eq > 0) jar.set(trozo.slice(0, eq), trozo.slice(eq + 1));
  }
  const listas = [];
  if (response && response.headers && typeof response.headers.getSetCookie === "function") {
    listas.push(...response.headers.getSetCookie());
  } else if (response && response.headers && typeof response.headers.get === "function") {
    const uno = response.headers.get("set-cookie");
    if (uno) listas.push(uno);
  }
  for (const cruda of listas) {
    const par = String(cruda).split(";")[0];
    const eq = par.indexOf("=");
    if (eq > 0) jar.set(par.slice(0, eq).trim(), par.slice(eq + 1).trim());
  }
  return [...jar.entries()].map(([clave, valor]) => `${clave}=${valor}`).join("; ");
}

function conSesion(pedir) {
  let cookie = "";
  let referer = "";
  return {
    async pedir(url) {
      const headers = {
        "User-Agent": UA_PAGINA,
        Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      };
      if (cookie) headers.Cookie = cookie;
      const response = await pedir(url, { headers, redirect: "follow" });
      if (!response || !esUrlPublica(response.url || url)) throw new Aviso("video");
      cookie = cookiesDe(response, cookie);
      const tipo = String(response.headers.get("content-type") || "");
      if (!tipo.includes("json")) referer = response.url || url;
      if (tipo.includes("json")) return response.json();
      return response.text();
    },
    sesion() {
      return { cookie, referer };
    },
  };
}

async function medir(url, pedir = fetch, sesion = {}) {
  if (!esUrlPublica(url)) return null;
  const headers = {
    "User-Agent": sesion.cookie ? UA_PAGINA : USER_AGENT,
    Range: "bytes=0-0",
  };
  if (sesion.cookie) headers.Cookie = sesion.cookie;
  if (sesion.referer) headers.Referer = sesion.referer;
  const response = await pedir(url, {
    headers,
    redirect: "follow",
  });
  const soltar = () => {
    try {
      if (response && response.body) response.body.cancel();
    } catch {
      /* la sonda de un byte ya no hace falta */
    }
  };
  if (!response || !esUrlPublica(response.url || url)) {
    soltar();
    return null;
  }
  const tipo = String(response.headers.get("content-type") || "").toLowerCase();
  if (!tipo || tipo.includes("text/html") || tipo.includes("json")) {
    soltar();
    return null;
  }
  const bytes = totalDe(response);
  if (bytes < 100000 || bytes > MAX_VIDEO) {
    soltar();
    return null;
  }
  soltar();
  return {
    url: response.url || url,
    bytes,
    tipo: tipo.startsWith("audio/") ? tipo.slice(0, 80) : "video/mp4",
    cookie: sesion.cookie || "",
    referer: sesion.referer || "",
  };
}

export async function urlDelVideo(playUrl, pedir) {
  const directo = playbackUrl(playUrl);
  const medido = await medir(directo, pedir);
  if (medido) return medido;
  const jar = conSesion(pedir);
  const media = await resolverGrabacion(playUrl, (url) => jar.pedir(url));
  const archivo = await medir(media, pedir, jar.sesion());
  if (!archivo) throw new Aviso("video");
  return archivo;
}

function cuerpoVideo(titulo) {
  const name = String(titulo || "").replace(/\s+/g, " ").trim().slice(0, 100) || "Clase";
  return {
    snippet: { title: name, description: "ClaseClara", categoryId: "27" },
    status: { privacyStatus: "unlisted", embeddable: true, selfDeclaredMadeForKids: false },
  };
}

function nube() {
  return {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    secret: env("SUPABASE_SERVICE_ROLE"),
  };
}

async function rest(path, options = {}) {
  const { url, secret } = nube();
  if (!url || !secret) throw new Aviso("nube");
  const response = await fetch(url + path, {
    method: options.method || "GET",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.prefer ? { Prefer: options.prefer } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.vacio) {
    if (!response.ok) throw new Aviso("nube");
    return null;
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Aviso("nube");
  return data;
}

async function credencialesYouTube() {
  const { url, secret } = nube();
  if (!url || !secret) return null;
  const response = await fetch(`${url}/storage/v1/object/claseclara_privado/youtube.json`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.client_id || !data.client_secret || !data.refresh_token) return null;
  return data;
}

async function accesoGoogle(cred) {
  const body = new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) return "";
  return String(data.access_token);
}

async function abrirYouTube(access, titulo, bytes, tipo) {
  const open = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(bytes),
        "X-Upload-Content-Type": tipo || "video/mp4",
      },
      body: JSON.stringify(cuerpoVideo(titulo)),
    },
  );
  const location = open.headers.get("location") || "";
  if (!location.startsWith("https://") || !location.includes("googleapis.com") || !location.includes("/upload/")) {
    const text = await open.text().catch(() => "");
    if (open.status === 403 && /quota/i.test(text)) throw new Aviso("cuota");
    throw new Aviso("video");
  }
  return location;
}

async function poner(sesion, buf, start, total) {
  const end = start + buf.length - 1;
  const response = await fetch(sesion, {
    method: "PUT",
    redirect: "manual",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(buf.length),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
    body: buf,
  });
  if (response.status === 308) return "";
  const text = await response.text().catch(() => "");
  if (response.status === 403 && /quota/i.test(text)) throw new Aviso("cuota");
  if (response.status !== 200 && response.status !== 201) throw new Aviso("video");
  let data = {};
  try { data = JSON.parse(text || "{}"); } catch { data = {}; }
  const id = String(data.id || "");
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Aviso("video");
  return `https://www.youtube.com/watch?v=${id}`;
}

async function bajarYSubir(media, sesion) {
  const headers = { "User-Agent": media.cookie ? UA_PAGINA : USER_AGENT };
  if (media.cookie) headers.Cookie = media.cookie;
  if (media.referer) headers.Referer = media.referer;
  const response = await fetch(media.url, {
    headers,
    redirect: "follow",
  });
  if (!response.ok || !response.body || !esUrlPublica(response.url || media.url)) throw new Aviso("video");
  const reader = response.body.getReader();
  let extra = Buffer.alloc(0);
  let start = 0;
  const total = media.bytes;
  while (start < total) {
    let piece = extra;
    extra = Buffer.alloc(0);
    while (piece.length < CHUNK && start + piece.length < total) {
      const read = await reader.read();
      if (read.done) break;
      piece = Buffer.concat([piece, Buffer.from(read.value)]);
    }
    if (!piece.length) throw new Aviso("video");
    const sala = total - start;
    let enviar = piece;
    if (enviar.length > CHUNK) {
      extra = enviar.subarray(CHUNK);
      enviar = enviar.subarray(0, CHUNK);
    }
    if (enviar.length > sala) {
      extra = Buffer.concat([enviar.subarray(sala), extra]);
      enviar = enviar.subarray(0, sala);
    }
    const watch = await poner(sesion, enviar, start, total);
    start += enviar.length;
    if (watch) {
      try { await reader.cancel(); } catch { /* el video ya entró */ }
      return watch;
    }
  }
  throw new Aviso("video");
}

function clavesDeFila(row) {
  const keys = [];
  const zoom = fuenteZoom(row && row.video_url);
  const yt = fuenteYouTube(row && row.video_url);
  if (zoom) keys.push(zoom);
  if (yt) keys.push(yt);
  const estudio = row && row.estudio && typeof row.estudio === "object" ? row.estudio : {};
  if (Array.isArray(estudio.fuentes)) keys.push(...estudio.fuentes.map((item) => String(item || "")));
  return keys;
}

export function yaSubida(clave, filas, olvidadas) {
  if (!clave) return false;
  if (olvidadas && olvidadas.has(clave)) return true;
  return (filas || []).some((row) => clavesDeFila(row).includes(clave));
}

async function clavesOlvidadas() {
  const { url, secret } = nube();
  if (!url || !secret) throw new Aviso("nube");
  const response = await fetch(`${url}/storage/v1/object/diapositivas/ajustes/linkeo-mes.json`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  if (response.status === 400 || response.status === 404) return new Set();
  if (!response.ok) throw new Aviso("nube");
  const data = await response.json().catch(() => ({}));
  const claves = Array.isArray(data && data.claves) ? data.claves : [];
  return new Set(claves.map((item) => String(item || "")));
}

async function listarClases() {
  const rows = await rest("/rest/v1/clases?select=id,titulo,video_url,estudio,curso_id");
  return Array.isArray(rows) ? rows : [];
}

async function listarCursos() {
  const rows = await rest(
    `/rest/v1/cursos?select=id,nombre&universidad=eq.${encodeURIComponent(UNI)}&carrera=eq.${encodeURIComponent(CARRERA)}`,
  );
  return Array.isArray(rows) ? rows : [];
}

async function asegurarCurso(nombre) {
  const limpio = nombreCurso(nombre);
  const filas = await listarCursos();
  const hallado = filas.find((row) => nombreCurso(row && row.nombre).toLowerCase() === limpio.toLowerCase());
  if (hallado && hallado.id) return String(hallado.id);
  await rest("/rest/v1/cursos", {
    method: "POST",
    prefer: "return=minimal",
    vacio: true,
    body: { universidad: UNI, carrera: CARRERA, nombre: limpio },
  });
  const otra = (await listarCursos()).find((row) => nombreCurso(row && row.nombre).toLowerCase() === limpio.toLowerCase());
  if (!otra || !otra.id) throw new Aviso("nube");
  return String(otra.id);
}

function limpiarFuentes(keys) {
  const clean = [];
  for (const item of keys) {
    const key = String(item || "").trim();
    const zoom = key.startsWith("zoom:") && key.length >= 14 && key.length <= 300;
    const yt = /^yt:[A-Za-z0-9_-]{11}$/.test(key);
    if ((!zoom && !yt) || clean.includes(key)) continue;
    clean.push(key);
    if (clean.length >= 8) break;
  }
  return clean;
}

function nuevoId(epoch) {
  const ahora = partesLima(epoch);
  const p = (n) => String(n).padStart(2, "0");
  const segundos = new Date(Number(epoch) * 1000 - 5 * 3600 * 1000).getUTCSeconds();
  const hex = [...crypto.getRandomValues(new Uint8Array(3))].map((n) => n.toString(16).padStart(2, "0")).join("");
  return `${ahora.y}${p(ahora.m)}${p(ahora.d)}-${p(ahora.hh)}${p(ahora.mm)}${p(segundos)}-${hex}`;
}

async function crearClase(item, watch, epoch) {
  const clave = fuenteZoom(item.url);
  const yt = fuenteYouTube(watch);
  const fecha = fechaParaClase(item.fecha, epoch);
  const estudio = {
    titulo: item.titulo,
    titulo_custom: true,
    titulo_en: epoch,
    fuentes: limpiarFuentes([clave, yt]),
    web: true,
  };
  if (fecha) estudio.fecha_clase = fecha;
  if (item.hora) estudio.hora_clase = item.hora;
  if (item.profesor) estudio.profesor = item.profesor;
  if (item.presentaciones.length) estudio.presentaciones = item.presentaciones;
  if (item.lecturas.length) estudio.lecturas = item.lecturas;
  const id = nuevoId(epoch);
  await rest("/rest/v1/clases", {
    method: "POST",
    prefer: "return=minimal",
    vacio: true,
    body: {
      id,
      titulo: item.titulo.slice(0, 140),
      materia: item.curso.slice(0, 120),
      curso_id: item.cursoId,
      video_url: watch,
      duracion: 0,
      estudio,
      transcripcion: {},
      chat: [],
      estado: "procesando",
      detalle: "Preparando la explicación",
    },
  });
  return id;
}

async function pasoLista(lectura, cursos, base, epoch, pedir) {
  const { terminarClase, iaLista, claseWebAbierta, marcarClase } = await import("./linkeo-preparar.mjs");
  const ia = await iaLista();
  const pedida = lectura && lectura.enCurso && lectura.enCurso.id ? lectura.enCurso : null;
  let abierta = pedida;
  if (!abierta || !abierta.id) {
    try {
      abierta = await claseWebAbierta();
    } catch (error) {
      const motivo = error && error.motivo ? error.motivo : "nube";
      return { hecho: true, subidas: 0, ya: 0, avisos: 1, motivo, lectura: base };
    }
  }
  if (!ia) {
    if (abierta && abierta.id) {
      return { hecho: true, subidas: 0, ya: 0, avisos: 1, motivo: "sinia", lectura: { ...base, enCurso: abierta } };
    }
    return { hecho: false, subidas: 0, ya: 0, avisos: 0, motivo: "sinia", vacio: true, lectura: base };
  }
  if (!abierta || !abierta.id) return null;
  const veces = Number(lectura && lectura.reintento) || 0;
  try {
    await terminarClase(abierta, cursos, ia, epoch, pedir);
  } catch (error) {
    const motivo = error && error.motivo ? error.motivo : "video";
    if (motivo === "sinia" || motivo === "cuota" || motivo === "nube") {
      return { hecho: true, subidas: 0, ya: 0, avisos: 1, motivo, lectura: { ...base, enCurso: abierta, reintento: veces } };
    }
    if (veces < 1) {
      return {
        hecho: false,
        subidas: 0,
        ya: 0,
        avisos: 0,
        motivo: "",
        lectura: { ...base, enCurso: abierta, reintento: veces + 1 },
      };
    }
    try {
      await marcarClase(abierta.id, "No pude dejar la clase lista.");
    } catch (errorMarca) {
      const motivo = errorMarca && errorMarca.motivo ? errorMarca.motivo : "nube";
      return { hecho: true, subidas: 0, ya: 0, avisos: 1, motivo, lectura: { ...base, enCurso: abierta, reintento: veces } };
    }
  }
  return {
    hecho: false,
    subidas: 0,
    ya: 0,
    avisos: veces >= 1 ? 1 : 0,
    motivo: "",
    lectura: { ...base, enCurso: null, reintento: 0 },
    seguir: true,
  };
}

export async function publicar(item, epoch = Math.floor(Date.now() / 1000), pedir = fetch) {
  const cursoId = item.cursoId || await asegurarCurso(item.curso);
  const cred = await credencialesYouTube();
  if (!cred) throw new Aviso("sinyoutube");
  const access = await accesoGoogle(cred);
  if (!access) throw new Aviso("sinyoutube");
  const media = await urlDelVideo(item.url, pedir);
  const sesion = await abrirYouTube(access, item.titulo, media.bytes, media.tipo);
  const watch = await bajarYSubir(media, sesion);
  const id = await crearClase({ ...item, cursoId }, watch, epoch);
  return { id, watch, cursoId };
}

export async function subirUna(lectura, epoch = Math.floor(Date.now() / 1000), pedir = fetch) {
  const cursos = Array.isArray(lectura && lectura.cursos) ? lectura.cursos : [];
  const omitidos = new Set(Array.isArray(lectura && lectura.omitidos) ? lectura.omitidos : []);
  const propias = new Set(Array.isArray(lectura && lectura.propias) ? lectura.propias : []);
  const filas = await listarClases();
  const olvidadas = await clavesOlvidadas();
  let ya = 0;
  const pendientes = [];
  for (const item of entradasDe(cursos, epoch)) {
    const clave = fuenteZoom(item.url);
    if (!clave || omitidos.has(clave) || propias.has(clave)) continue;
    if (yaSubida(clave, filas, olvidadas)) {
      ya += 1;
      continue;
    }
    pendientes.push({ ...item, clave });
  }
  const base = {
    cursos,
    omitidos: [...omitidos],
    propias: [...propias],
    cuenta: lectura && lectura.cuenta || "",
    zoom_lectura: lectura && lectura.zoom_lectura || {},
  };
  const cerrado = await pasoLista(lectura, cursos, base, epoch, pedir);
  if (cerrado) {
    if (cerrado.vacio && cerrado.motivo === "sinia") {
      if (!pendientes.length) return { hecho: true, subidas: 0, ya, avisos: 0, motivo: "", lectura: base };
      return { hecho: true, subidas: 0, ya, avisos: 1, motivo: "sinia", lectura: base };
    }
    return {
      hecho: cerrado.seguir ? pendientes.length === 0 : cerrado.hecho,
      subidas: 0,
      ya,
      avisos: cerrado.avisos || 0,
      motivo: cerrado.motivo || "",
      lectura: cerrado.lectura,
    };
  }
  if (!pendientes.length) return { hecho: true, subidas: 0, ya, avisos: 0, motivo: "", lectura: base };
  const item = pendientes[0];
  try {
    const publicada = await publicar(item, epoch, pedir);
    item.cursoId = publicada.cursoId;
    propias.add(item.clave);
    return {
      hecho: false,
      subidas: 1,
      ya,
      avisos: 0,
      motivo: "",
      lectura: { ...base, propias: [...propias], enCurso: { id: publicada.id, clave: item.clave }, reintento: 0 },
    };
  } catch (error) {
    const motivo = error && error.motivo ? error.motivo : "video";
    if (motivo === "cuota" || motivo === "sinyoutube" || motivo === "nube") {
      return { hecho: true, subidas: 0, ya, avisos: 1, motivo, lectura: base };
    }
    omitidos.add(item.clave);
    return {
      hecho: pendientes.length === 1,
      subidas: 0,
      ya,
      avisos: 1,
      motivo: "",
      lectura: { ...base, omitidos: [...omitidos] },
    };
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function selfTest() {
  const largo = "202602 - E-V02 - LIMA NORTE - PROGRAMA DE INVESTIGACIÓN FORMATIVA - B10 extra que no cabe en el nombre";
  assert(nombreCurso(largo).length <= 80, "el curso se corta");
  assert(!nombreCurso(largo).endsWith("-"), "el corte no deja un guion");
  const play = "https://ucv-edu-pe.zoom.us/rec/play/tokenPlay12";
  assert(fuenteZoom(play) === "zoom:ucv-edu-pe.zoom.us/tokenPlay12", "clave de la grabación");
  assert(fuenteZoom("https://zoom.us/j/123") === "", "la reunión en vivo no entra");
  const olvidada = new Set(["zoom:ucv-edu-pe.zoom.us/tokenPlay12"]);
  assert(yaSubida("zoom:ucv-edu-pe.zoom.us/tokenPlay12", [], olvidada), "la grabación ya borrada no se vuelve a subir");
  assert(!yaSubida("zoom:ucv-edu-pe.zoom.us/otraClave1", [], olvidada), "otra grabación sí puede entrar");
  const ahora = Date.parse("2026-11-02T18:00:00Z") / 1000;
  const cursos = [{
    nombre: "Salud pública",
    profesor: "Ana",
    sesiones: [
      { numero: "8", titulo: "Examen", fecha_iso: "2026-12-01", hora: "19:00", enlaces: [] },
      {
        numero: "1",
        titulo: "Tema",
        fecha_iso: "2026-11-01",
        hora: "19:00–21:00",
        enlaces: [{ nombre: "Grabación", url: play }],
        presentaciones: [{ nombre: "Clase", url: "https://uvcv.edu.pe/pluginfile.php/1/tema.pptx?token=secreto" }],
      },
      {
        numero: "2",
        titulo: "Medidas",
        fecha_iso: "2026-11-03",
        hora: "20:00",
        enlaces: [{ nombre: "VIDEOCONFERENCIA ASINCRONICA 18 setiembre 2026 20:30", url: "https://ucv-edu-pe.zoom.us/rec/play/tokenAsinc1" }],
      },
      {
        numero: "9",
        titulo: "Ya grabada",
        fecha_iso: "2026-11-20",
        hora: "19:00",
        enlaces: [{ nombre: "Grabación", url: "https://ucv-edu-pe.zoom.us/rec/play/tokenFutura" }],
      },
    ],
  }];
  const entradas = entradasDe(cursos, ahora);
  assert(entradas.length === 3, "entran las que tienen grabación");
  assert(entradas[0].titulo === "Sesión 1 · Tema", "título");
  assert(entradas[0].hora === "19:00", "hora de empezar");
  assert(entradas[0].presentaciones[0].url === "https://uvcv.edu.pe/pluginfile.php/1/tema.pptx", "la presentación queda sin token");
  assert(entradas[1].titulo.startsWith("Sesión 2 · Asincrónica"), "la asincrónica se distingue");
  assert(entradas[1].fecha === "2026-09-18" && entradas[1].hora === "20:30", "cita escrita en el nombre");
  assert(entradas[2].titulo.includes("Ya grabada"), "la futura con grabación entra");
  assert(fechaParaClase("2026-11-20", ahora) === "", "una fecha lejana no se guarda en la clase");
  assert(fechaParaClase("2026-11-01", ahora) === "2026-11-01", "la fecha pasada se guarda");
  const base = "https://ucv-edu-pe.zoom.us/";
  const share = `${base}rec/share/tokenShare1`;
  const htmlShare = '<html><script>window.__data__ = {"meetingId":"meet-1"};</script></html>';
  const htmlPlay = '<html><script>window.__data__ = {"fileId":"file-1"};</script></html>';
  const rutas = {
    [share]: htmlShare,
    [`${base}nws/recording/1.0/play/share-info/meet-1`]: { result: { redirectUrl: "/rec/play/tokenPlay" } },
    [`${base}rec/play/tokenPlay`]: htmlPlay,
    [`${base}nws/recording/1.0/play/info/file-1?continueMode=true`]: {
      result: { viewMp4WithshareUrl: "https://file.zoom.us/juntos.mp4" },
    },
  };
  assert(await resolverGrabacion(share, async (url) => rutas[url]) === "https://file.zoom.us/juntos.mp4", "la página share entrega el video");
  assert(elegirMp4({ result: { viewMp4Url: "https://127.0.0.1/a.mp4" } }, base) === "", "no baja de una IP privada");
  let aviso = "";
  try {
    await resolverGrabacion(play, async () => '<html><form id="password_form"></form></html>');
  } catch (error) {
    aviso = error.motivo;
  }
  assert(aviso === "clave", "la clave corta no se adivina");
  const vistas = [];
  const mp4 = "https://file.zoom.us/juntos.mp4";
  const falsa = async (url, options = {}) => {
    vistas.push({ url, headers: options.headers || {} });
    const comun = { get: (nombre) => "", getSetCookie: () => [] };
    if (url.endsWith("/rec/download/tokenShare1")) {
      return { url, status: 200, headers: { get: (nombre) => (nombre === "content-type" ? "text/html" : ""), getSetCookie: () => [] }, async text() { return "<html></html>"; } };
    }
    if (url === share) {
      return { url, status: 200, headers: { get: (nombre) => (nombre === "content-type" ? "text/html" : ""), getSetCookie: () => ["zpk=uno"] }, async text() { return htmlShare; } };
    }
    if (url.endsWith("/play/share-info/meet-1")) {
      return { url, status: 200, headers: { get: (nombre) => (nombre === "content-type" ? "application/json" : ""), getSetCookie: () => [] }, async json() { return rutas[url]; } };
    }
    if (url.endsWith("/rec/play/tokenPlay")) {
      return { url, status: 200, headers: { get: (nombre) => (nombre === "content-type" ? "text/html" : ""), getSetCookie: () => ["zpk=dos"] }, async text() { return htmlPlay; } };
    }
    if (url.includes("/play/info/")) {
      return { url, status: 200, headers: { get: (nombre) => (nombre === "content-type" ? "application/json" : ""), getSetCookie: () => [] }, async json() { return rutas[`${base}nws/recording/1.0/play/info/file-1?continueMode=true`]; } };
    }
    if (url === mp4) {
      return {
        url,
        status: 206,
        headers: {
          get: (nombre) => (nombre === "content-type" ? "video/mp4" : nombre === "content-range" ? "bytes 0-0/200000" : ""),
          getSetCookie: () => [],
        },
        body: { cancel: async () => {} },
      };
    }
    return { url, status: 404, headers: comun, async text() { return ""; } };
  };
  const bajada = await urlDelVideo(share, falsa);
  const pedidoMp4 = vistas.find((item) => item.url === mp4);
  assert(bajada.bytes === 200000 && bajada.cookie.includes("zpk=dos"), "la bajada conserva la cookie");
  assert(pedidoMp4 && pedidoMp4.headers.Cookie.includes("zpk=dos") && pedidoMp4.headers.Referer.includes("/rec/play/"), "el video pide cookie y la página");
  assert(vistas.some((item) => String(item.url).includes("/share-info/") && item.headers.Cookie.includes("zpk=uno")), "share-info lleva la cookie");
  const plantilla = '<html><script>var t = \'<form id="password_form"></form>\';</script><script>window.__data__ = {"fileId":"file-1"};</script></html>';
  assert(await resolverGrabacion(play, async (url) => (
    url === play ? plantilla : { result: { viewMp4Url: "https://file.zoom.us/camara.mp4" } }
  )) === "https://file.zoom.us/camara.mp4", "un formulario dentro del script no es la clave");
  const cuerpo = JSON.stringify(cuerpoVideo("  Clase  "));
  assert(cuerpo.includes("unlisted") && !cuerpo.includes("clave") && !cuerpo.includes("password"), "el video queda no listado");
  console.log("ok");
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("linkeo-subir.mjs");
if (esMain) selfTest().catch((error) => {
  console.error(error && error.stack ? error.stack : "fallo");
  process.exit(1);
});
