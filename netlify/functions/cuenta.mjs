async function marcaDe(clave) {
  const bytes = new TextEncoder().encode(`claseclara:${clave}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function correoDe(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 160) return "";
  return email;
}

function adminHeaders(secret) {
  return {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

function bloqueado(user) {
  if (!user || !user.banned_until) return false;
  const until = Date.parse(user.banned_until);
  return Number.isFinite(until) && until > Date.now();
}

function prohibido(data) {
  return data.error === "user_banned" || data.error_code === "user_banned" || data.msg === "User is banned";
}

async function users(url, secret) {
  const response = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: adminHeaders(secret),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.users)) throw new Error("lista");
  return data.users;
}

async function filaDe(url, secret, email) {
  const response = await fetch(
    `${url}/rest/v1/cuentas?email=eq.${encodeURIComponent(email)}&select=email,activo`,
    { headers: { ...adminHeaders(secret), Accept: "application/json" } },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data)) throw new Error("tabla");
  return data[0] || null;
}

async function anotar(url, secret, email) {
  const response = await fetch(`${url}/rest/v1/cuentas`, {
    method: "POST",
    headers: { ...adminHeaders(secret), Prefer: "return=minimal" },
    body: JSON.stringify({ email, activo: false }),
  });
  if (response.status === 409) return "existe";
  if (!response.ok) throw new Error("tabla");
  return "ok";
}

async function borrarUsuario(url, secret, id) {
  const response = await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: adminHeaders(secret),
  });
  if (!response.ok) throw new Error("auth");
}

async function crearUsuario(url, secret, email, clave) {
  const response = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(secret),
    body: JSON.stringify({
      email,
      password: clave,
      email_confirm: true,
      ban_duration: "876000h",
      app_metadata: { marca: await marcaDe(clave) },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw new Error("auth");
  return data.id;
}

async function ponerBan(url, secret, id, bloquear) {
  await fetch(`${url}/auth/v1/admin/users/${id}`, {
    method: "PUT",
    headers: adminHeaders(secret),
    body: JSON.stringify({ ban_duration: bloquear ? "876000h" : "none" }),
  });
}

async function cerrarSesiones(url, secret, id) {
  await fetch(`${url}/auth/v1/admin/users/${id}/logout`, {
    method: "POST",
    headers: adminHeaders(secret),
    body: JSON.stringify({ scope: "global" }),
  });
}

async function entrarConClave(url, anon, email, clave) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: clave }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

function sesion(data) {
  return {
    estado: "ok",
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ estado: "no" }, { status: 405 });
  }
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const anon = (process.env.SUPABASE_ANON_KEY || "").trim();
  const secret = (process.env.SUPABASE_SERVICE_ROLE || "").trim();
  if (!url || !anon || !secret) {
    return Response.json({ estado: "no", aviso: "Falta la cuenta del sitio." }, { status: 500 });
  }
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const accion = body.accion === "crear" ? "crear" : "entrar";
  const email = correoDe(body.email);
  const clave = String(body.clave || "");
  if (!email) return Response.json({ estado: "correo" });
  if (clave.length < 6 || clave.length > 200) return Response.json({ estado: "corta" });
  const reservado = email === (process.env.SUPABASE_EMAIL || "").trim().toLowerCase();

  let lista;
  try {
    lista = await users(url, secret);
  } catch {
    return Response.json({ estado: "no", aviso: "No pude revisar las cuentas." }, { status: 502 });
  }
  const ya = lista.find((user) => String(user.email || "").toLowerCase() === email);

  let fila;
  try {
    fila = await filaDe(url, secret, email);
  } catch {
    return Response.json({ estado: "no", aviso: "No pude revisar el permiso." }, { status: 502 });
  }

  if (accion === "crear") {
    if (reservado || fila) return Response.json({ estado: "existe" });
    let id = "";
    try {
      if (ya) await borrarUsuario(url, secret, ya.id);
      id = await crearUsuario(url, secret, email, clave);
      const anotado = await anotar(url, secret, email);
      if (anotado === "existe") {
        await borrarUsuario(url, secret, id).catch(() => {});
        return Response.json({ estado: "existe" });
      }
    } catch {
      if (id) await borrarUsuario(url, secret, id).catch(() => {});
      return Response.json({ estado: "no", aviso: "No pude anotar el correo." }, { status: 502 });
    }
    return Response.json({ estado: "pendiente" });
  }

  if (!fila) return Response.json({ estado: "no" });
  const marca = ya && ya.app_metadata && ya.app_metadata.marca;
  const coincide = !marca || marca === await marcaDe(clave);
  if (!fila.activo) {
    if (ya && !reservado) {
      await ponerBan(url, secret, ya.id, true);
      await cerrarSesiones(url, secret, ya.id);
    }
    if (ya && !coincide) return Response.json({ estado: "mal" });
    return Response.json({ estado: "pendiente" });
  }
  if (!ya || !coincide) return Response.json({ estado: "mal" });
  if (!reservado && bloqueado(ya)) await ponerBan(url, secret, ya.id, false);
  let login = await entrarConClave(url, anon, email, clave);
  if (!(login.ok && login.data.access_token) && prohibido(login.data) && !reservado) {
    await ponerBan(url, secret, ya.id, false);
    login = await entrarConClave(url, anon, email, clave);
  }
  if (login.ok && login.data.access_token) return Response.json(sesion(login.data));
  if (prohibido(login.data)) return Response.json({ estado: "pendiente" });
  return Response.json({ estado: "mal" });
};
