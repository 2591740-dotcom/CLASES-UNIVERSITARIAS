// El día 5, hora de Lima, borra lo subido antes del día 1 de ese mes.
// Si ese pase falla, cualquier día posterior del mismo mes lo retoma.
// Las claves zoom: y yt: se conservan para que LINKEO no vuelva a subir la grabación.
import { fuenteYouTube, fuenteZoom } from "./linkeo-subir.mjs";
import { autorizado, env } from "./linkeo-turno.mjs";

const ARCHIVO = "ajustes/linkeo-mes.json";
const ORDEN = "ajustes/orden.json";
const LOTE = 4;
const OCUPA = 20 * 60;

export function corteMes(epoch) {
  const lima = new Date(Number(epoch) * 1000 - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = lima.getUTCMonth() + 1;
  const d = lima.getUTCDate();
  const inicioMs = Date.UTC(y, m - 1, 1, 5, 0, 0);
  return {
    actuar: d >= 5,
    mes: `${y}-${String(m).padStart(2, "0")}`,
    dia: d,
    inicioMs,
    inicio: new Date(inicioMs).toISOString(),
  };
}

export function instante(valor) {
  const text = String(valor || "").trim();
  if (!text) return 0;
  const conZona = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text);
  const marca = conZona || !/^\d{4}-\d{2}-\d{2}T/.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(marca);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function epochDeId(classId) {
  const match = String(classId || "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{6}$/);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return 0;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const visto = new Date(utc);
  if (visto.getUTCFullYear() !== year || visto.getUTCMonth() !== month - 1 || visto.getUTCDate() !== day) return 0;
  return utc + 5 * 3600 * 1000;
}

export function idValido(value) {
  return /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(String(value || ""));
}

export function cursoValido(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function cabeClave(value) {
  const text = String(value || "").trim();
  if (text.startsWith("zoom:") && text.length >= 14 && text.length <= 300) return text;
  if (/^yt:[A-Za-z0-9_-]{11}$/.test(text)) return text;
  return "";
}

function unir(previa, extra, cabe, tope) {
  const clean = [];
  for (const item of [...(previa || []), ...(extra || [])]) {
    const text = cabe(item);
    if (!text || clean.includes(text)) continue;
    clean.push(text);
  }
  return clean.length > tope ? clean.slice(clean.length - tope) : clean;
}

export function unirClaves(previa, extra) {
  return unir(previa, extra, cabeClave, 4000);
}

function unirIds(previa, extra) {
  return unir(previa, extra, (item) => (idValido(item) ? String(item) : ""), 4000);
}

function unirVideos(previa, extra) {
  return unir(previa, extra, (item) => (/^[A-Za-z0-9_-]{11}$/.test(String(item || "")) ? String(item) : ""), 4000);
}

function unirCursos(previa, extra) {
  return unir(previa, extra, (item) => (cursoValido(item) ? String(item).toLowerCase() : ""), 500);
}

export function estadoMes(data) {
  const base = data && typeof data === "object" ? data : {};
  return {
    mes: String(base.mes || ""),
    hecho: !!base.hecho,
    ocupado: Number(base.ocupado) || 0,
    claves: unirClaves(base.claves, []),
    ids: unirIds(base.ids, []),
    videos: unirVideos(base.videos, []),
    videoDia: String(base.videoDia || ""),
    permiso: !!base.permiso,
    cursos: unirCursos(base.cursos, []),
    borradas: Number(base.borradas) || 0,
    cursosBorrados: Number(base.cursosBorrados) || 0,
  };
}

export function abrirMes(estado, corte) {
  const base = estadoMes(estado);
  if (base.mes === corte.mes) return base;
  return {
    ...base,
    mes: corte.mes,
    hecho: false,
    ocupado: 0,
    cursos: [],
    borradas: 0,
    cursosBorrados: 0,
  };
}

export function vencioClase(row, corte) {
  if (!row || !idValido(row.id)) return false;
  const creada = instante(row.creado);
  const stamp = creada || epochDeId(row.id);
  if (!stamp || !corte) return false;
  return stamp < corte.inicioMs;
}

export function clavesDeClase(row) {
  const keys = [];
  const zoom = fuenteZoom(row && row.video_url);
  const yt = fuenteYouTube(row && row.video_url);
  if (zoom) keys.push(zoom);
  if (yt) keys.push(yt);
  const corto = String(row && row.video_url || "").match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (corto) keys.push(`yt:${corto[1]}`);
  const anidadas = row && Array.isArray(row.fuentes)
    ? row.fuentes
    : (row && row.estudio && Array.isArray(row.estudio.fuentes) ? row.estudio.fuentes : []);
  for (const item of anidadas) keys.push(String(item || ""));
  return unirClaves([], keys);
}

export function idVideo(row) {
  for (const key of clavesDeClase(row)) {
    if (/^yt:[A-Za-z0-9_-]{11}$/.test(key)) return key.slice(3);
  }
  return "";
}

export function cursosHuecos(tocados, filas) {
  const quedan = new Set();
  for (const row of filas || []) {
    const curso = cursoValido(row && row.curso_id);
    if (curso) quedan.add(String(row.curso_id).toLowerCase());
  }
  return unirCursos(tocados, []).filter((curso) => !quedan.has(curso));
}

export function quitarOrden(data, ids, cursos) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const fuera = new Set(unirCursos(cursos, []));
  const quitados = new Set(unirIds(ids, []));
  const salida = {};
  for (const [key, valor] of Object.entries(data)) {
    if (fuera.has(String(key).toLowerCase()) || !Array.isArray(valor)) continue;
    const resto = valor.map((item) => String(item || "")).filter((item) => idValido(item) && !quitados.has(item));
    if (resto.length) salida[key] = resto;
  }
  return salida;
}

function nube() {
  return {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    secret: env("SUPABASE_SERVICE_ROLE"),
  };
}

async function leerJson(path) {
  const { url, secret } = nube();
  if (!url || !secret) throw new Error("nube");
  const response = await fetch(`${url}/storage/v1/object/diapositivas/${path}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  if (response.status === 400 || response.status === 404) return {};
  if (!response.ok) throw new Error("nube");
  const data = await response.json().catch(() => ({}));
  return data && typeof data === "object" ? data : {};
}

async function guardarJson(path, data) {
  const { url, secret } = nube();
  if (!url || !secret) throw new Error("nube");
  const response = await fetch(`${url}/storage/v1/object/diapositivas/${path}`, {
    method: "POST",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error("nube");
}

async function rest(path, options = {}) {
  const { url, secret } = nube();
  if (!url || !secret) throw new Error("nube");
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
  if (response.status === 404 && options.borrar) return null;
  if (!response.ok) throw new Error("nube");
  if (options.borrar) return null;
  return response.json().catch(() => null);
}

async function leerEstado() {
  return estadoMes(await leerJson(ARCHIVO));
}

async function guardarUnido(estado) {
  const fresco = await leerEstado();
  const mismo = fresco.mes === estado.mes;
  const unido = {
    ...estado,
    claves: unirClaves(fresco.claves, estado.claves),
    ids: unirIds(fresco.ids, estado.ids),
    videos: unirVideos(estado.videos, []),
    cursos: mismo ? unirCursos(fresco.cursos, estado.cursos) : unirCursos(estado.cursos, []),
    borradas: mismo ? Math.max(Number(fresco.borradas) || 0, Number(estado.borradas) || 0) : Number(estado.borradas) || 0,
    cursosBorrados: mismo
      ? Math.max(Number(fresco.cursosBorrados) || 0, Number(estado.cursosBorrados) || 0)
      : Number(estado.cursosBorrados) || 0,
  };
  await guardarJson(ARCHIVO, unido);
  return unido;
}

async function listarClases() {
  const rows = await rest("/rest/v1/clases?select=id,video_url,estudio,curso_id,creado&limit=1000");
  return Array.isArray(rows) ? rows : [];
}

async function tokenYouTube() {
  const { url, secret } = nube();
  if (!url || !secret) return "";
  const response = await fetch(`${url}/storage/v1/object/claseclara_privado/youtube.json`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  const cred = await response.json().catch(() => null);
  if (!response.ok || !cred || !cred.client_id || !cred.client_secret || !cred.refresh_token) return "";
  const body = new URLSearchParams({
    client_id: cred.client_id,
    client_secret: cred.client_secret,
    refresh_token: cred.refresh_token,
    grant_type: "refresh_token",
  });
  const token = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await token.json().catch(() => ({}));
  if (!token.ok || !data.access_token) return "";
  return String(data.access_token);
}

async function borrarVideo(access, id) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${access}` },
  });
  if (response.status === 204 || response.status === 404) return "borrado";
  if (response.status === 403) return "permiso";
  return "falla";
}

async function borrarDocumentos(classId) {
  await rest(`/rest/v1/diapositivas?clase_id=eq.${encodeURIComponent(classId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
    borrar: true,
  });
  await rest("/storage/v1/object/diapositivas", {
    method: "DELETE",
    prefer: "return=minimal",
    borrar: true,
    body: { prefixes: [classId] },
  });
  await rest(`/rest/v1/clases?id=eq.${encodeURIComponent(classId)}`, {
    method: "DELETE",
    prefer: "return=minimal",
    borrar: true,
  });
}

async function borrarCurso(curso) {
  await rest(`/rest/v1/cursos?id=eq.${encodeURIComponent(curso)}`, {
    method: "DELETE",
    prefer: "return=minimal",
    borrar: true,
  });
}

async function limpiarOrden(ids, cursos) {
  const orden = await leerJson(ORDEN);
  const limpio = quitarOrden(orden, ids, cursos);
  if (JSON.stringify(limpio) !== JSON.stringify(quitarOrden(orden, [], []))) {
    await guardarJson(ORDEN, limpio);
  }
}

async function aplicarVideos(estado, access) {
  if (!estado.videos.length || !access) return { estado, permiso: !access && estado.videos.length > 0 };
  const quedan = [];
  let permiso = false;
  for (const id of estado.videos) {
    if (permiso) {
      quedan.push(id);
      continue;
    }
    const resultado = await borrarVideo(access, id);
    if (resultado === "borrado") continue;
    quedan.push(id);
    if (resultado === "permiso") permiso = true;
  }
  return {
    estado: { ...estado, videos: quedan, permiso: permiso || (quedan.length > 0 && estado.permiso) },
    permiso,
  };
}

async function cerrarVideos(estado, corte) {
  const dia = `${corte.mes}-${String(corte.dia).padStart(2, "0")}`;
  if (!estado.videos.length) return "hecho";
  const access = await tokenYouTube();
  const paso = await aplicarVideos(estado, access);
  const siguiente = await guardarUnido({
    ...paso.estado,
    videoDia: dia,
    permiso: paso.permiso || paso.estado.permiso,
    ocupado: 0,
  });
  console.log(`mes videos=${siguiente.videos.length} permiso=${siguiente.permiso ? 1 : 0}`);
  return siguiente.videos.length ? "permiso" : "hecho";
}

async function borrarUna(estado, row, access, permiso) {
  const claves = clavesDeClase(row);
  const video = idVideo(row);
  let siguiente = await guardarUnido({
    ...estado,
    claves: unirClaves(estado.claves, claves),
    ids: unirIds(estado.ids, [row.id]),
    cursos: unirCursos(estado.cursos, [row.curso_id]),
    videos: unirVideos(estado.videos, video ? [video] : []),
  });
  let siguePermiso = permiso;
  if (video && access && !siguePermiso) {
    const resultado = await borrarVideo(access, video);
    if (resultado === "borrado") {
      siguiente = { ...siguiente, videos: siguiente.videos.filter((item) => item !== video) };
    } else if (resultado === "permiso") {
      siguePermiso = true;
      siguiente = { ...siguiente, permiso: true };
    }
  }
  await borrarDocumentos(row.id);
  siguiente = await guardarUnido({
    ...siguiente,
    borradas: Number(siguiente.borradas || 0) + 1,
    permiso: siguePermiso || siguiente.permiso,
  });
  return { estado: siguiente, permiso: siguePermiso };
}

async function cerrarMes(estado, filas, corte) {
  const huecos = cursosHuecos(estado.cursos, filas);
  let cursosBorrados = Number(estado.cursosBorrados) || 0;
  for (const curso of huecos) {
    await borrarCurso(curso);
    cursosBorrados += 1;
  }
  await limpiarOrden(estado.ids, huecos);
  const dia = `${corte.mes}-${String(corte.dia).padStart(2, "0")}`;
  const access = estado.videos.length ? await tokenYouTube() : "";
  const paso = access ? await aplicarVideos(estado, access) : { estado, permiso: false };
  const final = await guardarUnido({
    ...paso.estado,
    hecho: true,
    ocupado: 0,
    cursosBorrados,
    videoDia: estado.videos.length ? dia : paso.estado.videoDia,
    permiso: paso.permiso || paso.estado.permiso,
  });
  console.log(`mes borradas=${final.borradas} cursos=${final.cursosBorrados} videos=${final.videos.length}`);
  return Response.json({
    donde: "mes",
    motivo: final.videos.length ? "permiso" : "hecho",
    borradas: final.borradas,
    cursos: final.cursosBorrados,
  });
}

export default async (req) => {
  const secret = env("SUPABASE_SERVICE_ROLE");
  if (!autorizado(req.headers.get("x-linkeo-turno"), secret)) {
    return new Response(null, { status: 401 });
  }
  const ahora = Math.floor(Date.now() / 1000);
  const corte = corteMes(ahora);
  if (!corte.actuar) return Response.json({ donde: "mes", motivo: "espera" });
  let estado = abrirMes(await leerEstado(), corte);
  const sigue = req.headers.get("x-linkeo-sigue") === "1";
  if (!sigue && estado.ocupado && ahora - Number(estado.ocupado) < OCUPA) {
    return Response.json({ donde: "mes", motivo: "ocupa" });
  }
  if (estado.hecho) {
    const motivo = await cerrarVideos(estado, corte);
    return Response.json({ donde: "mes", motivo });
  }
  const paso = Number(req.headers.get("x-linkeo-paso") || 0);
  if (paso > 40) {
    await guardarUnido({ ...estado, ocupado: 0 });
    return Response.json({ donde: "mes", motivo: "tope" });
  }
  try {
    estado = await guardarUnido({ ...estado, ocupado: ahora, hecho: false });
    const filas = await listarClases();
    const vencidas = filas.filter((row) => vencioClase(row, corte));
    if (!vencidas.length) return await cerrarMes(estado, filas, corte);
    const access = await tokenYouTube();
    let permiso = false;
    for (const row of vencidas.slice(0, LOTE)) {
      const resultado = await borrarUna(estado, row, access, permiso);
      estado = resultado.estado;
      permiso = resultado.permiso;
    }
  } catch {
    try {
      const fresco = await leerEstado();
      await guardarUnido({ ...fresco, ocupado: 0 });
    } catch {
      /* el siguiente pase del reloj retoma */
    }
    return Response.json({ donde: "mes", motivo: "falla" });
  }
  const sitio = env("URL").replace(/\/$/, "");
  if (sitio && secret) {
    await fetch(`${sitio}/linkeo-mes`, {
      method: "POST",
      headers: {
        "x-linkeo-turno": secret,
        "x-linkeo-sigue": "1",
        "x-linkeo-paso": String(paso + 1),
      },
    }).catch(() => {});
  }
  console.log(`mes borradas=${estado.borradas} cursos=${estado.cursosBorrados} videos=${estado.videos.length}`);
  return Response.json({ donde: "mes", borradas: estado.borradas });
};

export const config = {
  path: "/linkeo-mes",
  background: true,
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function selfTest() {
  const nov4 = Date.parse("2026-11-05T04:59:00Z") / 1000;
  const nov5 = Date.parse("2026-11-05T05:00:00Z") / 1000;
  const dic5 = Date.parse("2026-12-05T05:00:00Z") / 1000;
  const ene5 = Date.parse("2027-01-05T05:00:00Z") / 1000;
  assert(!corteMes(nov4).actuar, "el día 4 no borra");
  const corte = corteMes(nov5);
  assert(corte.actuar && corte.mes === "2026-11", "el 5 de noviembre borra");
  assert(corte.inicio === "2026-11-01T05:00:00.000Z", "el corte es la medianoche de Lima del día 1");
  const octubre = { id: "20261031-230000-abcdef", creado: "2026-11-01T04:00:00+00:00", curso_id: "7e0217b2-ae79-48e2-b2f1-a507c273aa91" };
  const noviembre = { id: "20261101-235757-67e37c", creado: "2026-11-02T04:59:41+00:00", curso_id: "7e0217b2-ae79-48e2-b2f1-a507c273aa91" };
  assert(vencioClase(octubre, corte), "lo subido en octubre se borra el 5 de noviembre");
  assert(!vencioClase(noviembre, corte), "lo subido en noviembre sigue hasta diciembre");
  assert(!vencioClase({ id: "20261101-000000-abcdef", creado: "" }, corte), "la clase creada a medianoche del día 1 se queda");
  assert(vencioClase({ id: "20261031-235959-abcdef", creado: "" }, corte), "sin fecha de subida vale la hora del identificador");
  const diciembre = corteMes(dic5);
  assert(diciembre.mes === "2026-12" && diciembre.inicio === "2026-12-01T05:00:00.000Z", "diciembre corta en su día 1");
  assert(vencioClase({ id: "20261130-235959-abcdef", creado: "2026-12-01T04:59:59+00:00" }, diciembre), "el último minuto de noviembre sale el 5 de diciembre");
  assert(!vencioClase({ id: "20261201-000000-abcdef", creado: "2026-12-01T05:00:00+00:00" }, diciembre), "diciembre se queda");
  assert(corteMes(ene5).mes === "2027-01", "enero corta el mes anterior");
  const curso = "7e0217b2-ae79-48e2-b2f1-a507c273aa91";
  const vacio = "2fd013dc-1362-4115-a326-d5c0135452a9";
  assert(cursosHuecos([curso, vacio], [noviembre]).join() === vacio, "el curso con clases de este mes se queda");
  assert(cursosHuecos([vacio], []).join() === vacio, "el curso vacío por este borrado se elimina");
  assert(cursosHuecos([], [{ curso_id: vacio }]).length === 0, "un curso que este pase no tocó se queda");
  const orden = quitarOrden({
    [curso]: ["20261031-230000-abcdef", "20261101-235757-67e37c"],
    [vacio]: ["20261015-120000-abcdef"],
  }, ["20261031-230000-abcdef", "20261015-120000-abcdef"], [vacio]);
  assert(!orden[vacio] && orden[curso].length === 1 && orden[curso][0].startsWith("202611"), "el orden solo pierde lo borrado");
  const claves = clavesDeClase({
    video_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    estudio: { fuentes: ["zoom:ucv-edu-pe.zoom.us/tokenPlay12", "yt:dQw4w9WgXcQ", "archivo:1:no"] },
  });
  assert(claves.includes("zoom:ucv-edu-pe.zoom.us/tokenPlay12") && claves.includes("yt:dQw4w9WgXcQ"), "se guardan las dos claves");
  assert(!claves.some((item) => item.startsWith("archivo:")), "la clave local no viaja");
  assert(idVideo({ video_url: "https://youtu.be/dQw4w9WgXcQ" }) === "dQw4w9WgXcQ", "el video corto también se reconoce");
  const seguido = abrirMes({ mes: "2026-10", hecho: true, claves: ["yt:dQw4w9WgXcQ"] }, corte);
  assert(!seguido.hecho && seguido.claves[0] === "yt:dQw4w9WgXcQ" && seguido.mes === "2026-11", "el mes nuevo conserva las claves y vuelve a correr");
  assert(abrirMes(seguido, corte).claves.length === 1, "el mismo mes no olvida el avance");
  const cuerpo = JSON.stringify(seguido);
  assert(!cuerpo.includes("password") && !cuerpo.includes("refresh"), "el estado del mes no guarda secretos");
  console.log("ok");
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("linkeo-mes.mjs");
if (esMain) selfTest();
