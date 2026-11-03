/** Lee Mis cursos de Clementina (Moodle en uvcv.edu.pe) y no guarda la contraseña. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITIO = "https://uvcv.edu.pe";
const ZONA = "America/Lima";
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  setiembre: 9, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const GENERICOS = /^(foro|tarea|archivo|url|etiqueta|p[aá]gina|page|carpeta|cuestionario|consulta|recurso|videoconferencia|zoom|folder|assign|forum|resource|label)$/i;

export class Fallo extends Error {
  constructor(message, status = 502) {
    super(message);
    this.publico = true;
    this.status = status;
  }
}

export function textoPlano(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d{1,6});/g, (_, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function mensajeAcceso(data) {
  const code = String((data && (data.errorcode || data.error)) || "");
  if (code === "invalidlogin") return "Clementina no aceptó ese usuario o esa contraseña.";
  if (/service|webservice|wsaccess|accessexception/i.test(code)) {
    return "Clementina no dejó leer los cursos desde aquí.";
  }
  const msg = textoPlano(data && (data.message || data.error)).slice(0, 180);
  if (msg && !/password|contrase|token|stack/i.test(msg)) return msg;
  return "No pude entrar a Clementina.";
}

function aplanar(prefijo, value, params) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => aplanar(`${prefijo}[${index}]`, item, params));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) aplanar(`${prefijo}[${key}]`, item, params);
    return;
  }
  if (value !== undefined && value !== null) params.set(prefijo, String(value));
}

function pistaDe(texto, status) {
  const crudo = String(texto || "").replace(/^\uFEFF/, "").trim();
  if (!crudo) return `respuesta vacía (${status || 0})`;
  const titulo = crudo.match(/<title[^>]*>([^<]{1,80})/i);
  const aviso = titulo ? textoPlano(titulo[1]).slice(0, 80) : "";
  if (aviso && !/password|contrase|token|stack/i.test(aviso)) return `${status || 0}, ${aviso}`;
  if (crudo.startsWith("<")) return `${status || 0}, html`;
  return `${status || 0}, no es json`;
}

async function pedirJson(url, options, pedir) {
  const headers = {
    Accept: "application/json",
    "User-Agent": _UA_MOVIL,
    ...(options && options.headers || {}),
  };
  let response;
  try {
    response = await pedir(url, {
      ...options,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Fallo("Clementina no respondió.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Fallo("Clementina desvió la entrada.");
  }
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(String(text || "").replace(/^\uFEFF/, "").trim());
  } catch {
    throw new Fallo(`Clementina contestó algo que no pude leer (${pistaDe(text, response.status)}).`);
  }
  if (!response.ok) throw new Fallo(mensajeAcceso(data));
  if (data && (data.exception || data.errorcode && data.error)) {
    throw new Fallo(mensajeAcceso(data));
  }
  return data;
}

async function tokenDe(usuario, clave, pedir) {
  const body = new URLSearchParams({
    username: usuario,
    password: clave,
    service: "moodle_mobile_app",
  });
  const data = await pedirJson(`${SITIO}/login/token.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }, pedir);
  const token = String(data.token || "");
  if (!/^[a-f0-9]{16,128}$/i.test(token)) throw new Fallo(mensajeAcceso(data));
  const privatetoken = String(data.privatetoken || "");
  return { token, privatetoken: /^[a-zA-Z0-9]{16,128}$/.test(privatetoken) ? privatetoken : "" };
}

async function ws(token, funcion, campos, pedir, headers) {
  const params = new URLSearchParams({
    wstoken: token,
    wsfunction: funcion,
    moodlewsrestformat: "json",
  });
  for (const [key, value] of Object.entries(campos || {})) aplanar(key, value, params);
  const options = { method: "GET" };
  if (headers) options.headers = headers;
  return pedirJson(`${SITIO}/webservice/rest/server.php?${params}`, options, pedir);
}

async function mapa(items, limite, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

function fechaValida(anio, mes, dia) {
  const y = Number(anio);
  const m = Number(mes);
  const d = Number(dia);
  const year = y < 100 ? 2000 + y : y;
  if (m < 1 || m > 12 || d < 1 || d > 31 || year < 2000 || year > 2100) return "";
  const date = new Date(Date.UTC(year, m - 1, d));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return "";
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function fechaBonita(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

function anioEnLima() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric" }).format(new Date());
  return Number(parts) || 2026;
}

function fechaDeTexto(texto) {
  const escrita = texto.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de\s+(\d{4}))?/i);
  if (escrita && MES[escrita[2].toLowerCase()]) {
    const iso = fechaValida(escrita[3] || anioEnLima(), MES[escrita[2].toLowerCase()], escrita[1]);
    if (iso) return iso;
  }
  const numero = texto.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (numero) return fechaValida(numero[3], numero[2], numero[1]);
  return "";
}

function a24(hora, minuto, marca) {
  let h = Number(hora);
  const min = Number(minuto);
  const signo = String(marca || "").toLowerCase();
  if (signo.startsWith("p") && h < 12) h += 12;
  if (signo.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function horaDeTexto(texto) {
  const horas = [];
  const re = /(\d{1,2})[:h.](\d{2})(?:\s*([ap])\.?\s*m\.?)?/gi;
  let found = re.exec(texto);
  while (found && horas.length < 2) {
    const hora = a24(found[1], found[2], found[3]);
    if (hora) horas.push(hora);
    found = re.exec(texto);
  }
  if (!horas.length) return "";
  if (horas.length === 1) return horas[0];
  return `${horas[0]}–${horas[1]}`;
}

const DIA = "lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo";
const MESRE = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre";

function armarHora(hora, minuto, marca, horaFin, minutoFin, marcaFin) {
  const desde = a24(hora, minuto, marca);
  if (!desde) return "";
  const hasta = horaFin ? a24(horaFin, minutoFin, marcaFin) : "";
  if (!hasta || hasta === desde) return desde;
  return `${desde}–${hasta}`;
}

function citaDeTexto(texto) {
  const plano = textoPlano(texto);
  if (!plano) return null;
  const hallados = [];
  const escritaRe = new RegExp(
    `(hora\\s+de\\s+(?:empezar|inicio)|start\\s+time|empiez[ao])?\\s*[:\\-–]?\\s*(?:(?:${DIA})\\s*,\\s*)?(\\d{1,2})\\s+de\\s+(${MESRE})\\s+de(?:l)?\\s+(\\d{4})(?:\\s*,)?(?:\\s*(?:a\\s+las)?\\s*(\\d{1,2})[:h.](\\d{2})(?:\\s*([ap])\\.?\\s*m\\.?)?(?:\\s*(?:a|hasta|–|—|-)\\s*(\\d{1,2})[:h.](\\d{2})(?:\\s*([ap])\\.?\\s*m\\.?)?)?)?`,
    "gi",
  );
  let escrita = escritaRe.exec(plano);
  while (escrita) {
    const iso = fechaValida(escrita[4], MES[escrita[3].toLowerCase()], escrita[2]);
    if (iso) {
      const hora = escrita[5] ? armarHora(escrita[5], escrita[6], escrita[7], escrita[8], escrita[9], escrita[10]) : "";
      const explicita = Boolean(escrita[1]) || new RegExp(`(?:${DIA})\\s*,\\s*${escrita[2]}\\s+de`, "i").test(escrita[0]);
      hallados.push({ iso, hora, explicita, index: escrita.index });
    }
    if (!escrita[0]) escritaRe.lastIndex += 1;
    escrita = escritaRe.exec(plano);
  }
  const numeroRe = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(?:a|hasta|–|—|-)\s*(\d{1,2}):(\d{2}))?)?/g;
  let numero = numeroRe.exec(plano);
  while (numero) {
    const iso = fechaValida(numero[3], numero[2], numero[1]);
    if (iso) {
      const hora = numero[4] ? armarHora(numero[4], numero[5], "", numero[6], numero[7], "") : "";
      hallados.push({ iso, hora, explicita: false, index: numero.index });
    }
    if (!numero[0]) numeroRe.lastIndex += 1;
    numero = numeroRe.exec(plano);
  }
  if (!hallados.length) return null;
  hallados.sort((a, b) => (
    Number(b.explicita) - Number(a.explicita)
    || Number(Boolean(b.hora)) - Number(Boolean(a.hora))
    || a.index - b.index
  ));
  return { iso: hallados[0].iso, hora: hallados[0].hora, explicita: hallados[0].explicita };
}

function horaDeUnix(segundos) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONA,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(segundos * 1000));
}

function fechaDeUnix(segundos) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONA,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(segundos * 1000));
  return fechaValida(...partes.split("-"));
}

function horaDeEvento(evento) {
  const inicio = Number(evento && evento.timestart) || 0;
  if (!inicio) return "";
  const desde = horaDeUnix(inicio);
  const dura = Number(evento.timeduration) || 0;
  if (dura < 60) return desde;
  return `${desde}–${horaDeUnix(inicio + dura)}`;
}

function hostDe(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const EXT_PPT = /\.(?:ppt|pptx|pps|ppsx|pot|potx|pptm|ppsm|odp)(?:$|[?#])/i;
const MIME_PPT = /presentationml|ms-powerpoint|opendocument\.presentation/i;

function esZoomUrl(url) {
  const host = hostDe(url);
  return host === "zoom.us" || host.endsWith(".zoom.us");
}

function decodificar(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function urlArchivo(crudo) {
  const texto = String(crudo || "").replace(/[),.;]+$/, "");
  if (!texto.startsWith("https://") || texto.length > 800) return "";
  let parsed;
  try {
    parsed = new URL(texto);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase();
  if (host === "uvcv.edu.pe" || host.endsWith(".uvcv.edu.pe")) {
    parsed.pathname = parsed.pathname.replace("/webservice/pluginfile.php/", "/pluginfile.php/");
    if (parsed.pathname.includes("/pluginfile.php/")) parsed.search = "";
  }
  const url = parsed.toString();
  return url.length <= 800 ? url : "";
}

function esPresentacion(nombre, url, mimetype) {
  if (!url || esZoomUrl(url)) return false;
  const archivo = decodificar(String(url).split("?")[0]);
  if (EXT_PPT.test(archivo) || EXT_PPT.test(String(nombre || ""))) return true;
  if (MIME_PPT.test(String(mimetype || ""))) return true;
  return /\b(?:pptx?|ppsx?|diapositivas?|presentaci[oó]n(?:es)?)\b/i.test(textoPlano(nombre));
}

function presentacionesDe(mod) {
  const lista = [];
  const vistos = new Set();
  const agregar = (url, nombre) => {
    if (!url || vistos.has(url)) return;
    vistos.add(url);
    lista.push({ nombre: textoPlano(nombre).slice(0, 160) || "Presentación", url });
  };
  for (const item of (mod && mod.contents) || []) {
    const nombre = item.filename || (mod && mod.name);
    const url = urlArchivo(item.fileurl) || urlArchivo(mod && mod.url);
    const mime = item.mimetype || "";
    if (!url || (!esPresentacion(nombre, url, mime) && !esPresentacion(mod && mod.name, url, mime))) continue;
    agregar(url, nombre || (mod && mod.name));
  }
  if (!lista.length) {
    const url = urlArchivo(mod && mod.url);
    if (url && esPresentacion(mod && mod.name, url, "")) agregar(url, mod && mod.name);
  }
  const plano = textoPlano(mod && mod.description);
  for (const encontrado of plano.match(/https:\/\/[^\s<>"']+/g) || []) {
    const url = urlArchivo(encontrado);
    if (!url || !EXT_PPT.test(decodificar(url.split("?")[0]))) continue;
    agregar(url, (mod && mod.name) || "Presentación");
  }
  return lista.slice(0, 6);
}

function enlacesDe(mod) {
  const vistos = new Set();
  const lista = [];
  const agregar = (crudo, nombre) => {
    const url = String(crudo || "").replace(/[),.;]+$/, "");
    if (!url.startsWith("https://") || url.length > 2000 || vistos.has(url)) return;
    const host = hostDe(url);
    if (!host) return;
    vistos.add(url);
    lista.push({
      nombre: textoPlano(nombre).slice(0, 120) || "Enlace",
      url,
      zoom: host === "zoom.us" || host.endsWith(".zoom.us"),
    });
  };
  agregar(mod && mod.url, mod && mod.name);
  for (const item of (mod && mod.contents) || []) agregar(item.fileurl, item.filename || (mod && mod.name));
  const plano = textoPlano(mod && mod.description);
  for (const encontrado of plano.match(/https:\/\/[^\s<>"']+/g) || []) agregar(encontrado, mod && mod.name);
  const externos = lista.filter((item) => !item.url.includes("://uvcv.edu.pe/") && !hostDe(item.url).endsWith("uvcv.edu.pe"));
  return (externos.length ? externos : lista).slice(0, 6);
}

function numerosDe(texto) {
  const nums = [];
  const fuente = String(texto || "");
  const re = /\d{1,3}/g;
  let encontrado = re.exec(fuente);
  while (encontrado) {
    const n = Number(encontrado[0]);
    const clave = String(n);
    if (n > 0 && n <= 40 && !nums.includes(clave)) nums.push(clave);
    encontrado = re.exec(fuente);
  }
  return nums;
}

function tituloDebil(titulo) {
  const limpio = textoPlano(titulo);
  if (!limpio) return true;
  if (/^(?:y|e|,|\d|\s)+$/i.test(limpio)) return true;
  if (/^(?:sesi[oó]n|session|semana|week|clase)\s+\d{1,3}$/i.test(limpio)) return true;
  return false;
}

function limpiarTitulo(value) {
  return textoPlano(value)
    .replace(/([A-Za-zÁÉÍÓÚáéíóúñÑ])-\s+([a-záéíóúñ])/g, "$1-$2")
    .replace(/^[\s.:\-–—|/]+/, "")
    .replace(/(?:\s*\/\s*)+$/g, "")
    .replace(/[.\s]+$/g, "")
    .trim()
    .slice(0, 180);
}

function cortarEnSiguienteSesion(value) {
  const texto = String(value || "");
  const corte = texto.search(/(?:^|\s|[/|])(?:sesi[oó]n|session|semana|week|clase)\s*(?:n[°ºo.]*)?\s*\d{1,3}\b/i);
  return corte > 0 ? texto.slice(0, corte) : texto;
}

function sesionDe(nombre) {
  const limpio = textoPlano(nombre);
  const marcada = limpio.match(/^(?:sesi[oó]n|session|semana|week|clase)\s*(?:n[°ºo.]*)?\s*(\d{1,3}(?:\s*(?:,|y|e)\s*\d{1,3})*)\b\s*([:.\-–—|])?\s*(.*)$/i);
  if (marcada) {
    const numeros = numerosDe(marcada[1]);
    const titulo = tituloDebil(marcada[3]) ? "" : limpiarTitulo(cortarEnSiguienteSesion(marcada[3]));
    return { numero: numeros[0] || "", titulo };
  }
  const inicial = limpio.match(/^0*(\d{1,3})\b[\s.:\-–—|)]+(.*)$/);
  if (inicial && Number(inicial[1]) > 0 && Number(inicial[1]) <= 40) {
    const titulo = tituloDebil(inicial[2]) ? "" : limpiarTitulo(cortarEnSiguienteSesion(inicial[2]));
    return { numero: String(Number(inicial[1])), titulo };
  }
  return { numero: "", titulo: limpio };
}

function esRango(nombre) {
  return /^(?:sesi[oó]n|session|semana|week|clase)\s+(?:\d{1,3}\s*(?:,|y|e)\s+)+\d{1,3}\.?$/i.test(textoPlano(nombre));
}

function tituloGenerico(titulo) {
  const limpio = textoPlano(titulo);
  if (!limpio || tituloDebil(limpio)) return true;
  const palabras = limpio.split(/\s+/);
  return palabras.length <= 4 && palabras.every((palabra) => /^(?:zoom|clase|clases|grabaci[oó]n|grabaciones|videoconferencia|en|vivo|recurso|archivo|etiqueta|tarea|foro|url|p[aá]gina|enlace|reuni[oó]n|meet|presentaci[oó]n|diapositivas|de|del|la|el|los|las|sesi[oó]n|session|sessions|semana|week|weeks)$/i.test(palabra));
}

function guardarTitulo(mapa, numero, titulo) {
  const limpio = limpiarTitulo(titulo);
  if (!numero || tituloDebil(limpio) || tituloGenerico(limpio)) return;
  const previo = mapa.get(numero) || "";
  if (!previo || tituloGenerico(previo) || limpio.length > previo.length + 15) mapa.set(numero, limpio);
}

function marcasDe(plano) {
  const re = /(?:sesi[oó]n|session|semana|week|clase)\s*(?:n[°ºo.]*)?\s*(\d{1,3}(?:\s*(?:,|y|e)\s*\d{1,3})*)\s*([:.\-–—|])?/gi;
  const marcas = [];
  let marca = re.exec(plano);
  while (marca) {
    const numeros = numerosDe(marca[1]);
    if (numeros.length) {
      marcas.push({
        numeros,
        sep: marca[2] || "",
        desde: marca.index,
        fin: marca.index + marca[0].length,
      });
    }
    if (!marca[0]) re.lastIndex += 1;
    marca = re.exec(plano);
  }
  return marcas;
}

function partirEnGrupo(mapa, titulo, numeros, grupos) {
  if (!String(titulo || "").includes(" / ")) return false;
  const partes = String(titulo).split(/\s+\/\s+/).map((parte) => parte.trim()).filter(Boolean);
  if (partes.length !== 2) return false;
  const leidas = partes.map((parte) => {
    const marcada = parte.match(/^(?:sesi[oó]n|session|semana|week|clase)\s*(?:n[°ºo.]*)?\s*(\d{1,3})\b\s*[:.\-–—|]?\s*(.*)$/i);
    if (marcada) return { numero: String(Number(marcada[1])), titulo: limpiarTitulo(marcada[2]) };
    return { numero: "", titulo: limpiarTitulo(parte) };
  });
  if (leidas.some((item) => tituloDebil(item.titulo) || tituloGenerico(item.titulo) || item.titulo.length < 12)) return false;
  let destinos = leidas.every((item) => item.numero) ? leidas.map((item) => item.numero) : [];
  if (destinos.length !== 2) {
    const grupo = numeros.length >= 2
      ? numeros
      : grupos.find((item) => item.length >= 2 && numeros.some((numero) => item.includes(numero)));
    if (!grupo || grupo.length < 2) return false;
    destinos = grupo.slice(0, 2);
  }
  destinos.forEach((numero, indice) => {
    const texto = leidas[indice].titulo;
    const previo = mapa.get(numero) || "";
    if (texto && (!previo || texto.length > previo.length)) mapa.set(numero, texto);
  });
  return true;
}

function indiceTitulos(textos) {
  const mapa = new Map();
  const grupos = [];
  const bloques = [];
  for (const texto of textos || []) {
    const plano = textoPlano(texto);
    if (!plano) continue;
    const marcas = marcasDe(plano);
    if (marcas.length) bloques.push({ plano, marcas });
  }
  for (const { marcas } of bloques) {
    for (const actual of marcas) {
      if (actual.numeros.length > 1) grupos.push(actual.numeros);
    }
  }
  for (const { plano, marcas } of bloques) {
    marcas.forEach((actual, indice) => {
      const limite = indice + 1 < marcas.length ? marcas[indice + 1].desde : plano.length;
      const titulo = limpiarTitulo(plano.slice(actual.fin, limite));
      if (partirEnGrupo(mapa, titulo, actual.numeros, grupos)) return;
      if (!actual.sep || tituloDebil(titulo) || tituloGenerico(titulo)) return;
      for (const numero of actual.numeros) guardarTitulo(mapa, numero, titulo);
    });
  }
  for (const grupo of grupos) {
    const puestos = [...new Set(grupo.map((numero) => mapa.get(numero)).filter(Boolean))];
    if (puestos.length !== 1 || puestos[0].length < 12) continue;
    for (const numero of grupo) {
      if (!mapa.get(numero)) mapa.set(numero, puestos[0]);
    }
  }
  return mapa;
}

function textosDe(secciones, paginas) {
  const textos = [];
  const meter = (value) => {
    const plano = textoPlano(value);
    if (plano) textos.push(plano.slice(0, 20000));
  };
  for (const seccion of secciones || []) {
    meter(seccion && seccion.name);
    meter(seccion && seccion.summary);
    for (const mod of (seccion && seccion.modules) || []) {
      meter(mod.name);
      meter(mod.description);
      for (const item of mod.contents || []) meter(item && item.content);
    }
  }
  for (const pagina of paginas || []) {
    meter(pagina && pagina.name);
    meter(pagina && pagina.intro);
    meter(pagina && pagina.content);
  }
  return textos;
}

function tituloDeModulos(mods) {
  for (const mod of mods || []) {
    const nombre = textoPlano(mod.name);
    if (!nombre || GENERICOS.test(nombre) || tituloGenerico(nombre)) continue;
    if (/^(sesi[oó]n|session|semana|week|clase)\s+\d+$/i.test(nombre)) continue;
    return nombre.slice(0, 180);
  }
  return "";
}

function eventosDe(seccion, eventos) {
  const instancias = new Set((seccion.modules || []).map((mod) => String(mod.instance || "")));
  return (eventos || [])
    .filter((evento) => instancias.has(String(evento.instance || "")))
    .sort((a, b) => Number(a.timestart || 0) - Number(b.timestart || 0));
}

function objetoDe(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return {};
  try {
    const data = JSON.parse(value);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function relojDeModulo(mod) {
  const custom = objetoDe(mod && mod.customdata);
  const state = objetoDe(mod && mod.zoom_state);
  let inicio = Number(custom.start_time) || 0;
  let dura = Number(custom.duration) || 0;
  if (inicio < 1000000000) {
    for (const date of (mod && mod.dates) || []) {
      const marca = Number(date && date.timestamp) || 0;
      if (marca < 1000000000) continue;
      const id = `${date.dataid || ""} ${date.label || ""}`.toLowerCase();
      const esFin = /cerr|fin|ended|entrega|venc|due|hasta|cierre/.test(id);
      const esInicio = /start|empez|inicio|comienz|open|desde/.test(id);
      if (esFin && !esInicio) continue;
      inicio = marca;
      break;
    }
  }
  if (inicio < 1000000000) {
    inicio = Number(state.start_time) || 0;
    if (dura < 60) dura = Number(state.duration) || 0;
  }
  if (inicio < 1000000000) return null;
  return {
    iso: fechaDeUnix(inicio),
    hora: horaDeEvento({ timestart: inicio, timeduration: dura }),
  };
}

function pesoDeEvento(evento) {
  const tipo = String(evento && evento.modulename || "").toLowerCase();
  if (tipo === "zoom" || tipo.includes("bigbluebutton")) return 70;
  if (tipo === "url") return 40;
  return 20;
}

function elegirMomento(candidatos) {
  const conFecha = candidatos.filter((item) => item.iso).sort((a, b) => b.peso - a.peso);
  const iso = conFecha.length ? conFecha[0].iso : "";
  const conHora = candidatos
    .filter((item) => item.hora && (!item.iso || !iso || item.iso === iso))
    .sort((a, b) => b.peso - a.peso);
  let hora = conHora.length ? conHora[0].hora : "";
  if (hora && !hora.includes("–")) {
    const rango = candidatos.find((item) => item.iso === iso && item.hora.startsWith(`${hora}–`));
    if (rango) hora = rango.hora;
  }
  return { iso, hora };
}

function momentoDe(seccion, mods, eventos) {
  const candidatos = [];
  for (const mod of mods) {
    const reloj = relojDeModulo(mod);
    if (reloj && reloj.iso) candidatos.push({ ...reloj, peso: 80 });
    for (const texto of [mod && mod.name, mod && mod.description, mod && mod.afterlink]) {
      const cita = citaDeTexto(texto);
      if (!cita) continue;
      candidatos.push({ iso: cita.iso, hora: cita.hora, peso: cita.explicita ? 90 : (cita.hora ? 55 : 15) });
    }
  }
  const deSeccion = citaDeTexto(`${seccion.name || ""} ${seccion.summary || ""}`);
  if (deSeccion) {
    candidatos.push({
      iso: deSeccion.iso,
      hora: deSeccion.hora,
      peso: deSeccion.explicita ? 90 : (deSeccion.hora ? 55 : 15),
    });
  }
  for (const evento of eventosDe(seccion, eventos)) {
    const iso = fechaDeUnix(Number(evento.timestart) || 0);
    if (!iso) continue;
    candidatos.push({ iso, hora: horaDeEvento(evento), peso: pesoDeEvento(evento) });
  }
  const corpus = [seccion.name, seccion.summary, ...mods.flatMap((mod) => [mod.name, mod.description])].map(textoPlano).join(" ");
  const suelta = fechaDeTexto(corpus);
  if (suelta) candidatos.push({ iso: suelta, hora: horaDeTexto(corpus), peso: 10 });
  return elegirMomento(candidatos);
}

export function profesorDe(curso, ficha) {
  const contactos = (ficha && ficha.contacts) || (curso && curso.contacts) || [];
  const nombres = [];
  for (const contacto of contactos) {
    const nombre = textoPlano(contacto && contacto.fullname).slice(0, 80);
    if (nombre && !nombres.includes(nombre)) nombres.push(nombre);
    if (nombres.length === 3) break;
  }
  if (nombres.length) return nombres.join(", ");
  const resumen = textoPlano((ficha && ficha.summary) || (curso && curso.summary) || "");
  const escrito = resumen.match(/(?:docente|profesor(?:a)?|tutor(?:a)?)\s*[:\-–]\s*([^,;.]{3,80})/i);
  return escrito ? escrito[1].trim() : "";
}

function numeroAlFinal(texto) {
  const base = String(texto || "").replace(/\.(?:pdf|pptx?|ppsx?|docx?|docm|odt|odp|txt|rtf|xlsx?|csv|png|jpe?g|zip|rar|mp4|mp3)\s*$/i, "").trim();
  const marca = base.match(/(?:^|[\s._\-–—/(°º#])0*(\d{1,2})\s*\)?\s*$/);
  if (!marca) return "";
  const n = Number(marca[1]);
  if (n < 1 || n > 40) return "";
  return String(n);
}

function numeroDeRecurso(texto) {
  const limpio = textoPlano(texto);
  if (!limpio) return "";
  const re = /(?:sesi[oó]n|session|clase)\s*(?:n(?:ro|[°ºo.]*))?\s*[-–—:.]?\s*0*(\d{1,2})\b/gi;
  const nums = [];
  let marca = re.exec(limpio);
  while (marca) {
    const n = Number(marca[1]);
    const clave = String(n);
    if (n >= 1 && n <= 40 && !nums.includes(clave)) nums.push(clave);
    if (!marca[0]) re.lastIndex += 1;
    marca = re.exec(limpio);
  }
  if (nums.length === 1) return nums[0];
  if (nums.length > 1) return "";
  return numeroAlFinal(limpio);
}

function destinoDe(nombre, mod) {
  return numeroDeRecurso(nombre) || numeroDeRecurso(mod && mod.name) || "";
}

function empujar(lista, item, limpio) {
  if (!item || !item.url || lista.some((otro) => otro.url === item.url)) return;
  lista.push(limpio(item));
}

function enlaceLimpio(item) {
  return { nombre: item.nombre, url: item.url, zoom: Boolean(item.zoom) };
}

function pptLimpio(item) {
  return { nombre: item.nombre, url: item.url };
}

function tituloReal(titulo, numero) {
  const limpio = textoPlano(titulo);
  if (!limpio || tituloGenerico(limpio)) return false;
  const n = String(numero || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (n && new RegExp(`^(?:sesi[oó]n|session|semana|week|clase)\\s+0*${n}$`, "i").test(limpio)) return false;
  return true;
}

function absorberFila(base, otra) {
  const a = base._seccion || { name: "", summary: "" };
  const b = otra._seccion || { name: "", summary: "" };
  base._seccion = {
    name: a.name || b.name || "",
    summary: [a.summary, b.summary].filter(Boolean).join("\n"),
    modules: [],
  };
  base._mods.push(...(otra._mods || []));
  for (const item of otra.enlaces || []) empujar(base.enlaces, item, enlaceLimpio);
  for (const item of otra.presentaciones || []) empujar(base.presentaciones, item, pptLimpio);
}

function unirFilas(sesiones) {
  const grupos = new Map();
  const salida = [];
  for (const fila of sesiones) {
    if (!fila.numero) {
      salida.push(fila);
      continue;
    }
    if (!grupos.has(fila.numero)) grupos.set(fila.numero, []);
    grupos.get(fila.numero).push(fila);
  }
  for (const [numero, grupo] of grupos) {
    if (grupo.length === 1) {
      salida.push(grupo[0]);
      continue;
    }
    const ordenadas = [...grupo].sort((a, b) => {
      const ra = tituloReal(a.titulo, numero) ? a.titulo.length : 0;
      const rb = tituloReal(b.titulo, numero) ? b.titulo.length : 0;
      return rb - ra;
    });
    const base = ordenadas[0];
    for (const otra of ordenadas.slice(1)) {
      const ambasReales = tituloReal(base.titulo, numero) && tituloReal(otra.titulo, numero);
      const mismo = textoPlano(base.titulo) === textoPlano(otra.titulo);
      const baseVacio = !base.enlaces.length && !base.presentaciones.length;
      const otraVacio = !otra.enlaces.length && !otra.presentaciones.length;
      if (ambasReales && !mismo && !baseVacio && !otraVacio) {
        salida.push(otra);
        continue;
      }
      absorberFila(base, otra);
    }
    base.enlaces = base.enlaces.slice(0, 6);
    base.presentaciones = base.presentaciones.slice(0, 6);
    salida.push(base);
  }
  return salida;
}

function filaVacia(numero, titulo) {
  return {
    numero,
    titulo: (titulo || `Sesión ${numero}`).slice(0, 180),
    fecha: "",
    fecha_iso: "",
    hora: "",
    orden: "",
    enlaces: [],
    presentaciones: [],
    _seccion: { name: `Sesión ${numero}`, summary: "", modules: [] },
    _mods: [],
  };
}

export function sesionesDe(secciones, eventos, paginas) {
  const indice = indiceTitulos(textosDe(secciones, paginas));
  const sesiones = [];
  const bolsas = new Map();
  const bolsa = (numero) => {
    if (!bolsas.has(numero)) bolsas.set(numero, { enlaces: [], presentaciones: [], mods: [] });
    return bolsas.get(numero);
  };
  for (const seccion of secciones || []) {
    if (!seccion || typeof seccion !== "object") continue;
    const partes = sesionDe(seccion.name);
    const esPortada = Number(seccion.section) === 0 && !partes.numero;
    if (esPortada) continue;
    const mods = Array.isArray(seccion.modules) ? seccion.modules : [];
    const enlacesPrevios = mods.flatMap(enlacesDe);
    if (esRango(seccion.name) && !enlacesPrevios.length) continue;
    const propioBruto = partes.titulo || "";
    const propio = tituloGenerico(propioBruto) || /(?:sesi[oó]n|session|semana|week|clase)\s*(?:n[°ºo.]*)?\s*\d{1,3}\b/i.test(propioBruto)
      ? ""
      : propioBruto;
    const titulo = (propio || indice.get(partes.numero) || tituloDeModulos(mods) || partes.numero && `Sesión ${partes.numero}` || textoPlano(seccion.name)).slice(0, 180);
    if (!titulo && !mods.length) continue;
    const enlaces = [];
    const presentaciones = [];
    const vistasPpt = new Set();
    const propiosMods = [];
    for (const mod of mods) {
      const ppts = [];
      for (const item of presentacionesDe(mod)) {
        if (vistasPpt.has(item.url)) continue;
        vistasPpt.add(item.url);
        ppts.push({ ...item, destino: destinoDe(item.nombre, mod) });
      }
      const links = enlacesDe(mod).filter((item) => (
        !vistasPpt.has(urlArchivo(item.url)) && !esPresentacion(item.nombre, item.url, "")
      )).map((item) => ({ ...item, destino: destinoDe(item.nombre, mod) }));
      const nMod = numeroDeRecurso(mod && mod.name);
      if (nMod && nMod !== partes.numero) bolsa(nMod).mods.push(mod);
      else propiosMods.push(mod);
      for (const item of links) {
        if (item.destino && item.destino !== partes.numero) bolsa(item.destino).enlaces.push(item);
        else empujar(enlaces, item, enlaceLimpio);
      }
      for (const item of ppts) {
        if (item.destino && item.destino !== partes.numero) bolsa(item.destino).presentaciones.push(item);
        else empujar(presentaciones, item, pptLimpio);
      }
    }
    if (!enlaces.length && !presentaciones.length && !propiosMods.length && !partes.numero) continue;
    if (!titulo && !propiosMods.length && !enlaces.length && !presentaciones.length) continue;
    sesiones.push({
      numero: partes.numero,
      titulo: titulo || "Sesión",
      fecha: "",
      fecha_iso: "",
      hora: "",
      orden: "",
      enlaces: enlaces.slice(0, 6),
      presentaciones: presentaciones.slice(0, 6),
      _seccion: seccion,
      _mods: propiosMods,
    });
  }
  for (const [numero, cargado] of bolsas) {
    if (!cargado.enlaces.length && !cargado.presentaciones.length && !cargado.mods.length) continue;
    let fila = sesiones.find((item) => item.numero === numero && !item.enlaces.length && !item.presentaciones.length)
      || sesiones.find((item) => item.numero === numero);
    if (!fila) {
      fila = filaVacia(numero, indice.get(numero) || "");
      sesiones.push(fila);
    }
    fila._mods.push(...cargado.mods);
    for (const item of cargado.enlaces) empujar(fila.enlaces, item, enlaceLimpio);
    for (const item of cargado.presentaciones) empujar(fila.presentaciones, item, pptLimpio);
    fila.enlaces = fila.enlaces.slice(0, 6);
    fila.presentaciones = fila.presentaciones.slice(0, 6);
  }
  const filas = unirFilas(sesiones);
  for (const fila of filas) {
    const base = fila._seccion || { name: "", summary: "" };
    const seccionReloj = { name: base.name || "", summary: base.summary || "", modules: fila._mods };
    const momento = momentoDe(seccionReloj, fila._mods, eventos);
    fila.fecha = momento.iso ? fechaBonita(momento.iso) : "";
    fila.fecha_iso = momento.iso || "";
    fila.hora = momento.hora || "";
    fila.orden = momento.iso ? `${momento.iso}T${(momento.hora || "").slice(0, 5) || "00:00"}` : "";
  }
  filas.sort((a, b) => {
    const na = Number(a.numero) || 999;
    const nb = Number(b.numero) || 999;
    if (na !== nb) return na - nb;
    return a.orden.localeCompare(b.orden);
  });
  return filas.slice(0, 80).map(({ orden, _seccion, _mods, ...sesion }) => sesion);
}

export function armarCurso(curso, ficha, secciones, eventos, aviso, paginas) {
  const nombre = textoPlano((curso && (curso.fullname || curso.displayname || curso.shortname)) || "Curso").slice(0, 180);
  return {
    id: Number(curso && curso.id) || 0,
    nombre,
    profesor: profesorDe(curso, ficha).slice(0, 160),
    aviso: aviso || "",
    sesiones: Array.isArray(secciones) ? sesionesDe(secciones, eventos, paginas) : [],
  };
}

function unirEventos(accion, agenda) {
  const vistos = new Set();
  const salida = [];
  for (const evento of [...(accion || []), ...(agenda || [])]) {
    if (!evento || typeof evento !== "object") continue;
    const clave = `${evento.id || ""}:${evento.modulename || ""}:${evento.instance || ""}:${evento.timestart || ""}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(evento);
  }
  return salida;
}

const _UA_MOVIL = "MoodleMobile";

function recsEnTexto(texto) {
  const plano = String(texto || "").replace(/\\\//g, "/").replace(/&amp;/g, "&");
  const hallados = plano.match(/https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/rec\/(?:play|share|download)\/[^\s"'<>\\]+/gi) || [];
  const salida = [];
  for (const crudo of hallados) {
    const url = crudo.replace(/[),.;]+$/, "");
    if (url.length <= 2000 && !salida.includes(url)) salida.push(url);
  }
  return salida;
}

function cookiesDe(response, previas) {
  const jar = new Map();
  for (const parte of String(previas || "").split(";")) {
    const trozo = parte.trim();
    const eq = trozo.indexOf("=");
    if (eq > 0) jar.set(trozo.slice(0, eq).trim(), trozo.slice(eq + 1).trim());
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

function encabezado(response, nombre) {
  if (!response || !response.headers || typeof response.headers.get !== "function") return "";
  return response.headers.get(nombre) || "";
}

async function seguirEntrada(url, cookie, pedir) {
  let actual = url;
  let galleta = cookie;
  for (let paso = 0; paso < 6; paso += 1) {
    const response = await pedir(actual, {
      redirect: "manual",
      headers: { Cookie: galleta, "User-Agent": _UA_MOVIL },
    });
    galleta = cookiesDe(response, galleta);
    const location = encabezado(response, "location");
    if (response.status >= 300 && response.status < 400 && location) {
      actual = new URL(location, actual).href;
      continue;
    }
    return { response, cookie: galleta, url: actual };
  }
  return { response: null, cookie: galleta, url: actual };
}

async function abrirSesion(token, privatetoken, userid, pedir, cuenta) {
  if (!privatetoken || !userid) {
    if (cuenta) cuenta.motivo = privatetoken ? "sinusuario" : "sintoken";
    return "";
  }
  const consulta = new URLSearchParams({
    wstoken: token,
    wsfunction: "tool_mobile_get_autologin_key",
    moodlewsrestformat: "json",
  });
  let data;
  try {
    data = await pedirJson(`${SITIO}/webservice/rest/server.php?${consulta}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": _UA_MOVIL,
      },
      body: new URLSearchParams({ privatetoken }).toString(),
    }, pedir);
  } catch {
    if (cuenta) cuenta.motivo = "rechazo";
    return "";
  }
  const base = String(data && data.autologinurl || "");
  const key = String(data && data.key || "");
  if (!base.startsWith(`${SITIO}/`) || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) {
    if (cuenta) cuenta.motivo = "sinclave";
    return "";
  }
  const entrada = new URL(base);
  entrada.searchParams.set("userid", String(userid));
  entrada.searchParams.set("key", key);
  const llegada = await seguirEntrada(entrada.href, "", pedir);
  if (!llegada.cookie && cuenta) cuenta.motivo = "sinsesion";
  return llegada.cookie || "";
}

function tokenDeLogin(html) {
  const re = /<input\b[^>]*>/gi;
  let hallado = re.exec(String(html || ""));
  while (hallado) {
    const tag = hallado[0];
    if (/name=["']logintoken["']/i.test(tag)) {
      const valor = tag.match(/value=["']([^"']+)["']/i);
      if (valor && /^[A-Za-z0-9_-]{8,128}$/.test(valor[1])) return valor[1];
    }
    hallado = re.exec(String(html || ""));
  }
  return "";
}

async function entrarConClave(usuario, clave, pedir, cuenta) {
  let pagina;
  try {
    pagina = await pedir(`${SITIO}/login/index.php`, {
      redirect: "manual",
      headers: { "User-Agent": _UA_MOVIL },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    if (cuenta) cuenta.motivo = "sinformulario";
    return "";
  }
  const html = pagina && pagina.status === 200 ? await pagina.text() : "";
  const logintoken = tokenDeLogin(html);
  if (!logintoken) {
    if (cuenta) cuenta.motivo = "sinformulario";
    return "";
  }
  let respuesta;
  try {
    respuesta = await pedir(`${SITIO}/login/index.php`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookiesDe(pagina, ""),
        "User-Agent": _UA_MOVIL,
      },
      body: new URLSearchParams({
        username: usuario,
        password: clave,
        logintoken,
        anchor: "",
      }).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    if (cuenta) cuenta.motivo = "sinentrada";
    return "";
  }
  let cookie = cookiesDe(respuesta, cookiesDe(pagina, ""));
  let actual = `${SITIO}/login/index.php`;
  let status = respuesta.status;
  let location = encabezado(respuesta, "location");
  for (let paso = 0; paso < 6 && status >= 300 && status < 400 && location; paso += 1) {
    let siguiente = "";
    try {
      siguiente = new URL(location, actual).href;
    } catch {
      break;
    }
    if (!siguiente.startsWith(`${SITIO}/`)) {
      if (cuenta) cuenta.motivo = "sinentrada";
      return "";
    }
    let llegada;
    try {
      llegada = await pedir(siguiente, {
        redirect: "manual",
        headers: { Cookie: cookie, "User-Agent": _UA_MOVIL },
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      if (cuenta) cuenta.motivo = "sinentrada";
      return "";
    }
    cookie = cookiesDe(llegada, cookie);
    actual = siguiente;
    status = llegada.status;
    location = encabezado(llegada, "location");
    respuesta = llegada;
  }
  const htmlFinal = status === 200 ? await respuesta.text() : "";
  const sigueEnLogin = /\/login\/index\.php/i.test(actual) && /name=["'](?:password|logintoken)["']/i.test(htmlFinal);
  if (status >= 300 || sigueEnLogin || !cookie) {
    if (cuenta) cuenta.motivo = "sinentrada";
    return "";
  }
  if (cuenta) delete cuenta.motivo;
  return cookie;
}

function idDeConsulta(url) {
  try {
    const valor = new URL(url, SITIO).searchParams.get("id") || "";
    return /^\d{1,12}$/.test(valor) ? valor : "";
  } catch {
    return "";
  }
}

function cargasDeListado(html) {
  const salida = [];
  const re = /<a\b[^>]*href=["']([^"']*\/mod\/zoom\/loadrecording\.php\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let hallado = re.exec(String(html || ""));
  while (hallado) {
    const href = hallado[1].replace(/&amp;/g, "&").replace(/\\\//g, "/");
    let url = "";
    try {
      url = new URL(href, SITIO).href;
    } catch {
      url = "";
    }
    if (url.startsWith(`${SITIO}/mod/zoom/loadrecording.php`) && !salida.some((item) => item.url === url)) {
      salida.push({ url, nombre: textoPlano(hallado[2]) });
    }
    hallado = re.exec(String(html || ""));
  }
  return salida;
}

function esSoloAudio(nombre) {
  return /audio[_\s-]*only|solo audio|audio transcript|transcripci|chat_file|closed_caption|timeline|\bsummary\b/i.test(nombre);
}

function mejorCarga(lista) {
  const videos = (lista || []).filter((item) => item && !esSoloAudio(item.nombre));
  return videos.find((item) => /speaker|orador|hablante|pantalla|shared screen|galer/i.test(item.nombre)) || videos[0] || null;
}

async function paginaDe(url, cookie, pedir) {
  let actual = url;
  let galleta = cookie;
  for (let paso = 0; paso < 6; paso += 1) {
    const response = await pedir(actual, {
      redirect: "manual",
      headers: { Cookie: galleta, "User-Agent": _UA_MOVIL },
    });
    galleta = cookiesDe(response, galleta);
    const location = encabezado(response, "location");
    if (response.status >= 300 && response.status < 400 && location) {
      const siguiente = new URL(location, actual).href;
      const recs = recsEnTexto(siguiente);
      if (recs.length) return { recs, html: "" };
      if (!siguiente.startsWith(`${SITIO}/`)) return { recs: [], html: "" };
      actual = siguiente;
      continue;
    }
    if (response.status !== 200) return { recs: [], html: "" };
    const html = await response.text();
    return { recs: recsEnTexto(html), html };
  }
  return { recs: [], html: "" };
}

function yaTieneGrabacion(mod) {
  return enlacesDe(mod).some((item) => item.zoom && /\/rec\/(?:play|share|download)\//.test(item.url));
}

function planoCurso(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*b\d+\s*$/i, "")
    .trim();
}

function mismoCurso(a, b) {
  const x = planoCurso(a);
  const y = planoCurso(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const corto = x.length <= y.length ? x : y;
  const largo = x.length <= y.length ? y : x;
  return corto.length >= 12 && (largo === corto || largo.startsWith(`${corto} `) || largo.startsWith(corto));
}

function numeroTitulo(titulo) {
  const marcado = String(titulo || "").match(/sesi[oó]n\s*(?:n[°ºo.]*)?\s*0*(\d{1,3})\b/i);
  const n = marcado ? Number(marcado[1]) : 0;
  return n > 0 && n <= 40 ? n : 0;
}

export function corteDe(filas, curso) {
  const propias = (Array.isArray(filas) ? filas : []).filter((fila) => (
    fila && mismoCurso(fila.curso || fila.materia, curso)
  ));
  const numeros = [...new Set(propias.map((fila) => numeroTitulo(fila.titulo)).filter(Boolean))].sort((a, b) => a - b);
  if (numeros.length >= 2) {
    const numero = numeros[numeros.length - 2];
    const fechas = propias
      .filter((fila) => numeroTitulo(fila.titulo) === numero)
      .map((fila) => String(fila.fecha || ""))
      .filter((fecha) => /^\d{4}-\d{2}-\d{2}$/.test(fecha))
      .sort();
    return { numero, fecha: fechas[fechas.length - 1] || "" };
  }
  const fechas = [...new Set(
    propias.map((fila) => String(fila.fecha || "")).filter((fecha) => /^\d{4}-\d{2}-\d{2}$/.test(fecha)),
  )].sort();
  if (fechas.length >= 2) return { numero: 0, fecha: fechas[fechas.length - 2] };
  return null;
}

export function esAntigua(numero, fecha, corte) {
  if (!corte) return false;
  const n = Number(numero) || 0;
  const tope = Number(corte.numero) || 0;
  if (n && tope) return n < tope;
  if (fecha && corte.fecha) return String(fecha) < String(corte.fecha);
  return false;
}

const DIAS_SIN_CLASE = 30;

export function hoyLima(epochMs = Date.now()) {
  const n = Number(epochMs);
  const lima = new Date((Number.isFinite(n) ? n : Date.now()) - 5 * 3600 * 1000);
  const p = (value) => String(value).padStart(2, "0");
  return `${lima.getUTCFullYear()}-${p(lima.getUTCMonth() + 1)}-${p(lima.getUTCDate())}`;
}

export function diasEntre(desde, hasta) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde || "")) || !/^\d{4}-\d{2}-\d{2}$/.test(String(hasta || ""))) return null;
  const [ay, am, ad] = String(desde).split("-").map(Number);
  const [by, bm, bd] = String(hasta).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function cursoQuieto(filas, curso, hoy) {
  const propias = (Array.isArray(filas) ? filas : []).filter((fila) => (
    fila && mismoCurso(fila.curso || fila.materia, curso)
  ));
  const fechas = propias
    .map((fila) => String(fila.fecha || ""))
    .filter((fecha) => /^\d{4}-\d{2}-\d{2}$/.test(fecha))
    .sort();
  if (!fechas.length) return false;
  const dias = diasEntre(fechas[fechas.length - 1], hoy);
  return dias !== null && dias >= DIAS_SIN_CLASE;
}

function fechaDeEpoch(epoch) {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return "";
  const lima = new Date(n * 1000 - 5 * 3600 * 1000);
  const p = (value) => String(value).padStart(2, "0");
  return `${lima.getUTCFullYear()}-${p(lima.getUTCMonth() + 1)}-${p(lima.getUTCDate())}`;
}

function numeroDePieza(seccion, mod) {
  return Number(sesionDe(seccion && seccion.name).numero || sesionDe(mod && mod.name).numero) || 0;
}

function fechaDePieza(mod) {
  return fechaDeEpoch(mod && mod.zoom_state && mod.zoom_state.start_time);
}

function credencialNube() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE || "");
  if (url && key) return { url, key };
  try {
    const ruta = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "supabase.json");
    const data = JSON.parse(readFileSync(ruta, "utf8"));
    const localUrl = String(data.url || "").replace(/\/$/, "");
    const localKey = String(data.service_role || "");
    if (localUrl && localKey) return { url: localUrl, key: localKey };
  } catch {
    /* En la web publicada la clave llega por el entorno. */
  }
  return null;
}

async function cargarHalladas() {
  const cred = credencialNube();
  if (!cred) return [];
  try {
    const response = await fetch(
      `${cred.url}/rest/v1/clases?select=materia,titulo,estudio&limit=1000`,
      { headers: { apikey: cred.key, Authorization: `Bearer ${cred.key}`, Accept: "application/json" } },
    );
    if (!response.ok) return [];
    const rows = await response.json();
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const estudio = row && row.estudio && typeof row.estudio === "object" ? row.estudio : {};
      const deFila = String(row.titulo || "");
      const deEstudio = String(estudio.titulo || "");
      const fecha = String(estudio.fecha_clase || "");
      return {
        curso: String(row.materia || ""),
        titulo: numeroTitulo(deFila) ? deFila : (deEstudio || deFila),
        fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : "",
      };
    });
  } catch {
    return [];
  }
}

async function completarGrabaciones(secciones, cookieDe, pedir, cuenta, corte = null) {
  const faltan = [];
  for (const seccion of secciones || []) {
    for (const mod of (seccion && seccion.modules) || []) {
      if (!mod || !mod.url) continue;
      const tipo = String(mod.modname || "");
      const nombre = String(mod.name || "");
      const esZoom = tipo === "zoom";
      const esGrabacion = tipo === "url" && /grabaci[oó]n/i.test(nombre);
      if ((!esZoom && !esGrabacion) || yaTieneGrabacion(mod)) continue;
      if (esAntigua(numeroDePieza(seccion, mod), fechaDePieza(mod), corte)) {
        if (cuenta) cuenta.saltadas = (cuenta.saltadas || 0) + 1;
        continue;
      }
      faltan.push(mod);
    }
  }
  if (!faltan.length) return;
  const cookie = await cookieDe();
  if (cuenta) cuenta.sesion = cookie ? 1 : 0;
  if (!cookie) return;
  await mapa(faltan, 6, async (mod) => {
    let recs = [];
    let listado = null;
    if (String(mod.modname || "") === "zoom") {
      const id = idDeConsulta(mod.url);
      if (id) {
        listado = await seguro(paginaDe(`${SITIO}/mod/zoom/recordings.php?id=${id}`, cookie, pedir));
        if (cuenta) cuenta.listados += 1;
        if (listado && /login\/index\.php|logintoken|name="password"/i.test(listado.html || "")) {
          if (cuenta) cuenta.muro += 1;
        }
        recs = (listado && listado.recs) || [];
        if (!recs.length && listado && listado.html) {
          const carga = mejorCarga(cargasDeListado(listado.html));
          if (carga) {
            if (cuenta) cuenta.cargas += 1;
            const seguida = await seguro(paginaDe(carga.url, cookie, pedir));
            recs = (seguida && seguida.recs) || [];
          }
        }
      }
    }
    if (!recs.length && !listado) {
      const pagina = await seguro(paginaDe(mod.url, cookie, pedir));
      recs = (pagina && pagina.recs) || [];
    }
    if (cuenta) cuenta.grabaciones += recs.length;
    for (const url of recs) {
      if (!Array.isArray(mod.contents)) mod.contents = [];
      mod.contents.push({ fileurl: url, filename: "Grabación" });
    }
    return null;
  });
}

async function completarZoom(token, secciones, pedir, corte = null) {
  const faltan = [];
  for (const seccion of secciones || []) {
    for (const mod of (seccion && seccion.modules) || []) {
      if (String(mod.modname || "") !== "zoom" || !mod.id || relojDeModulo(mod)) continue;
      if (esAntigua(numeroDePieza(seccion, mod), "", corte)) continue;
      if (!faltan.includes(mod.id)) faltan.push(mod.id);
    }
  }
  if (!faltan.length) return;
  const pares = await mapa(faltan, 4, async (id) => {
    const data = await seguro(ws(token, "mod_zoom_get_state", { zoomid: id }, pedir));
    return [id, data];
  });
  const porId = new Map(pares.filter((par) => par && par[1] && Number(par[1].start_time) > 0));
  for (const seccion of secciones || []) {
    for (const mod of (seccion && seccion.modules) || []) {
      const data = porId.get(mod.id);
      if (data) mod.zoom_state = data;
    }
  }
}

async function seguro(promesa) {
  try {
    return await promesa;
  } catch {
    return null;
  }
}

export async function entrarYLeer(usuario, clave, pedir = fetch, opciones = {}) {
  const acceso = await tokenDe(usuario, clave, pedir);
  const token = acceso.token;
  const privatetoken = acceso.privatetoken;
  const sitio = await ws(token, "core_webservice_get_site_info", {}, pedir);
  const userid = Number(sitio && sitio.userid) || 0;
  if (!userid) throw new Fallo("Clementina no dijo quién entró.");
  const halladas = Array.isArray(opciones && opciones.halladas)
    ? opciones.halladas
    : (opciones && opciones.cortar ? await cargarHalladas() : []);
  const cuenta = { sesion: 0, listados: 0, cargas: 0, grabaciones: 0, muro: 0, saltadas: 0, omitidas: 0, recorte: 0, quietos: 0 };
  const hoy = (opciones && opciones.hoy) || hoyLima();
  const puedeCallar = !!(opciones && (opciones.cortar || Array.isArray(opciones.halladas) && opciones.hoy));
  let pendiente = null;
  const cookieDe = () => {
    if (!pendiente) {
      pendiente = abrirSesion(token, privatetoken, userid, pedir, cuenta).then((cookie) => {
        if (cookie) return cookie;
        const motivo = cuenta.motivo || "";
        if (motivo !== "rechazo" && motivo !== "sinclave" && motivo !== "sinsesion") return "";
        return entrarConClave(usuario, clave, pedir, cuenta);
      });
    }
    return pendiente;
  };
  const lista = await ws(token, "core_enrol_get_users_courses", { userid }, pedir);
  if (!Array.isArray(lista)) throw new Fallo("Clementina no entregó los cursos.");
  const cursos = lista
    .filter((curso) => curso && curso.id)
    .sort((a, b) => Number(b.startdate || 0) - Number(a.startdate || 0))
    .slice(0, 40);
  const armados = await mapa(cursos, 4, async (curso) => {
    const nombreCurso = (curso && (curso.fullname || curso.displayname)) || "";
    if (puedeCallar && cursoQuieto(halladas, nombreCurso, hoy)) {
      cuenta.quietos += 1;
      return {
        id: Number(curso.id) || 0,
        nombre: textoPlano(nombreCurso).slice(0, 180) || "Curso",
        profesor: "",
        aviso: "La última clase guardada tiene 30 días o más. Este curso no se escaneó.",
        sesiones: [],
      };
    }
    const ahora = Math.floor(Date.now() / 1000);
    const desde = Number(curso.startdate) > 0 ? Number(curso.startdate) - 7 * 86400 : ahora - 400 * 86400;
    const [detalle, secciones, calendario, agenda, paginas] = await Promise.all([
      seguro(ws(token, "core_course_get_courses_by_field", { field: "id", value: curso.id }, pedir)),
      seguro(ws(token, "core_course_get_contents", { courseid: curso.id }, pedir)),
      seguro(ws(token, "core_calendar_get_action_events_by_courses", {
        courseids: [curso.id],
        timesortfrom: desde,
        limitnum: 200,
      }, pedir)),
      seguro(ws(token, "core_calendar_get_calendar_events", {
        events: { courseids: [curso.id] },
        options: { userevents: 0, siteevents: 0, timestart: desde, timeend: ahora + 400 * 86400 },
      }, pedir)),
      seguro(ws(token, "mod_page_get_pages_by_courses", { courseids: [curso.id] }, pedir)),
    ]);
    const ficha = detalle && Array.isArray(detalle.courses) ? detalle.courses[0] : null;
    const eventos = unirEventos(
      calendario && calendario.events,
      agenda && agenda.events,
    );
    const corte = corteDe(halladas, (curso && (curso.fullname || curso.displayname)) || "");
    if (corte) cuenta.recorte = 1;
    if (Array.isArray(secciones)) {
      await completarZoom(token, secciones, pedir, corte);
      await completarGrabaciones(secciones, cookieDe, pedir, cuenta, corte);
    }
    const aviso = Array.isArray(secciones) ? "" : "No pude abrir las sesiones de este curso.";
    const listaPaginas = paginas && Array.isArray(paginas.pages) ? paginas.pages : [];
    const armado = armarCurso(curso, ficha, secciones, eventos, aviso, listaPaginas);
    if (corte) {
      const antes = armado.sesiones.length;
      armado.sesiones = armado.sesiones.filter((sesion) => !esAntigua(sesion.numero, sesion.fecha_iso, corte));
      cuenta.omitidas += antes - armado.sesiones.length;
    }
    return armado;
  });
  return {
    sitio: SITIO,
    cuenta: textoPlano(sitio.fullname).slice(0, 120),
    cursos: armados,
    zoom_lectura: cuenta,
  };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function respuestaJson(data, status = 200) {
  return {
    status,
    ok: status < 400,
    text: async () => JSON.stringify(data),
  };
}

async function selfTest() {
  assert(textoPlano("Sesión&nbsp;4<br>A&amp;B") === "Sesión 4 A&B", "texto");
  assert(profesorDe({}, { contacts: [{ fullname: "Ana Pérez" }] }) === "Ana Pérez", "contacto");
  assert(profesorDe({ summary: "Docente: Luis Gómez. Bienvenida" }, {}) === "Luis Gómez", "docente");

  const inicio = Date.UTC(2026, 10, 7, 0, 0, 0) / 1000;
  const curso = armarCurso(
    { id: 9, fullname: "Psicología del desarrollo", summary: "" },
    { contacts: [{ fullname: "Ana Pérez" }] },
    [
      { section: 0, name: "General", summary: "", modules: [] },
      {
        section: 4,
        name: "Sesión 4: Bases biológicas del lenguaje",
        summary: "Otro texto",
        modules: [{
          instance: 44,
          modname: "url",
          name: "Grabación",
          url: "https://uvcv.edu.pe/mod/url/view.php?id=44",
          contents: [{ fileurl: "https://ucv-edu-pe.zoom.us/rec/share/abc", filename: "Zoom" }],
          description: "",
        }, {
          instance: 45,
          modname: "resource",
          name: "PPT sesión 4",
          url: "https://uvcv.edu.pe/mod/resource/view.php?id=45",
          contents: [{
            filename: "Bases biologicas.pptx",
            mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            fileurl: "https://uvcv.edu.pe/webservice/pluginfile.php/99/mod_resource/content/1/Bases%20biologicas.pptx?token=secreto",
          }],
          description: "También https://ejemplo.com/clase.pptx",
        }],
      },
      {
        section: 1,
        name: "Semana 1. Evaluación inicial",
        summary: "6 de noviembre de 2026, 19:00 a 21:00",
        modules: [],
      },
    ],
    [{ instance: 44, modulename: "url", timestart: inicio, timeduration: 7200, name: "Clase" }],
  );
  assert(curso.profesor === "Ana Pérez", "profesor");
  assert(curso.sesiones.length === 2, "sesiones");
  assert(curso.sesiones[0].numero === "1", "orden");
  assert(curso.sesiones[0].titulo === "Evaluación inicial", "titulo 1");
  assert(curso.sesiones[0].fecha === "6 de noviembre de 2026", "fecha texto");
  assert(curso.sesiones[0].fecha_iso === "2026-11-06", "iso texto");
  assert(curso.sesiones[0].hora === "19:00–21:00", "hora texto");
  assert(curso.sesiones[1].numero === "4", "numero 4");
  assert(curso.sesiones[1].titulo === "Bases biológicas del lenguaje", "titulo 4");
  assert(curso.sesiones[1].fecha === "6 de noviembre de 2026", "fecha calendario");
  assert(curso.sesiones[1].fecha_iso === "2026-11-06", "iso calendario");
  assert(curso.sesiones[1].hora === "19:00–21:00", "hora calendario");
  assert(curso.sesiones[1].enlaces.length === 1 && curso.sesiones[1].enlaces[0].zoom, "zoom");
  assert(curso.sesiones[1].presentaciones.length === 2, "ppt");
  assert(curso.sesiones[1].presentaciones[0].nombre === "Bases biologicas.pptx", "nombre ppt");
  assert(
    curso.sesiones[1].presentaciones[0].url === "https://uvcv.edu.pe/pluginfile.php/99/mod_resource/content/1/Bases%20biologicas.pptx",
    "ppt sin token",
  );
  assert(curso.sesiones[1].presentaciones[1].url === "https://ejemplo.com/clase.pptx", "ppt en el texto");
  const lectura = armarCurso({ id: 8, fullname: "Curso" }, {}, [{
    section: 2,
    name: "Sesión 2",
    modules: [{
      modname: "resource",
      name: "Lectura de la sesión",
      url: "https://uvcv.edu.pe/mod/resource/view.php?id=46",
      contents: [{
        filename: "lectura.pdf",
        mimetype: "application/pdf",
        fileurl: "https://uvcv.edu.pe/webservice/pluginfile.php/99/mod_resource/content/1/lectura.pdf?token=secreto",
      }],
    }],
  }], []);
  assert(lectura.sesiones[0].presentaciones.length === 0, "pdf no es ppt");
  assert(!curso.sesiones.some((item) => item.titulo === "General"), "portada");
  const soloNombre = armarCurso({ id: 2, fullname: "Curso" }, {}, [{
    section: 1,
    name: "Sesión 1",
    modules: [{
      modname: "resource",
      name: "Presentación",
      url: "https://uvcv.edu.pe/mod/resource/view.php?id=8",
    }],
  }], []);
  assert(soloNombre.sesiones[0].presentaciones[0].url.includes("view.php?id=8"), "ppt por nombre");

  const leido = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    assert(!destino.includes("secreta"), "la clave no viaja en la dirección");
    if (destino.includes("/login/token.php")) {
      assert(options.body.get("username") === "ada", "usuario");
      assert(options.body.get("password") === "secreta", "clave");
      assert(options.headers["User-Agent"] === "MoodleMobile", "entra como la app");
      return respuestaJson({ token: "a".repeat(32) });
    }
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([{ id: 9, fullname: "Psicología del desarrollo", startdate: 10 }]);
    }
    if (destino.includes("core_course_get_courses_by_field")) {
      return respuestaJson({ courses: [{ contacts: [{ fullname: "Ana Pérez" }] }] });
    }
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([{ section: 2, name: "Sesión 2: Apego", summary: "06/11/2026 19:00", modules: [] }]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(leido.cuenta === "Ada", "cuenta");
  assert(leido.cursos[0].profesor === "Ana Pérez", "profesor leído");
  assert(leido.cursos[0].sesiones[0].numero === "2", "sesión leída");
  assert(leido.cursos[0].sesiones[0].titulo === "Apego", "título leído");
  assert(leido.cursos[0].sesiones[0].fecha === "6 de noviembre de 2026", "fecha leída");
  assert(leido.cursos[0].sesiones[0].fecha_iso === "2026-11-06", "iso leída");
  assert(leido.cursos[0].sesiones[0].hora === "19:00", "hora leída");

  const recPagina = "https://ucv-edu-pe.zoom.us/rec/share/grabacion7";
  const vista = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    assert(!destino.includes("secreta"), "la clave no viaja en la dirección");
    if (destino.includes("/login/token.php")) {
      return respuestaJson({ token: "c".repeat(32), privatetoken: "d".repeat(32) });
    }
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([{ id: 8, fullname: "Salud pública", startdate: 10 }]);
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([{
        section: 1,
        name: "Sesión 1: Salud",
        modules: [{
          id: 5,
          modname: "zoom",
          name: "ENLACE ZOOM SESION 1",
          url: `${SITIO}/mod/zoom/view.php?id=5`,
          description: "",
        }],
      }]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) return respuestaJson({ start_time: 0 });
    if (destino.includes("tool_mobile_get_autologin_key")) {
      assert(!destino.includes("privatetoken="), "la clave privada no va en la dirección");
      assert(options && options.method === "POST", "pide la sesión por POST");
      assert(String(options && options.body).includes(`privatetoken=${"d".repeat(32)}`), "manda la clave privada en el cuerpo");
      assert(options.headers["User-Agent"] === "MoodleMobile", "se identifica como la app");
      return respuestaJson({ key: "abc12345", autologinurl: `${SITIO}/admin/tool/mobile/autologin.php` });
    }
    if (destino.includes("/autologin.php")) {
      assert(destino.includes("userid=3") && destino.includes("key=abc12345"), "abre con la clave de un uso");
      assert(!destino.includes("privatetoken"), "no repite la clave privada");
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=abc; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/my/")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    }
    if (destino.includes("/mod/zoom/view.php?id=5")) {
      assert(String(options.headers.Cookie).includes("MoodleSession=abc"), "entra con la sesión");
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => `<a href="${recPagina}">Grabación</a>`,
      };
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(
    vista.cursos[0].sesiones[0].enlaces.some((item) => item.url === recPagina),
    "la grabación sale de la página de Zoom",
  );

  const recListado = "https://ucv-edu-pe.zoom.us/rec/play/listado1";
  const porListado = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    assert(!destino.includes("secreta"), "la clave no viaja en la dirección");
    if (destino.includes("/login/token.php")) {
      return respuestaJson({ token: "e".repeat(32), privatetoken: "f".repeat(32) });
    }
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([{ id: 8, fullname: "Bases biológicas", startdate: 10 }]);
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([{
        section: 1,
        name: "Sesión 1: Neurociencias",
        modules: [{
          id: 9,
          modname: "zoom",
          name: "ENLACE ZOOM SESIÓN 1",
          url: `${SITIO}/mod/zoom/view.php?id=9`,
          description: "",
        }],
      }]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) return respuestaJson({ start_time: 0 });
    if (destino.includes("tool_mobile_get_autologin_key")) {
      assert(options && options.method === "POST", "el listado pide la sesión por POST");
      assert(!destino.includes("privatetoken="), "el listado no pone la clave privada en la dirección");
      return respuestaJson({ key: "abc12345", autologinurl: `${SITIO}/admin/tool/mobile/autologin.php` });
    }
    if (destino.includes("/autologin.php")) {
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=abc; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/my/")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    }
    if (destino.includes("/mod/zoom/view.php?id=9")) {
      assert(String(options.headers.Cookie).includes("MoodleSession=abc"), "abre la reunión con sesión");
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "<p>Reunión terminada</p>" };
    }
    if (destino.includes("/mod/zoom/recordings.php?id=9")) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => [
          '<a href="/mod/zoom/loadrecording.php?id=9&amp;recordingid=3">Clase (Solo audio)</a>',
          '<a href="/mod/zoom/loadrecording.php?id=9&amp;recordingid=4">Clase (Pantalla compartida con vista del hablante)</a>',
        ].join(""),
      };
    }
    if (destino.includes("/mod/zoom/loadrecording.php") && destino.includes("recordingid=4")) {
      return {
        status: 302,
        ok: false,
        headers: { get: (nombre) => (nombre === "location" ? recListado : null) },
        text: async () => "",
      };
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(
    porListado.cursos[0].sesiones[0].enlaces.some((item) => item.url === recListado),
    "la grabación sale del listado de Zoom",
  );
  assert(
    !porListado.cursos[0].sesiones[0].enlaces.some((item) => /recordingid=3/.test(item.url)),
    "no usa la pista de solo audio",
  );

  const zoomStart = Date.UTC(2026, 9, 10, 18, 30, 0) / 1000;
  const frase = armarCurso({ id: 1, fullname: "Curso" }, {}, [{
    section: 3,
    name: "Sesión 3: Planificar",
    summary: "",
    modules: [{
      id: 77,
      instance: 70,
      modname: "zoom",
      name: "Zoom",
      description: "La reunión ya ha terminado. Planificar Hora de empezarsábado, 10 de octubre de 2026, 13:30",
    }, {
      instance: 9,
      modname: "assign",
      name: "Tarea",
      description: "",
    }],
  }], [{ instance: 9, modulename: "assign", timestart: zoomStart + 86400, timeduration: 0, name: "Entrega" }]);
  assert(frase.sesiones[0].fecha_iso === "2026-10-10", "iso frase");
  assert(frase.sesiones[0].fecha === "10 de octubre de 2026", "fecha frase");
  assert(frase.sesiones[0].hora === "13:30", "hora frase");

  const planificar = "<div>Planificar</div><div>Hora de empezar</div><div>domingo, 1 de noviembre de 2026, 15:20</div>";
  const pegado = "Entrega el 2 de octubre de 2026. Planificar Hora de empezardomingo, 1 de noviembre de 2026, 15:20";
  for (const description of [planificar, pegado]) {
    const pagina = armarCurso({ id: 1, fullname: "Curso" }, {}, [{
      section: 1,
      name: "Sesión 1",
      summary: "",
      modules: [{ id: 3, instance: 4, modname: "zoom", name: "Zoom", description }],
    }], []);
    assert(pagina.sesiones[0].fecha_iso === "2026-11-01", "iso hora de empezar");
    assert(pagina.sesiones[0].fecha === "1 de noviembre de 2026", "fecha hora de empezar");
    assert(pagina.sesiones[0].hora === "15:20", "hora de empezar");
  }

  const dato = armarCurso({ id: 1, fullname: "Curso" }, {}, [{
    section: 5,
    name: "Sesión 5",
    summary: "",
    modules: [{
      id: 80,
      instance: 81,
      modname: "zoom",
      name: "Clase",
      description: "La reunión ya ha terminado.",
      customdata: JSON.stringify({ start_time: zoomStart, duration: 7200 }),
    }],
  }], []);
  assert(dato.sesiones[0].fecha_iso === "2026-10-10", "iso zoom");
  assert(dato.sesiones[0].hora === "13:30–15:30", "hora zoom");

  const porFecha = armarCurso({ id: 1, fullname: "Curso" }, {}, [{
    section: 6,
    name: "Sesión 6",
    summary: "",
    modules: [{
      id: 82,
      instance: 83,
      modname: "zoom",
      name: "Clase",
      description: "",
      dates: [{ label: "Hora de empezar", timestamp: zoomStart, dataid: "start_time" }],
    }],
  }], []);
  assert(porFecha.sesiones[0].fecha_iso === "2026-10-10", "iso dates");
  assert(porFecha.sesiones[0].hora === "13:30", "hora dates");

  const leidoZoom = await entrarYLeer("ada", "secreta", async (url) => {
    const destino = String(url);
    if (destino.includes("/login/token.php")) return respuestaJson({ token: "b".repeat(32) });
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) return respuestaJson([{ id: 4, fullname: "Curso", startdate: 10 }]);
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([{
        section: 8,
        name: "Sesión 8",
        summary: "",
        modules: [{ id: 90, instance: 91, modname: "zoom", name: "Zoom", description: "" }],
      }]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) {
      assert(destino.includes("zoomid=90"), "pide el módulo de Zoom");
      return respuestaJson({ start_time: zoomStart, duration: 5400 });
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(leidoZoom.cursos[0].sesiones[0].fecha_iso === "2026-10-10", "iso estado");
  assert(leidoZoom.cursos[0].sesiones[0].hora === "13:30–15:00", "hora estado");

  const silabo = "<p>Sesión 1 y 2</p><p>Sesión 01: Concepto de neurociencias y<br>reseña histórica. Relación<br>cerebro- conducta.</p><p>Sesión 03: Sistema nervioso.</p>";
  const nombres = armarCurso({ id: 3, fullname: "Neurociencias" }, {}, [
    { section: 1, name: "Sesión 1 y 2", summary: "", modules: [] },
    {
      section: 2,
      name: "Sesión 1",
      summary: "",
      modules: [{ modname: "zoom", name: "Zoom", description: "" }],
    },
    {
      section: 3,
      name: "Sesión 2",
      summary: "",
      modules: [{ modname: "zoom", name: "Zoom", description: "" }],
    },
    {
      section: 4,
      name: "Sesión 3",
      summary: "",
      modules: [{ modname: "zoom", name: "Zoom", description: "" }],
    },
  ], [], "", [{ name: "Contenido", content: silabo }]);
  assert(nombres.sesiones.length === 3, "no repite el rango");
  assert(nombres.sesiones[0].numero === "1" && nombres.sesiones[0].titulo === "Concepto de neurociencias y reseña histórica. Relación cerebro-conducta", "título 1");
  assert(nombres.sesiones[1].numero === "2" && nombres.sesiones[1].titulo === nombres.sesiones[0].titulo, "título 2");
  assert(nombres.sesiones[2].numero === "3" && nombres.sesiones[2].titulo === "Sistema nervioso", "título 3");

  const bloque = [
    "Sesión 01: Concepto de neurociencias y",
    "reseña histórica. Relación",
    "cerebro- conducta.",
    "Introducción. SN, organización",
    "estructural y funcional. / Sesión 02: Filogenia y ontogenia del",
    "sistema nervioso. Evolución y",
    "desarrollo embriológico del",
    "sistema nervioso en todas las",
    "especies como en el ser",
    "humano.",
  ].join("\n");
  const zoom = (url) => ({ modname: "url", name: "Grabación", url: "https://uvcv.edu.pe/mod/url/view.php?id=1", contents: [{ fileurl: url, filename: "Zoom" }] });
  const dos = armarCurso({ id: 4, fullname: "Neurociencias" }, {}, [
    { section: 1, name: "Sesión 1", summary: "", modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/s1")] },
    { section: 2, name: "Sesión 2", summary: "", modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/s2")] },
  ], [], "", [{ content: bloque }]);
  assert(dos.sesiones.length === 2, "siguen las dos sesiones");
  assert(dos.sesiones[0].titulo === "Concepto de neurociencias y reseña histórica. Relación cerebro-conducta. Introducción. SN, organización estructural y funcional", "título largo 1");
  assert(dos.sesiones[1].titulo === "Filogenia y ontogenia del sistema nervioso. Evolución y desarrollo embriológico del sistema nervioso en todas las especies como en el ser humano", "título largo 2");
  assert(dos.sesiones[0].enlaces.length === 1 && dos.sesiones[1].enlaces.length === 1, "siguen los enlaces");

  const conGuia = armarCurso({ id: 5, fullname: "Neurociencias" }, {}, [
    {
      section: 1,
      name: "Sesión 1 y 2",
      summary: "",
      modules: [{ modname: "url", name: "Guía", url: "https://ejemplo.com/guia", description: "" }],
    },
  ], []);
  assert(conGuia.sesiones.length === 1 && conGuia.sesiones[0].enlaces.length === 1, "el rango no esconde el enlace");

  const leidoNombre = await entrarYLeer("ada", "secreta", async (url) => {
    const destino = String(url);
    if (destino.includes("/login/token.php")) return respuestaJson({ token: "c".repeat(32) });
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) return respuestaJson([{ id: 8, fullname: "Neurociencias", startdate: 10 }]);
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([
        { section: 1, name: "Sesión 1", summary: "", modules: [{ modname: "zoom", name: "Zoom", description: "" }] },
      ]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) {
      return respuestaJson({ pages: [{ content: "Sesión 01: Concepto de neurociencias y reseña histórica." }] });
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(leidoNombre.cursos[0].sesiones[0].titulo === "Concepto de neurociencias y reseña histórica", "título desde la página");

  const titulo1 = "Concepto de neurociencias y reseña histórica. Relación cerebro-conducta. Introducción. SN, organización estructural y funcional";
  const titulo2 = "Filogenia y ontogenia del sistema nervioso. Evolución y desarrollo embriológico del sistema nervioso en todas las especies como en el ser humano";
  const pares = armarCurso({ id: 6, fullname: "Neurociencias" }, {}, [
    {
      section: 1,
      name: "Sesión 1",
      summary: bloque,
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p1")],
    },
    {
      section: 2,
      name: "Sesión 2: Zoom",
      summary: "",
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p2")],
    },
    {
      section: 3,
      name: "Sesión 3",
      summary: "Sesión 03: Tercer tema de neurociencias aplicada. / Sesión 04: Cuarto tema de bases y conducta.",
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p3")],
    },
    {
      section: 4,
      name: "Sesión 4. Grabación",
      summary: "",
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p4")],
    },
    {
      section: 5,
      name: "Sesión 5 — Quinto tema de evaluación del lenguaje",
      summary: "",
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p5")],
    },
    {
      section: 6,
      name: "Sesión 6 | Clase",
      summary: "Sesión 06 | Sexto tema de desarrollo del sistema nervioso",
      modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/p6")],
    },
  ], []);
  assert(pares.sesiones.length === 6, "siguen las seis sesiones");
  assert(pares.sesiones[0].titulo === titulo1 && !pares.sesiones[0].titulo.includes("Sesión 02"), "la 1 no se queda con la 2");
  assert(pares.sesiones[1].titulo === titulo2 && !/zoom/i.test(pares.sesiones[1].titulo), "la 2 tiene su nombre");
  assert(pares.sesiones[2].titulo === "Tercer tema de neurociencias aplicada", "la 3 tiene su nombre");
  assert(pares.sesiones[3].titulo === "Cuarto tema de bases y conducta" && !/grabaci/i.test(pares.sesiones[3].titulo), "la 4 tiene su nombre");
  assert(pares.sesiones[4].titulo === "Quinto tema de evaluación del lenguaje", "la 5 con raya");
  assert(pares.sesiones[5].titulo === "Sexto tema de desarrollo del sistema nervioso" && !/^clase$/i.test(pares.sesiones[5].titulo), "la 6 con barra");
  assert(pares.sesiones.every((item) => item.enlaces.length === 1), "siguen los enlaces del par");

  const sinEtiqueta = armarCurso({ id: 7, fullname: "Neurociencias" }, {}, [
    {
      section: 1,
      name: "Sesión 1 y 2",
      summary: "Sesión 01: Concepto de neurociencias y reseña histórica. / Filogenia y ontogenia del sistema nervioso en el ser humano.",
      modules: [],
    },
    { section: 2, name: "Sesión 1", summary: "", modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/q1")] },
    { section: 3, name: "Sesión 2 - Clase", summary: "", modules: [zoom("https://ucv-edu-pe.zoom.us/rec/share/q2")] },
  ], []);
  assert(sinEtiqueta.sesiones.length === 2, "el rango vacío no se muestra");
  assert(sinEtiqueta.sesiones[0].titulo === "Concepto de neurociencias y reseña histórica", "mitad 1");
  assert(sinEtiqueta.sesiones[1].titulo === "Filogenia y ontogenia del sistema nervioso en el ser humano", "mitad 2");

  const archivo = (nombre, url, mime) => ({
    filename: nombre,
    mimetype: mime,
    fileurl: url,
  });
  const ppt = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const propioMaterial = armarCurso({ id: 11, fullname: "Neurociencias" }, {}, [
    {
      section: 1,
      name: "Sesión 1",
      summary: bloque,
      modules: [
        {
          modname: "url",
          name: "Videoconferencia - Sesión 01",
          url: "https://uvcv.edu.pe/mod/url/view.php?id=101",
          description: "Hora de empezarlunes, 2 de noviembre de 2026, 10:00",
        },
        {
          modname: "url",
          name: "Videoconferencia Sesión - 02",
          url: "https://uvcv.edu.pe/mod/url/view.php?id=102",
          description: "Hora de empezarmartes, 3 de noviembre de 2026, 11:00",
          contents: [{ fileurl: "https://ucv-edu-pe.zoom.us/rec/share/par02", filename: "Videoconferencia Sesión - 02" }],
        },
        {
          modname: "resource",
          name: "Diapositivas Sesión 01",
          contents: [archivo("Diapositivas Sesión 01.pptx", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/Diapositivas%20Sesion%2001.pptx", ppt)],
        },
        {
          modname: "resource",
          name: "Diapositivas Sesión - 02",
          contents: [archivo("Diapositivas Sesión - 02.pptx", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/Diapositivas%20Sesion%2002.pptx", ppt)],
        },
        {
          modname: "resource",
          name: "Lectura Sesión 01",
          contents: [archivo("Lectura Sesión 01.pdf", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/Lectura%20Sesion%2001.pdf", "application/pdf")],
        },
        {
          modname: "resource",
          name: "Lectura Sesión - 02",
          contents: [archivo("Lectura Sesión - 02.pdf", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/Lectura%20Sesion%2002.pdf", "application/pdf")],
        },
      ],
    },
    { section: 2, name: "Sesión 2", summary: "", modules: [] },
  ], []);
  const clase1 = propioMaterial.sesiones.find((item) => item.numero === "1");
  const clase2 = propioMaterial.sesiones.find((item) => item.numero === "2");
  assert(clase1 && clase2, "siguen las dos clases");
  assert(clase1.enlaces.some((item) => item.nombre === "Videoconferencia - Sesión 01") && !clase1.enlaces.some((item) => /02/.test(item.nombre) || item.url.includes("par02")), "la 1 conserva su enlace");
  assert(clase1.enlaces.some((item) => item.url.includes("Lectura%20Sesion%2001.pdf")) && !clase1.enlaces.some((item) => item.url.includes("Lectura%20Sesion%2002.pdf")), "la 1 conserva su lectura");
  assert(clase1.presentaciones.length === 1 && clase1.presentaciones[0].url.includes("Sesion%2001.pptx"), "la 1 conserva su pptx");
  assert(clase2.enlaces.some((item) => item.url.includes("par02")) && !clase2.enlaces.some((item) => item.url.includes("id=101")), "la 2 recibe su zoom");
  assert(clase2.enlaces.some((item) => item.url.includes("Lectura%20Sesion%2002.pdf")), "la 2 recibe su lectura");
  assert(clase2.presentaciones.length === 1 && clase2.presentaciones[0].url.includes("Sesion%2002.pptx"), "la 2 recibe su pptx");
  assert(clase1.fecha_iso === "2026-11-02" && clase1.hora === "10:00", "la 1 conserva su hora");
  assert(clase2.fecha_iso === "2026-11-03" && clase2.hora === "11:00", "la 2 conserva su hora");
  assert(clase2.titulo.startsWith("Filogenia"), "la 2 sigue con su nombre");

  const pdf = (nombre, id) => ({
    modname: "resource",
    name: nombre,
    contents: [archivo(nombre.endsWith(".pdf") ? nombre : `${nombre}.pdf`, `https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/${id}.pdf`, "application/pdf")],
  });
  const orientaciones = armarCurso({ id: 12, fullname: "Neurociencias" }, {}, [
    {
      section: 11,
      name: "Sesión 11: Evaluación",
      summary: "",
      modules: [
        pdf("Orientación al estudiante 11", "ori11"),
        pdf("Orientación al estudiante 12", "ori12"),
        pdf("Lectura 12", "lec12"),
        pdf("Informe final 2026", "anio"),
        {
          modname: "resource",
          name: "Materiales",
          contents: [
            archivo("Otra lectura 11.pdf", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/otra11.pdf", "application/pdf"),
            archivo("Guia_del_estudiante_12.pdf", "https://uvcv.edu.pe/webservice/pluginfile.php/1/mod_resource/content/1/guia12.pdf", "application/pdf"),
          ],
        },
      ],
    },
    { section: 12, name: "Sesión 12: Cierre", summary: "", modules: [] },
  ], []);
  const once = orientaciones.sesiones.find((item) => item.numero === "11");
  const doce = orientaciones.sesiones.find((item) => item.numero === "12");
  assert(once && doce, "siguen la 11 y la 12");
  assert(once.titulo === "Evaluación" && doce.titulo === "Cierre", "los nombres no se mueven");
  assert(once.enlaces.some((item) => item.url.includes("ori11")) && once.enlaces.some((item) => item.url.includes("otra11")), "la 11 conserva lo suyo");
  assert(!once.enlaces.some((item) => /ori12|lec12|guia12/.test(item.url)), "la 11 no se queda con lo de la 12");
  assert(doce.enlaces.some((item) => item.url.includes("ori12")), "orientación 12 pasa a la 12");
  assert(doce.enlaces.some((item) => item.url.includes("lec12")), "lectura 12 pasa a la 12");
  assert(doce.enlaces.some((item) => item.url.includes("guia12")), "el archivo 12 pasa a la 12");
  assert(once.enlaces.some((item) => item.url.includes("anio")), "un año no es número de sesión");

  const ingles = armarCurso({ id: 13, fullname: "Inglés" }, {}, [
    { section: 1, name: "1. Present simple", summary: "", modules: [] },
    {
      section: 2,
      name: "Sesión 1",
      summary: "",
      modules: [{
        modname: "url",
        name: "Zoom",
        url: "https://uvcv.edu.pe/mod/url/view.php?id=201",
        description: "Hora de empezarlunes, 2 de noviembre de 2026, 08:00",
      }],
    },
    { section: 3, name: "Session 2: Past simple", summary: "", modules: [] },
    {
      section: 4,
      name: "Sesión 2",
      summary: "",
      modules: [{
        modname: "url",
        name: "Videoconference Session 2",
        url: "https://uvcv.edu.pe/mod/url/view.php?id=202",
        contents: [{ fileurl: "https://ucv-edu-pe.zoom.us/rec/share/eng2", filename: "Zoom" }],
      }],
    },
    { section: 5, name: "Session 3: Questions in English", summary: "", modules: [] },
    {
      section: 6,
      name: "Enlaces",
      summary: "",
      modules: [{
        modname: "url",
        name: "Videoconference Session 3",
        url: "https://uvcv.edu.pe/mod/url/view.php?id=203",
      }],
    },
  ], []);
  assert(ingles.sesiones.length === 3, "inglés no duplica la sesión");
  const ing1 = ingles.sesiones.find((item) => item.numero === "1");
  const ing2 = ingles.sesiones.find((item) => item.numero === "2");
  const ing3 = ingles.sesiones.find((item) => item.numero === "3");
  assert(ing1 && ing1.titulo === "Present simple" && ing1.enlaces.some((item) => item.url.includes("id=201")), "la 1 recibe su enlace");
  assert(ing1.fecha_iso === "2026-11-02" && ing1.hora === "08:00", "la 1 conserva la hora del enlace");
  assert(ing2 && ing2.titulo === "Past simple" && ing2.enlaces.some((item) => item.url.includes("eng2")), "la 2 recibe su enlace");
  assert(ing3 && ing3.titulo === "Questions in English" && ing3.enlaces.some((item) => item.url.includes("id=203")), "la 3 recibe su enlace");
  assert(!ingles.sesiones.some((item) => item.titulo === "Enlaces" || /^sesi[oó]n\s+\d+$/i.test(item.titulo)), "no queda una fila solo con el enlace");

  let entradas = 0;
  const dosCursos = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    if (destino.includes("/login/token.php")) {
      return respuestaJson({ token: "a".repeat(32), privatetoken: "b".repeat(32) });
    }
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([
        { id: 21, fullname: "Bases", startdate: 20 },
        { id: 22, fullname: "Salud", startdate: 10 },
      ]);
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      const id = destino.includes("courseid=21") ? 14453797 : 14048327;
      const titulo = id === 14453797 ? "Sesión 2: Neuronas" : "Sesión 1: Salud";
      return respuestaJson([{
        section: 1,
        name: titulo,
        modules: [{
          id,
          modname: "zoom",
          name: "ENLACE ZOOM",
          url: `${SITIO}/mod/zoom/view.php?id=${id}`,
          description: "",
        }],
      }]);
    }
    if (destino.includes("core_calendar")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) return respuestaJson({ start_time: 0 });
    if (destino.includes("tool_mobile_get_autologin_key")) {
      entradas += 1;
      assert(options && options.method === "POST", "pide la sesión una vez");
      return respuestaJson({ key: "abc12345", autologinurl: `${SITIO}/admin/tool/mobile/autologin.php` });
    }
    if (destino.includes("/autologin.php")) {
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=abc; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/my/")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    }
    if (destino.includes("/mod/zoom/view.php")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "<p>Reunión</p>" };
    }
    const pagina = destino.includes("id=14453797") ? "14453797" : "14048327";
    if (destino.includes("/mod/zoom/recordings.php")) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => `<a href="/mod/zoom/loadrecording.php?id=${pagina}&amp;recordingid=${pagina}">Clase (Pantalla compartida)</a>`,
      };
    }
    if (destino.includes("/mod/zoom/loadrecording.php")) {
      const rec = destino.includes("14453797")
        ? "https://ucv-edu-pe.zoom.us/rec/play/bases2"
        : "https://ucv-edu-pe.zoom.us/rec/play/salud1";
      return {
        status: 302,
        ok: false,
        headers: { get: (nombre) => (nombre === "location" ? rec : null) },
        text: async () => "",
      };
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(entradas === 1, "abre la sesión una sola vez para todos los cursos");
  const cursoBases = dosCursos.cursos.find((curso) => curso.nombre === "Bases");
  const cursoSalud = dosCursos.cursos.find((curso) => curso.nombre === "Salud");
  assert(cursoBases.sesiones[0].enlaces.some((item) => item.url.endsWith("/rec/play/bases2")), "la sesión 2 sale del listado");
  assert(cursoSalud.sesiones[0].enlaces.some((item) => item.url.endsWith("/rec/play/salud1")), "la otra reunión también");

  let formularios = 0;
  const porFormulario = await entrarYLeer("ada", "clave-prueba", async (url, options) => {
    const destino = String(url);
    assert(!destino.includes("clave-prueba"), "la clave no va en la dirección");
    if (destino.includes("/login/token.php")) {
      return respuestaJson({ token: "a".repeat(32), privatetoken: "b".repeat(32) });
    }
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([{ id: 21, fullname: "Bases", startdate: 20 }]);
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([{
        section: 1,
        name: "Sesión 2: Neuronas",
        modules: [{
          id: 14453797,
          modname: "zoom",
          name: "ENLACE ZOOM",
          url: `${SITIO}/mod/zoom/view.php?id=14453797`,
          description: "",
        }],
      }]);
    }
    if (destino.includes("core_calendar")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) return respuestaJson({ start_time: 0 });
    if (destino.includes("tool_mobile_get_autologin_key")) {
      return respuestaJson({
        exception: "moodle_exception",
        errorcode: "autologinkeygenerationlockout",
        message: "Espere.",
      });
    }
    if (destino.includes("testsession=")) {
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=formulario; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/login/index.php")) {
      formularios += 1;
      if (options && options.method === "POST") {
        const cuerpo = String(options.body || "");
        assert(cuerpo.includes("username=ada") && cuerpo.includes("password=") && cuerpo.includes("logintoken=abc12345"), "entra por el formulario");
        return {
          status: 303,
          ok: false,
          headers: { get: (nombre) => ({ location: `${SITIO}/login/index.php?testsession=3`, "set-cookie": "MoodleSession=formulario; path=/" }[nombre] || null) },
          text: async () => "",
        };
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => '<input type="hidden" name="logintoken" value="abc12345">',
      };
    }
    if (destino.includes("/my/")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    }
    if (destino.includes("/mod/zoom/view.php")) {
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => "<p>Reunión</p>" };
    }
    if (destino.includes("/mod/zoom/recordings.php")) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => '<a href="/mod/zoom/loadrecording.php?id=14453797&amp;recordingid=9">Clase (Pantalla compartida)</a>',
      };
    }
    if (destino.includes("/mod/zoom/loadrecording.php")) {
      return {
        status: 302,
        ok: false,
        headers: { get: (nombre) => (nombre === "location" ? "https://ucv-edu-pe.zoom.us/rec/play/bases2" : null) },
        text: async () => "",
      };
    }
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(formularios === 2, "si la app rechaza la entrada usa el formulario una vez");
  assert(!porFormulario.zoom_lectura.motivo, "la entrada del formulario queda abierta");
  assert(porFormulario.cursos[0].sesiones[0].enlaces.some((item) => item.url.endsWith("/rec/play/bases2")), "el formulario también llega al video");

  try {
    await entrarYLeer("ada", "mala", async () => respuestaJson({ error: "Invalid login", errorcode: "invalidlogin" }));
    assert(false, "debió rechazar la clave");
  } catch (error) {
    assert(error.publico && error.message.includes("no aceptó") && !error.message.includes("mala"), "aviso de clave");
  }
  try {
    await entrarYLeer("ada", "secreta", async () => ({
      status: 403,
      ok: false,
      headers: { get: () => null },
      text: async () => "<html><title>Access denied</title></html>",
    }));
    assert(false, "debió avisar que la respuesta no es json");
  } catch (error) {
    assert(error.publico && error.message.includes("Access denied") && !error.message.includes("secreta"), "dice el título de la página");
  }

  const halladas = [
    { curso: "Bases biológicas del comportamiento", titulo: "Sesión 14", fecha: "2026-10-01" },
    { curso: "Bases biológicas del comportamiento - B10", titulo: "Sesión 16", fecha: "2026-10-20" },
    { curso: "Bases biológicas del comportamiento", titulo: "Sesión 15", fecha: "2026-10-10" },
  ];
  assert(corteDe(halladas, "Bases biológicas del comportamiento - B10").numero === 15, "la penúltima sesión es la 15");
  assert(corteDe([{ curso: "Salud", titulo: "Sesión 8", fecha: "2026-09-01" }], "Salud") === null, "una sola sesión no recorta");
  assert(esAntigua(14, "2026-10-01", { numero: 15, fecha: "2026-10-10" }), "la 14 queda atrás");
  assert(!esAntigua(15, "2026-10-10", { numero: 15, fecha: "2026-10-10" }), "la penúltima se vuelve a abrir");
  assert(!esAntigua(0, "2026-11-01", { numero: 15, fecha: "2026-10-10" }), "una clase nueva sin número entra");
  assert(!esAntigua(0, "", { numero: 15, fecha: "2026-10-10" }), "sin fecha ni número no se esconde");
  const abiertas = [];
  const recortada = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    if (destino.includes("/login/token.php")) return respuestaJson({ token: "a".repeat(32), privatetoken: "b".repeat(32) });
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([{ id: 8, fullname: "Bases biológicas del comportamiento - B10", startdate: 10 }]);
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([
        { section: 1, name: "Sesión 1: Vieja", modules: [{ id: 1, modname: "zoom", name: "Zoom", url: `${SITIO}/mod/zoom/view.php?id=1` }] },
        { section: 15, name: "Sesión 15: Nueva", modules: [{ id: 15, modname: "zoom", name: "Zoom", url: `${SITIO}/mod/zoom/view.php?id=15` }] },
      ]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) {
      assert(!destino.includes("zoomid=1"), "no pide la hora de la sesión vieja");
      return respuestaJson({ start_time: 0 });
    }
    if (destino.includes("tool_mobile_get_autologin_key")) return respuestaJson({ key: "abc12345", autologinurl: `${SITIO}/admin/tool/mobile/autologin.php` });
    if (destino.includes("/autologin.php")) {
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=abc; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/my/")) return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    if (destino.includes("/mod/zoom/recordings.php")) {
      abiertas.push(destino);
      assert(!destino.includes("id=1"), "no abre el enlace antiguo");
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => "https://ucv-edu-pe.zoom.us/rec/play/nueva15token",
      };
    }
    throw new Error(`llamada inesperada ${destino.split("?")[0]}`);
  }, { halladas });
  assert(abiertas.length === 1 && abiertas[0].includes("id=15"), "solo abre la penúltima y lo que sigue");
  assert(recortada.zoom_lectura.recorte === 1 && recortada.zoom_lectura.saltadas === 1, "cuenta el enlace que no abrió");
  assert(recortada.cursos[0].sesiones.length === 1 && recortada.cursos[0].sesiones[0].numero === "15", "la lista empieza en la penúltima");

  assert(hoyLima(Date.UTC(2026, 10, 2, 5, 0, 0)) === "2026-11-02", "el día de Lima empieza a las 00:00");
  assert(hoyLima(Date.UTC(2026, 10, 2, 4, 59, 0)) === "2026-11-01", "antes de medianoche en Lima sigue el día anterior");
  assert(diasEntre("2026-10-03", "2026-11-02") === 30, "treinta días es un mes");
  assert(cursoQuieto([{ curso: "Salud pública", titulo: "Sesión 16", fecha: "2026-10-03" }], "Salud pública - B10", "2026-11-02"), "a los 30 días el curso se calla");
  assert(!cursoQuieto([{ curso: "Salud pública", titulo: "Sesión 16", fecha: "2026-10-04" }], "Salud pública", "2026-11-02"), "a los 29 días se sigue leyendo");
  assert(!cursoQuieto([{ curso: "Salud pública", titulo: "Sesión 16", fecha: "" }], "Salud pública", "2026-11-02"), "sin fecha no se calla");
  assert(!cursoQuieto([{ curso: "Otro curso largo", titulo: "Sesión 2", fecha: "2026-01-01" }], "Salud pública", "2026-11-02"), "el silencio es de ese curso");

  const pedidos = [];
  const callada = await entrarYLeer("ada", "secreta", async (url) => {
    const destino = String(url);
    pedidos.push(destino);
    if (destino.includes("/login/token.php")) return respuestaJson({ token: "a".repeat(32), privatetoken: "b".repeat(32) });
    if (destino.includes("core_webservice_get_site_info")) return respuestaJson({ userid: 3, fullname: "Ada" });
    if (destino.includes("core_enrol_get_users_courses")) {
      return respuestaJson([
        { id: 2, fullname: "Salud pública - B10", startdate: 10 },
        { id: 8, fullname: "Bases biológicas del comportamiento - B10", startdate: 9 },
      ]);
    }
    if (destino.includes("courseid=2") || destino.includes("courseids%5B0%5D=2") || destino.includes("value=2")) {
      throw new Error("no debía abrir el curso quieto");
    }
    if (destino.includes("core_course_get_courses_by_field")) return respuestaJson({ courses: [{}] });
    if (destino.includes("core_course_get_contents")) {
      return respuestaJson([
        { section: 15, name: "Sesión 15: Nueva", modules: [{ id: 15, modname: "zoom", name: "Zoom", url: `${SITIO}/mod/zoom/view.php?id=15` }] },
      ]);
    }
    if (destino.includes("core_calendar_get_action_events_by_courses")) return respuestaJson({ events: [] });
    if (destino.includes("core_calendar_get_calendar_events")) return respuestaJson({ events: [] });
    if (destino.includes("mod_page_get_pages_by_courses")) return respuestaJson({ pages: [] });
    if (destino.includes("mod_zoom_get_state")) return respuestaJson({ start_time: 0 });
    if (destino.includes("tool_mobile_get_autologin_key")) return respuestaJson({ key: "abc12345", autologinurl: `${SITIO}/admin/tool/mobile/autologin.php` });
    if (destino.includes("/autologin.php")) {
      return {
        status: 303,
        ok: false,
        headers: { get: (nombre) => ({ location: `${SITIO}/my/`, "set-cookie": "MoodleSession=abc; path=/" }[nombre] || null) },
        text: async () => "",
      };
    }
    if (destino.includes("/my/")) return { status: 200, ok: true, headers: { get: () => null }, text: async () => "ok" };
    if (destino.includes("/mod/zoom/recordings.php")) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => "https://ucv-edu-pe.zoom.us/rec/play/nueva15token",
      };
    }
    throw new Error(`llamada inesperada ${destino.split("?")[0]}`);
  }, {
    cortar: true,
    hoy: "2026-11-02",
    halladas: [
      { curso: "Salud pública", titulo: "Sesión 15", fecha: "2026-09-01" },
      { curso: "Salud pública", titulo: "Sesión 16", fecha: "2026-09-15" },
      { curso: "Bases biológicas del comportamiento", titulo: "Sesión 14", fecha: "2026-10-01" },
      { curso: "Bases biológicas del comportamiento", titulo: "Sesión 16", fecha: "2026-10-20" },
      { curso: "Bases biológicas del comportamiento", titulo: "Sesión 15", fecha: "2026-10-10" },
    ],
  });
  assert(!pedidos.some((url) => url.includes("courseid=2") || url.includes("value=2")), "el curso de hace un mes no se abre");
  assert(callada.zoom_lectura.quietos === 1, "cuenta el curso que no se escaneó");
  const salud = callada.cursos.find((curso) => curso.id === 2);
  const bases = callada.cursos.find((curso) => curso.id === 8);
  assert(salud && salud.sesiones.length === 0 && salud.aviso.includes("30 días"), "el curso quieto queda vacío");
  assert(bases && bases.sesiones.some((sesion) => sesion.numero === "15"), "el curso reciente sigue desde la penúltima");
}

async function leerDesdeEntrada() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    body = {};
  }
  const usuario = String(body.usuario || "").trim();
  const clave = String(body.clave || "");
  if (!usuario || !clave || usuario.length > 200 || clave.length > 200) {
    process.stdout.write(JSON.stringify({ error: "Escribe tu usuario y tu contraseña de Clementina." }));
    process.exit(1);
  }
  try {
    process.stdout.write(JSON.stringify(await entrarYLeer(usuario, clave, fetch, { cortar: true })));
  } catch (error) {
    const message = error && error.publico ? error.message : "No pude leer Clementina.";
    process.stdout.write(JSON.stringify({ error: message }));
    process.exit(1);
  }
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("linkeo-leer.mjs");
if (esMain && process.argv.includes("--leer")) {
  leerDesdeEntrada();
} else if (esMain) {
  selfTest().then(() => console.log("ok")).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
