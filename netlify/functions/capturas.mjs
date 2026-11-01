function adminHeaders(secret) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
  };
}

function idDe(value) {
  const id = String(value || "");
  return /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/.test(id) ? id : "";
}

function videoDe(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
}

function tiempoDe(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0 || time > 200000) return 0;
  return Math.round(time * 100) / 100;
}

function duracionDe(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0 || time > 200000) return 0;
  return time;
}

function jpegDe(value) {
  const raw = String(value || "").trim();
  const text = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
  const clean = text.replace(/\s+/g, "");
  if (clean.length < 500 || clean.length > 400000) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  let bytes;
  try { bytes = Buffer.from(clean, "base64"); } catch { return null; }
  if (bytes.length < 300 || bytes.length > 280000) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes;
}

async function correoDe(url, anon, token) {
  if (!token || token.length < 20 || token.length > 4000) return "";
  const response = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: anon, Authorization: `Bearer ${token}` },
  });
  const data = await response.json().catch(() => ({}));
  const email = String(data.email || "").trim().toLowerCase();
  if (!response.ok || !email) return "";
  return email;
}

async function cuentaDe(url, secret, email) {
  const response = await fetch(
    `${url}/rest/v1/cuentas?email=eq.${encodeURIComponent(email)}&select=activo,universidad,carrera`,
    { headers: { ...adminHeaders(secret), Accept: "application/json" } },
  );
  const rows = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rows) || !rows[0] || rows[0].activo !== true) return null;
  const universidad = String(rows[0].universidad || "");
  const carrera = String(rows[0].carrera || "");
  if (!universidad || !carrera) return null;
  return { universidad, carrera };
}

async function claseDe(url, secret, id) {
  const response = await fetch(
    `${url}/rest/v1/clases?id=eq.${encodeURIComponent(id)}&select=id,universidad,carrera`,
    { headers: { ...adminHeaders(secret), Accept: "application/json" } },
  );
  const rows = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(rows) || !rows[0]) return null;
  return rows[0];
}

async function subirJpeg(url, secret, path, bytes) {
  const response = await fetch(`${url}/storage/v1/object/diapositivas/${path}`, {
    method: "POST",
    headers: {
      ...adminHeaders(secret),
      "Content-Type": "image/jpeg",
      "x-upsert": "true",
    },
    body: bytes,
  });
  return response.ok;
}

function firmaDe(bytes) {
  const last = bytes.length > 24 ? bytes.subarray(bytes.length - 16) : bytes;
  return `${bytes.length}:${bytes[3]}:${bytes[20] || 0}:${last[0]}:${last[last.length - 1]}`;
}

async function miniaturasDe(video, duracion) {
  const loaded = await Promise.all([0, 1, 2, 3].map(async (index) => {
    try {
      const response = await fetch(`https://i.ytimg.com/vi/${video}/${index}.jpg`);
      if (!response.ok) return null;
      if (!String(response.url || "").startsWith("https://i.ytimg.com/")) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 3000 || bytes.length > 280000) return null;
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
      return { index, bytes, firma: firmaDe(bytes) };
    } catch {
      return null;
    }
  }));
  const seen = new Set();
  const found = [];
  for (const item of loaded) {
    if (!item || seen.has(item.firma)) continue;
    seen.add(item.firma);
    found.push(item);
  }
  found.sort((a, b) => a.index - b.index);
  const total = found.length;
  return found.map((item, index) => ({
    bytes: item.bytes,
    tiempo: duracion && total ? tiempoDe(duracion * ((index + 0.5) / total)) : 0,
  }));
}

async function guardarFilas(url, secret, id, rows) {
  const deleted = await fetch(`${url}/rest/v1/diapositivas?clase_id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...adminHeaders(secret), Prefer: "return=minimal" },
  });
  if (!deleted.ok) return false;
  const inserted = await fetch(`${url}/rest/v1/diapositivas`, {
    method: "POST",
    headers: {
      ...adminHeaders(secret),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  return inserted.ok;
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "No pude guardar las capturas." }, { status: 405 });
  }
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const anon = (process.env.SUPABASE_ANON_KEY || "").trim();
  const secret = (process.env.SUPABASE_SERVICE_ROLE || "").trim();
  if (!url || !anon || !secret) {
    return Response.json({ error: "No pude guardar las capturas." }, { status: 500 });
  }
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const token = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const email = await correoDe(url, anon, token);
  const cuenta = email ? await cuentaDe(url, secret, email) : null;
  if (!cuenta) {
    return Response.json({ error: "Entra de nuevo para guardar las capturas." }, { status: 401 });
  }
  const id = idDe(body.id);
  if (!id) return Response.json({ error: "Esas capturas no se pueden guardar." }, { status: 400 });
  const clase = await claseDe(url, secret, id);
  if (!clase) return Response.json({ error: "No encuentro esa clase." }, { status: 404 });
  if (clase.universidad !== cuenta.universidad || clase.carrera !== cuenta.carrera) {
    return Response.json({ error: "Esa clase no es de esta carrera." }, { status: 403 });
  }
  const lista = Array.isArray(body.capturas) ? body.capturas.slice(0, 8) : [];
  let imagenes = [];
  for (const item of lista) {
    const bytes = jpegDe(item && item.jpeg);
    if (!bytes) continue;
    imagenes.push({ bytes, tiempo: tiempoDe(item && item.tiempo) });
  }
  if (!imagenes.length) {
    const video = videoDe(body.video);
    if (video) imagenes = await miniaturasDe(video, duracionDe(body.duracion));
  }
  if (!imagenes.length) return Response.json({ guardadas: 0 });
  const rows = [];
  const subidas = await Promise.all(imagenes.map(async (item, index) => {
    const name = `${id}/${String(index + 1).padStart(2, "0")}.jpg`;
    const ok = await subirJpeg(url, secret, name, item.bytes);
    if (ok) {
      rows.push({
        clase_id: id,
        orden: index + 1,
        tiempo: item.tiempo,
        imagen_path: name,
      });
    }
    return ok;
  }));
  if (subidas.some((ok) => !ok) || rows.length !== imagenes.length) {
    return Response.json({ error: "No pude guardar las capturas." }, { status: 502 });
  }
  rows.sort((a, b) => a.orden - b.orden);
  if (!await guardarFilas(url, secret, id, rows)) {
    return Response.json({ error: "No pude guardar las capturas." }, { status: 502 });
  }
  return Response.json({ guardadas: rows.length });
};
