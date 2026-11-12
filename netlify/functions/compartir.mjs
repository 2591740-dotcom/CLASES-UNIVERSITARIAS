// Una clase compartida, sin lista de cursos ni otras clases.
// No escribe claves, enlaces de Zoom ni la cuenta.
import { env } from "./linkeo-turno.mjs";

const ID_CLASE = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

function nube() {
  return {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    secret: env("SUPABASE_SERVICE_ROLE"),
  };
}

export function youtubePublico(url) {
  const text = String(url || "");
  const watch = text.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (watch) return `https://www.youtube.com/watch?v=${watch[1]}`;
  const short = text.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (short) return `https://www.youtube.com/watch?v=${short[1]}`;
  return "";
}

function esZoomRec(url) {
  return /zoom\.us\/rec\//i.test(String(url || ""));
}

function listaSinZoom(items) {
  return (Array.isArray(items) ? items : []).filter((item) => !esZoomRec(item && item.url));
}

export function estudioPublico(estudio) {
  const base = estudio && typeof estudio === "object" ? { ...estudio } : {};
  delete base.fuentes;
  if (Array.isArray(base.links)) base.links = listaSinZoom(base.links);
  if (Array.isArray(base.presentaciones)) base.presentaciones = listaSinZoom(base.presentaciones);
  if (Array.isArray(base.lecturas)) base.lecturas = listaSinZoom(base.lecturas);
  return base;
}

export function tituloPublico(row, estudio) {
  const custom = estudio.titulo_custom === true;
  const propio = String(estudio.titulo || "");
  const fila = String(row.titulo || "");
  return (custom ? (propio || fila) : (fila || propio) || "Clase").slice(0, 140);
}

function lineasPublicas(row) {
  const transcript = row.transcripcion && typeof row.transcripcion === "object" ? row.transcripcion : {};
  const lines = Array.isArray(transcript.lines) ? transcript.lines : [];
  return lines.slice(0, 4000).map((line) => ({
    time: Number(line && line.time) || 0,
    stamp: String(line && line.stamp || "").slice(0, 16),
    speaker: String(line && line.speaker || "Voz").slice(0, 40),
    text: String(line && line.text || "").slice(0, 2000),
  })).filter((line) => line.text);
}

async function leerJson(url, secret, path) {
  const response = await fetch(url + path, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}`, Accept: "application/json" },
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function firmar(url, secret, path) {
  const safe = String(path || "").split("/").map(encodeURIComponent).join("/");
  if (!safe) return "";
  const response = await fetch(`${url}/storage/v1/object/sign/diapositivas/${safe}`, {
    method: "POST",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 6 * 3600 }),
  });
  if (!response.ok) return "";
  const data = await response.json().catch(() => ({}));
  const signed = data.signedURL || data.signedUrl || "";
  if (!signed) return "";
  return signed.startsWith("http") ? signed : `${url}/storage/v1${signed}`;
}

export default async (req) => {
  const pedido = new URL(req.url);
  const id = String(pedido.searchParams.get("id") || "");
  if (!ID_CLASE.test(id)) {
    return Response.json({ error: "No encuentro esa clase." }, { status: 404 });
  }
  const { url, secret } = nube();
  if (!url || !secret) {
    return Response.json({ error: "No pude abrir la clase." }, { status: 500 });
  }
  const rows = await leerJson(url, secret, `/rest/v1/clases?id=eq.${id}&select=id,titulo,materia,curso_id,video_url,duracion,estado,detalle,estudio,transcripcion`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return Response.json({ error: "No encuentro esa clase." }, { status: 404 });
  const estudio = estudioPublico(row.estudio);
  const cursoId = String(row.curso_id || "");
  let curso = "";
  if (/^[0-9a-f-]{36}$/i.test(cursoId)) {
    const cursos = await leerJson(url, secret, `/rest/v1/cursos?id=eq.${cursoId}&select=nombre`);
    curso = cursos && cursos[0] ? String(cursos[0].nombre || "").slice(0, 180) : "";
  }
  const diapositivas = await leerJson(url, secret, `/rest/v1/diapositivas?clase_id=eq.${id}&select=orden,tiempo,imagen_path&order=orden.asc`);
  const frames = [];
  for (const slide of Array.isArray(diapositivas) ? diapositivas : []) {
    const file = await firmar(url, secret, slide && slide.imagen_path);
    if (!file) continue;
    frames.push({ file, time: Number(slide.tiempo) || 0 });
  }
  const watch = youtubePublico(row.video_url);
  const estado = String(row.estado || "");
  return Response.json({
    id: row.id,
    title: tituloPublico(row, estudio),
    title_custom: estudio.titulo_custom === true,
    materia: String(row.materia || "").slice(0, 120),
    curso,
    curso_id: cursoId,
    profesor: String(estudio.profesor || "").slice(0, 160),
    duration: Number(row.duracion) || 0,
    status: estado === "error" ? "error" : (estado === "pendiente" || estado === "procesando" ? "processing" : "ready"),
    detail: String(row.detalle || "").slice(0, 240),
    study: estudio,
    lines: lineasPublicas(row),
    chat: [],
    frames,
    media_kind: watch ? "youtube" : "",
    media_src: watch,
    notice: "",
    invitado: true,
  });
};

export const config = { path: "/compartir" };

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function selfTest() {
  assert(youtubePublico("https://www.youtube.com/watch?v=i-67r4TA9pE") === "https://www.youtube.com/watch?v=i-67r4TA9pE", "watch");
  assert(youtubePublico("https://youtu.be/i-67r4TA9pE") === "https://www.youtube.com/watch?v=i-67r4TA9pE", "corto");
  assert(youtubePublico("https://zoom.us/rec/share/abc") === "", "zoom no es video publico");
  const estudio = estudioPublico({
    titulo: "Tema",
    titulo_custom: true,
    fuentes: ["zoom:secreto"],
    links: [{ url: "https://zoom.us/rec/share/abc", titulo: "Grabación" }, { url: "https://ejemplo.edu/guia", titulo: "Guía" }],
    explicacion: [{ titulo: "Parte", texto: "Idea" }],
  });
  assert(!estudio.fuentes && estudio.links.length === 1 && estudio.links[0].url.startsWith("https://ejemplo.edu"), "quita zoom");
  assert(tituloPublico({ titulo: "Fila" }, { titulo: "Tema", titulo_custom: true }) === "Tema", "titulo propio");
  const cuerpo = JSON.stringify(estudio);
  assert(!cuerpo.includes("secreto") && !cuerpo.includes("zoom.us/rec"), "la vista no lleva la grabación");
  console.log("ok");
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compartir.mjs");
if (esMain) selfTest();
