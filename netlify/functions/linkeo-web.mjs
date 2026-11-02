import { entrarYLeer } from "./linkeo-leer.mjs";
import {
  autorizado,
  borrarLectura,
  env,
  guardarLectura,
  guardarNube,
  leerLectura,
  leerNube,
} from "./linkeo-turno.mjs";
import { subirUna } from "./linkeo-subir.mjs";

function presencia(actual, turno) {
  return {
    pc_en: Number(actual.pc_en) || 0,
    listo: !!actual.listo,
    turno,
  };
}

export default async (req) => {
  const secret = env("SUPABASE_SERVICE_ROLE");
  if (!autorizado(req.headers.get("x-linkeo-turno"), secret)) {
    return new Response(null, { status: 401 });
  }
  const ahora = Math.floor(Date.now() / 1000);
  const actual = await leerNube();
  const turno = actual.turno && typeof actual.turno === "object" ? actual.turno : {};
  const cadena = req.headers.get("x-linkeo-sigue") === "1";
  if (!cadena && turno.estado === "subiendo" && turno.ocupado && ahora - Number(turno.ocupado) < 16 * 60) {
    return Response.json({ donde: "web", motivo: "ocupa" });
  }
  let lectura = await leerLectura();
  const sigue = turno.estado === "subiendo" && Array.isArray(lectura.cursos);
  if (!sigue) {
    const usuario = env("LINKEO_USUARIO").trim();
    const clave = env("LINKEO_CLAVE");
    if (!usuario || !clave) {
      await guardarNube(presencia(actual, { ...turno, estado: "sinclave", donde: "web" }));
      return Response.json({ donde: "web", motivo: "sinclave" });
    }
    try {
      const data = await entrarYLeer(usuario, clave, fetch, { cortar: true });
      lectura = {
        cursos: Array.isArray(data.cursos) ? data.cursos : [],
        omitidos: [],
        propias: [],
        cuenta: data.cuenta || "",
        zoom_lectura: data.zoom_lectura || {},
      };
      await guardarLectura(lectura);
    } catch {
      await guardarNube(presencia(actual, { ...turno, estado: "error", donde: "web" }));
      return Response.json({ donde: "web", motivo: "error" });
    }
  }
  await guardarNube(presencia(actual, {
    ...turno,
    estado: "subiendo",
    donde: "web",
    ocupado: ahora,
  }));
  const resultado = await subirUna(lectura, ahora);
  const subidas = Number(turno.subidas || 0) + Number(resultado.subidas || 0);
  const avisos = Number(turno.avisos || 0) + Number(resultado.avisos || 0);
  const ya = Number(resultado.ya || 0);
  if (resultado.lectura) await guardarLectura(resultado.lectura);
  const base = {
    id: turno.id,
    donde: "web",
    creado: turno.creado || ahora,
    subidas,
    ya,
    avisos,
  };
  const parar = resultado.hecho
    || resultado.motivo === "cuota"
    || resultado.motivo === "sinyoutube"
    || resultado.motivo === "nube"
    || resultado.motivo === "sinia";
  if (parar) {
    await borrarLectura();
    await guardarNube(presencia(actual, { ...base, estado: resultado.motivo ? "error" : "hecho" }));
    console.log(`linkeo-web subidas=${subidas} ya=${ya} avisos=${avisos}`);
    return Response.json({ donde: "web", subidas, ya, avisos, motivo: resultado.motivo || "" });
  }
  await guardarNube(presencia(actual, { ...base, estado: "subiendo" }));
  const sitio = env("URL").replace(/\/$/, "");
  if (sitio && secret) {
    await fetch(`${sitio}/linkeo-turno-web`, {
      method: "POST",
      headers: { "x-linkeo-turno": secret, "x-linkeo-sigue": "1" },
    }).catch(() => {});
  }
  console.log(`linkeo-web subidas=${subidas} ya=${ya} avisos=${avisos}`);
  return Response.json({ donde: "web", subidas, ya, avisos });
};

export const config = {
  path: "/linkeo-turno-web",
  background: true,
};
