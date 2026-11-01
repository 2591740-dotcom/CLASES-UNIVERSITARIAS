import { entrarYLeer } from "./linkeo-leer.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "No pude leer Clementina." }, { status: 405 });
  }
  let body = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const usuario = String(body.usuario || "").trim();
  const clave = String(body.clave || "");
  if (!usuario || !clave || usuario.length > 200 || clave.length > 200) {
    return Response.json({ error: "Escribe tu usuario y tu contraseña de Clementina." }, { status: 400 });
  }
  try {
    return Response.json(await entrarYLeer(usuario, clave));
  } catch (error) {
    const publico = error && error.publico;
    return Response.json(
      { error: publico ? error.message : "No pude leer Clementina." },
      { status: publico && error.status ? error.status : 502 },
    );
  }
};
