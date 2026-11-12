// Reloj del escaneo. 12:00, 18:00 y 00:00 en Lima (UTC-5, sin horario de verano):
// 17:00, 23:00 y 05:00 UTC.
const ARCHIVO = "ajustes/linkeo-turno.json";
const LECTURA = "ajustes/linkeo-lectura.json";
const FRESCURA = 90;

export function env(nombre) {
  try {
    if (typeof Netlify !== "undefined" && Netlify.env) {
      const valor = Netlify.env.get(nombre);
      if (valor) return String(valor);
    }
  } catch {
    /* prueba local */
  }
  return String(process.env[nombre] || "");
}

export function idTurno(epoch) {
  const lima = new Date(Number(epoch) * 1000 - 5 * 3600 * 1000);
  const y = lima.getUTCFullYear();
  const m = String(lima.getUTCMonth() + 1).padStart(2, "0");
  const d = String(lima.getUTCDate()).padStart(2, "0");
  const h = String(lima.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${d}-${h}`;
}

export function decidir(presencia, ahora) {
  const pcEn = Number(presencia && presencia.pc_en) || 0;
  const listo = !!(presencia && presencia.listo);
  if (listo && pcEn > 0 && Number(ahora) - pcEn <= FRESCURA) return "pc";
  return "web";
}

export function siguienteTurno(actual, decision, ahora, id) {
  const turno = actual && actual.turno;
  const edad = turno ? Number(ahora) - Number(turno.creado || 0) : 999999;
  const estado = turno && turno.estado;
  if (turno && (estado === "pedido" || estado === "en-pc" || estado === "web") && edad < 3 * 3600) {
    return { accion: "espera", turno };
  }
  if (turno && estado === "subiendo") {
    const pulso = Number(turno.ocupado) || Number(turno.creado) || 0;
    if (Number(ahora) - pulso < 45 * 60) return { accion: "espera", turno };
  }
  if (turno && turno.id === id && (turno.estado === "hecho" || turno.estado === "leido-web")) {
    return { accion: "ya", turno };
  }
  if (decision === "pc") {
    return { accion: "pedir", turno: { id, estado: "pedido", creado: Number(ahora), donde: "pc" } };
  }
  return { accion: "web", turno: { id, estado: "web", creado: Number(ahora), donde: "web" } };
}

function credenciales() {
  return {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    secret: env("SUPABASE_SERVICE_ROLE"),
  };
}

export async function leerNube(pedir = fetch) {
  const { url, secret } = credenciales();
  if (!url || !secret) return {};
  const response = await pedir(`${url}/storage/v1/object/diapositivas/${ARCHIVO}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  if (response.status === 400 || response.status === 404) return {};
  if (!response.ok) return {};
  const data = await response.json().catch(() => ({}));
  return data && typeof data === "object" ? data : {};
}

export async function guardarNube(data, pedir = fetch) {
  const { url, secret } = credenciales();
  if (!url || !secret) return false;
  const response = await pedir(`${url}/storage/v1/object/diapositivas/${ARCHIVO}`, {
    method: "POST",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: JSON.stringify(data),
  });
  return response.ok;
}

export async function guardarLectura(data, pedir = fetch) {
  const { url, secret } = credenciales();
  if (!url || !secret) return false;
  const response = await pedir(`${url}/storage/v1/object/diapositivas/${LECTURA}`, {
    method: "POST",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/octet-stream",
      "x-upsert": "true",
    },
    body: JSON.stringify(data),
  });
  return response.ok;
}

export async function leerLectura(pedir = fetch) {
  const { url, secret } = credenciales();
  if (!url || !secret) return {};
  const response = await pedir(`${url}/storage/v1/object/diapositivas/${LECTURA}`, {
    headers: { apikey: secret, Authorization: `Bearer ${secret}` },
  });
  if (response.status === 400 || response.status === 404) return {};
  if (!response.ok) return {};
  const data = await response.json().catch(() => ({}));
  return data && typeof data === "object" ? data : {};
}

export async function borrarLectura(pedir = fetch) {
  const { url, secret } = credenciales();
  if (!url || !secret) return false;
  const response = await pedir(`${url}/storage/v1/object/diapositivas`, {
    method: "DELETE",
    headers: {
      apikey: secret,
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [LECTURA] }),
  });
  return response.ok || response.status === 404;
}

function mismo(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function autorizado(header, secret) {
  return mismo(header, secret);
}

async function avisarMes(epoch) {
  const lima = new Date(Number(epoch) * 1000 - 5 * 3600 * 1000);
  if (lima.getUTCDate() < 5) return;
  const { corteMes } = await import("./linkeo-mes.mjs");
  if (!corteMes(epoch).actuar) return;
  const sitio = env("URL").replace(/\/$/, "");
  const secret = env("SUPABASE_SERVICE_ROLE");
  if (!sitio || !secret) return;
  await fetch(`${sitio}/linkeo-mes`, {
    method: "POST",
    headers: { "x-linkeo-turno": secret },
  }).catch(() => {});
}

export default async (req) => {
  const ahora = Math.floor(Date.now() / 1000);
  const actual = await leerNube();
  const decision = decidir(actual, ahora);
  const paso = siguienteTurno(actual, decision, ahora, idTurno(ahora));
  const presencia = { pc_en: Number(actual.pc_en) || 0, listo: !!actual.listo, turno: paso.turno };
  if (paso.accion === "pedir") await guardarNube(presencia);
  if (paso.accion === "web") {
    const usuario = env("LINKEO_USUARIO").trim();
    const clave = env("LINKEO_CLAVE");
    const sitio = env("URL").replace(/\/$/, "");
    const secret = env("SUPABASE_SERVICE_ROLE");
    if (!usuario || !clave || !sitio || !secret) {
      presencia.turno = { ...paso.turno, estado: "sinclave" };
      await guardarNube(presencia);
      await avisarMes(ahora);
      return Response.json({ donde: "web", motivo: "sinclave" });
    }
    await guardarNube(presencia);
    await fetch(`${sitio}/linkeo-turno-web`, {
      method: "POST",
      headers: { "x-linkeo-turno": secret },
    }).catch(() => {});
  }
  await avisarMes(ahora);
  return Response.json({ donde: paso.accion === "pedir" ? "pc" : paso.accion, id: paso.turno && paso.turno.id });
};

export const config = {
  // 00:00, 12:00 y 18:00 en America/Lima.
  schedule: "0 5,17,23 * * *",
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function selfTest() {
  const mediodia = Date.parse("2026-11-02T17:00:00Z") / 1000;
  assert(idTurno(mediodia) === "2026-11-02-12", "mediodía en Lima");
  assert(idTurno(Date.parse("2026-11-03T05:00:00Z") / 1000) === "2026-11-03-00", "medianoche en Lima");
  assert(idTurno(Date.parse("2026-11-02T23:00:00Z") / 1000) === "2026-11-02-18", "tarde en Lima");
  assert(decidir({ pc_en: 1000, listo: true }, 1080) === "pc", "la PC reciente recibe la orden");
  assert(decidir({ pc_en: 1000, listo: true }, 1200) === "web", "la PC apagada pasa a la web");
  assert(decidir({ pc_en: 1000, listo: false }, 1010) === "web", "sin acceso local pasa a la web");
  const pedido = siguienteTurno({}, "pc", 2000, "2026-11-02-12");
  assert(pedido.accion === "pedir" && pedido.turno.donde === "pc" && pedido.turno.estado === "pedido", "pide a la PC");
  assert(siguienteTurno({ turno: pedido.turno }, "web", 2100, "2026-11-02-12").accion === "espera", "no pisa un pedido vivo");
  assert(siguienteTurno({ turno: { id: "2026-11-02-12", estado: "subiendo", creado: 2000 } }, "web", 2100, "2026-11-02-18").accion === "espera", "no pisa una subida de la web");
  assert(siguienteTurno({ turno: { id: "2026-11-02-12", estado: "subiendo", creado: 2000 } }, "web", 2000 + 50 * 60, "2026-11-02-18").accion === "web", "una subida quieta no bloquea el turno");
  assert(siguienteTurno({ turno: { id: "2026-11-02-12", estado: "subiendo", creado: 2000, ocupado: 2000 + 40 * 60 } }, "web", 2000 + 50 * 60, "2026-11-02-18").accion === "espera", "una subida con pulso sigue");
  assert(siguienteTurno({ turno: { id: "2026-11-02-12", estado: "hecho", creado: 2000 } }, "pc", 9000, "2026-11-02-12").accion === "ya", "no repite el turno");
  assert(siguienteTurno({ turno: { id: "viejo", estado: "hecho", creado: 1 } }, "web", 9000, "2026-11-02-18").accion === "web", "la web lee si no hay PC");
  assert(autorizado("abc", "abc") && !autorizado("abc", "abd") && !autorizado("", "abc"), "la orden web pide la clave interna");
  const cuerpo = JSON.stringify(pedido);
  assert(!cuerpo.includes("clave") && !cuerpo.includes("password"), "el turno no guarda la contraseña");
  console.log("ok");
}

const esMain = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("linkeo-turno.mjs");
if (esMain) selfTest();
