const HOSTS = {
  "api.x.ai": ["/v1/chat/completions"],
  "api.openai.com": ["/v1/chat/completions"],
  "generativelanguage.googleapis.com": ["/v1beta/openai/chat/completions"],
  "api.mistral.ai": ["/v1/chat/completions"],
  "api.groq.com": ["/openai/v1/chat/completions"],
  "openrouter.ai": ["/api/v1/chat/completions"],
  "api.anthropic.com": ["/v1/messages"],
};

const blocked = "Ese proveedor no está disponible desde la página.";

export function checkTarget(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return { ok: false, message: blocked };
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, message: blocked };
  }
  const paths = HOSTS[parsed.hostname];
  if (!paths || !paths.includes(parsed.pathname)) return { ok: false, message: blocked };
  return { ok: true, url: parsed.origin + parsed.pathname };
}

function pickHeaders(input) {
  const source = input && typeof input === "object" ? input : {};
  const headers = { "Content-Type": "application/json" };
  const auth = String(source.Authorization || source.authorization || "");
  const key = String(source["x-api-key"] || source["X-Api-Key"] || "");
  const version = String(source["anthropic-version"] || source["Anthropic-Version"] || "");
  if (auth) {
    if (!/^Bearer \S{8,400}$/.test(auth)) return null;
    headers.Authorization = auth;
  }
  if (key) {
    if (!/^\S{8,400}$/.test(key)) return null;
    headers["x-api-key"] = key;
  }
  if (version) {
    if (version !== "2023-06-01") return null;
    headers["anthropic-version"] = version;
  }
  if (!headers.Authorization && !headers["x-api-key"]) return null;
  return headers;
}

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: { message: "No pude enviar la pregunta." } }, { status: 405 });
  }
  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: { message: "No pude leer la pregunta." } }, { status: 400 });
  }
  const target = checkTarget(payload && payload.url);
  if (!target.ok) return Response.json({ error: { message: target.message } }, { status: 400 });
  const headers = pickHeaders(payload.headers);
  if (!headers) return Response.json({ error: { message: "No pude enviar la pregunta." } }, { status: 400 });
  const encoded = JSON.stringify(payload.body ?? {});
  if (encoded.length > 5000000) {
    return Response.json({ error: { message: "La pregunta es demasiado larga." } }, { status: 413 });
  }
  try {
    const upstream = await fetch(target.url, {
      method: "POST",
      headers,
      body: encoded,
      signal: AbortSignal.timeout(50000),
    });
    const text = await upstream.text();
    return new Response(text || "{}", {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  } catch {
    return Response.json({ error: { message: "La IA no respondió." } }, { status: 502 });
  }
};
