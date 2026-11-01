function adminHeaders(secret) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
  };
}

function tituloDe(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim().slice(0, 100);
  return name || "Clase";
}

function bytesDe(value) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1000 || bytes > 2500000000) return 0;
  return bytes;
}

function tipoDe(value) {
  const tipo = String(value || "").toLowerCase();
  if (tipo.startsWith("video/") || tipo.startsWith("audio/")) return tipo.slice(0, 80);
  return "video/mp4";
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

async function cuentaActiva(url, secret, email) {
  const response = await fetch(
    `${url}/rest/v1/cuentas?email=eq.${encodeURIComponent(email)}&select=activo`,
    { headers: { ...adminHeaders(secret), Accept: "application/json" } },
  );
  const rows = await response.json().catch(() => null);
  return response.ok && Array.isArray(rows) && rows[0] && rows[0].activo === true;
}

async function credenciales(url, secret) {
  const response = await fetch(`${url}/storage/v1/object/claseclara_privado/youtube.json`, {
    headers: adminHeaders(secret),
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

function cuerpoVideo(titulo) {
  return {
    snippet: {
      title: titulo,
      description: "ClaseClara",
      categoryId: "27",
    },
    status: {
      privacyStatus: "unlisted",
      embeddable: true,
      selfDeclaredMadeForKids: false,
    },
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "No pude abrir YouTube." }, { status: 405 });
  }
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const anon = (process.env.SUPABASE_ANON_KEY || "").trim();
  const secret = (process.env.SUPABASE_SERVICE_ROLE || "").trim();
  if (!url || !anon || !secret) {
    return Response.json({ error: "Falta conectar YouTube." }, { status: 500 });
  }
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const token = String(req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const email = await correoDe(url, anon, token);
  if (!email || !await cuentaActiva(url, secret, email)) {
    return Response.json({ error: "Entra de nuevo para subir el video." }, { status: 401 });
  }
  const bytes = bytesDe(body.bytes);
  if (!bytes) return Response.json({ error: "Ese video no se puede subir." }, { status: 400 });
  const cred = await credenciales(url, secret);
  if (!cred) return Response.json({ error: "Falta conectar YouTube." }, { status: 500 });
  const access = await accesoGoogle(cred);
  if (!access) return Response.json({ error: "YouTube no aceptó la cuenta." }, { status: 502 });
  const open = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(bytes),
        "X-Upload-Content-Type": tipoDe(body.tipo),
      },
      body: JSON.stringify(cuerpoVideo(tituloDe(body.titulo))),
    },
  );
  const location = open.headers.get("location") || "";
  if (!location.startsWith("https://") || !location.includes("googleapis.com")) {
    return Response.json({ error: "YouTube no abrió la subida." }, { status: 502 });
  }
  return Response.json({ url: location });
};
