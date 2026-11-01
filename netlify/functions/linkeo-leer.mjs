/** Lee Mis cursos de Clementina (Moodle en uvcv.edu.pe) y no guarda la contraseña. */

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

async function pedirJson(url, options, pedir) {
  let response;
  try {
    response = await pedir(url, {
      ...options,
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
    data = JSON.parse(text);
  } catch {
    throw new Fallo("Clementina contestó algo que no pude leer.");
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
  return token;
}

async function ws(token, funcion, campos, pedir) {
  const params = new URLSearchParams({
    wstoken: token,
    wsfunction: funcion,
    moodlewsrestformat: "json",
  });
  for (const [key, value] of Object.entries(campos || {})) aplanar(key, value, params);
  return pedirJson(`${SITIO}/webservice/rest/server.php?${params}`, { method: "GET" }, pedir);
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
  const re = /(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?/gi;
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

function enlacesDe(mod) {
  const vistos = new Set();
  const lista = [];
  const agregar = (crudo, nombre) => {
    const url = String(crudo || "").replace(/[),.;]+$/, "");
    if (!url.startsWith("https://") || url.length > 500 || vistos.has(url)) return;
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

function sesionDe(nombre) {
  const limpio = textoPlano(nombre);
  const marcada = limpio.match(/(?:sesi[oó]n|semana|clase)\s*(?:n[°ºo.]*)?\s*0*(\d{1,3})\b/i);
  if (marcada) {
    const titulo = limpio.slice(marcada.index + marcada[0].length).replace(/^[\s.:\-–]+/, "").trim();
    return { numero: String(Number(marcada[1])), titulo };
  }
  const inicial = limpio.match(/^0*(\d{1,3})\b[\s.:\-–)]+(.*)$/);
  if (inicial && Number(inicial[1]) > 0 && Number(inicial[1]) <= 40) {
    return { numero: String(Number(inicial[1])), titulo: inicial[2].trim() };
  }
  return { numero: "", titulo: limpio };
}

function tituloDeModulos(mods) {
  for (const mod of mods || []) {
    const nombre = textoPlano(mod.name);
    if (!nombre || GENERICOS.test(nombre)) continue;
    if (/^(sesi[oó]n|semana|clase)\s+\d+$/i.test(nombre)) continue;
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

export function sesionesDe(secciones, eventos) {
  const sesiones = [];
  for (const seccion of secciones || []) {
    if (!seccion || typeof seccion !== "object") continue;
    const partes = sesionDe(seccion.name);
    const esPortada = Number(seccion.section) === 0 && !partes.numero;
    if (esPortada) continue;
    const mods = Array.isArray(seccion.modules) ? seccion.modules : [];
    const titulo = (partes.titulo || tituloDeModulos(mods) || partes.numero && `Sesión ${partes.numero}` || textoPlano(seccion.name)).slice(0, 180);
    if (!titulo && !mods.length) continue;
    const cita = eventosDe(seccion, eventos)[0];
    const corpus = [
      seccion.name,
      seccion.summary,
      ...mods.flatMap((mod) => [mod.name, mod.description]),
    ].map(textoPlano).join(" ");
    const iso = cita ? fechaDeUnix(Number(cita.timestart) || 0) : fechaDeTexto(corpus);
    const hora = cita ? horaDeEvento(cita) : horaDeTexto(corpus);
    const enlaces = mods.flatMap(enlacesDe).filter((item, index, lista) => (
      lista.findIndex((otro) => otro.url === item.url) === index
    )).slice(0, 6);
    if (!titulo && !iso && !enlaces.length) continue;
    sesiones.push({
      numero: partes.numero,
      titulo: titulo || "Sesión",
      fecha: iso ? fechaBonita(iso) : "",
      hora,
      orden: iso ? `${iso}T${hora.slice(0, 5) || "00:00"}` : "",
      enlaces,
    });
  }
  sesiones.sort((a, b) => {
    const na = Number(a.numero) || 999;
    const nb = Number(b.numero) || 999;
    if (na !== nb) return na - nb;
    return a.orden.localeCompare(b.orden);
  });
  return sesiones.slice(0, 80).map(({ orden, ...sesion }) => sesion);
}

export function armarCurso(curso, ficha, secciones, eventos, aviso) {
  const nombre = textoPlano((curso && (curso.fullname || curso.displayname || curso.shortname)) || "Curso").slice(0, 180);
  return {
    id: Number(curso && curso.id) || 0,
    nombre,
    profesor: profesorDe(curso, ficha).slice(0, 160),
    aviso: aviso || "",
    sesiones: Array.isArray(secciones) ? sesionesDe(secciones, eventos) : [],
  };
}

async function seguro(promesa) {
  try {
    return await promesa;
  } catch {
    return null;
  }
}

export async function entrarYLeer(usuario, clave, pedir = fetch) {
  const token = await tokenDe(usuario, clave, pedir);
  const sitio = await ws(token, "core_webservice_get_site_info", {}, pedir);
  const userid = Number(sitio && sitio.userid) || 0;
  if (!userid) throw new Fallo("Clementina no dijo quién entró.");
  const lista = await ws(token, "core_enrol_get_users_courses", { userid }, pedir);
  if (!Array.isArray(lista)) throw new Fallo("Clementina no entregó los cursos.");
  const cursos = lista
    .filter((curso) => curso && curso.id)
    .sort((a, b) => Number(b.startdate || 0) - Number(a.startdate || 0))
    .slice(0, 40);
  const armados = await mapa(cursos, 4, async (curso) => {
    const [detalle, secciones, calendario] = await Promise.all([
      seguro(ws(token, "core_course_get_courses_by_field", { field: "id", value: curso.id }, pedir)),
      seguro(ws(token, "core_course_get_contents", { courseid: curso.id }, pedir)),
      seguro(ws(token, "core_calendar_get_action_events_by_courses", {
        courseids: [curso.id],
        timesortfrom: 0,
        limitnum: 80,
      }, pedir)),
    ]);
    const ficha = detalle && Array.isArray(detalle.courses) ? detalle.courses[0] : null;
    const eventos = calendario && Array.isArray(calendario.events) ? calendario.events : [];
    const aviso = Array.isArray(secciones) ? "" : "No pude abrir las sesiones de este curso.";
    return armarCurso(curso, ficha, secciones, eventos, aviso);
  });
  return {
    sitio: SITIO,
    cuenta: textoPlano(sitio.fullname).slice(0, 120),
    cursos: armados,
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
  assert(curso.sesiones[0].hora === "19:00–21:00", "hora texto");
  assert(curso.sesiones[1].numero === "4", "numero 4");
  assert(curso.sesiones[1].titulo === "Bases biológicas del lenguaje", "titulo 4");
  assert(curso.sesiones[1].fecha === "6 de noviembre de 2026", "fecha calendario");
  assert(curso.sesiones[1].hora === "19:00–21:00", "hora calendario");
  assert(curso.sesiones[1].enlaces.length === 1 && curso.sesiones[1].enlaces[0].zoom, "zoom");
  assert(!curso.sesiones.some((item) => item.titulo === "General"), "portada");

  const leido = await entrarYLeer("ada", "secreta", async (url, options) => {
    const destino = String(url);
    assert(!destino.includes("secreta"), "la clave no viaja en la dirección");
    if (destino.includes("/login/token.php")) {
      assert(options.body.get("username") === "ada", "usuario");
      assert(options.body.get("password") === "secreta", "clave");
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
    throw new Error(`llamada inesperada ${destino}`);
  });
  assert(leido.cuenta === "Ada", "cuenta");
  assert(leido.cursos[0].profesor === "Ana Pérez", "profesor leído");
  assert(leido.cursos[0].sesiones[0].numero === "2", "sesión leída");
  assert(leido.cursos[0].sesiones[0].titulo === "Apego", "título leído");
  assert(leido.cursos[0].sesiones[0].fecha === "6 de noviembre de 2026", "fecha leída");
  assert(leido.cursos[0].sesiones[0].hora === "19:00", "hora leída");

  try {
    await entrarYLeer("ada", "mala", async () => respuestaJson({ error: "Invalid login", errorcode: "invalidlogin" }));
    assert(false, "debió rechazar la clave");
  } catch (error) {
    assert(error.publico && error.message.includes("no aceptó") && !error.message.includes("mala"), "aviso de clave");
  }
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("linkeo-leer.mjs");
if (esMain) {
  selfTest().then(() => console.log("ok")).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
