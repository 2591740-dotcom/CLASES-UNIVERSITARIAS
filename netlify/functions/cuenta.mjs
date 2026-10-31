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

async function users(url, secret) {
  const response = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: adminHeaders(secret),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.users)) {
    throw new Error("lista");
  }
  return data.users;
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ estado: "no" }, { status: 405 });
  }
  const url = (process.env.SUPABASE_URL || "").trim();
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

  let lista;
  try {
    lista = await users(url, secret);
  } catch {
    return Response.json({ estado: "no", aviso: "No pude revisar las cuentas." }, { status: 502 });
  }
  const ya = lista.find((user) => String(user.email || "").toLowerCase() === email);

  if (accion === "crear") {
    if (ya) return Response.json({ estado: "existe" });
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
    if (!response.ok) return Response.json({ estado: "no" }, { status: 502 });
    return Response.json({ estado: "pendiente" });
  }

  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: clave }),
  });
  const data = await login.json().catch(() => ({}));
  if (login.ok && data.access_token) {
    return Response.json({
      estado: "ok",
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    });
  }
  if (!ya) return Response.json({ estado: "no" });
  if (data.error === "user_banned" || data.error_code === "user_banned" || data.msg === "User is banned") {
    const marca = ya.app_metadata && ya.app_metadata.marca;
    if (marca && marca !== await marcaDe(clave)) return Response.json({ estado: "mal" });
    return Response.json({ estado: "pendiente" });
  }
  return Response.json({ estado: "mal" });
};
