"""Esta PC avisa que está encendida y obedece el turno que pide la nube.

La contraseña queda en data/linkeo-acceso.json, fuera del repositorio.
No se imprime.
"""
from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cloud
import engine

ROOT = Path(__file__).resolve().parent
ACCESO = ROOT / "data" / "linkeo-acceso.json"
PROGRAMA = "http://127.0.0.1:8780"
CANDADO = threading.Lock()
OCUPADO = False


def accion_de(turno) -> str:
    estado = str((turno or {}).get("estado") or "")
    if estado == "pedido":
        return "escanear"
    if estado == "leido-web":
        return "agregar"
    return ""


def leer_acceso() -> tuple[str, str]:
    try:
        data = json.loads(ACCESO.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    usuario = " ".join(str(data.get("usuario") or "").split())
    clave = str(data.get("clave") or "")
    if not usuario or not clave or len(usuario) > 200 or len(clave) > 200:
        return "", ""
    return usuario, clave


def guardar_acceso(usuario: str, clave: str) -> None:
    ACCESO.parent.mkdir(parents=True, exist_ok=True)
    ACCESO.write_text(
        json.dumps({"usuario": usuario, "clave": clave}, ensure_ascii=False),
        encoding="utf-8",
    )


def borrar_acceso() -> None:
    try:
        ACCESO.unlink()
    except OSError:
        return


def _nube() -> dict:
    data = cloud.leer_ajuste("linkeo-turno.json")
    return data if isinstance(data, dict) else {}


def actualizar(fn) -> dict:
    with CANDADO:
        actual = _nube()
        fn(actual)
        cloud.guardar_ajuste("linkeo-turno.json", actual)
        return actual


def pulso() -> dict:
    usuario, clave = leer_acceso()

    def aplicar(actual: dict) -> None:
        actual["pc_en"] = int(time.time())
        actual["listo"] = bool(usuario and clave)

    return actualizar(aplicar)


def marcar(estado: str) -> None:
    def aplicar(actual: dict) -> None:
        turno = actual.get("turno") if isinstance(actual.get("turno"), dict) else {}
        turno["estado"] = estado
        actual["turno"] = turno
        actual["pc_en"] = int(time.time())

    actualizar(aplicar)


def programa_arriba() -> bool:
    try:
        with urllib.request.urlopen(f"{PROGRAMA}/api/programa", timeout=4) as response:
            return response.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def agregar_activo() -> bool:
    try:
        with urllib.request.urlopen(f"{PROGRAMA}/api/agregar", timeout=8) as response:
            data = json.loads(response.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return False
    return bool(isinstance(data, dict) and data.get("activo"))


def _post(path: str, payload: dict, timeout: int) -> dict:
    raw = json.dumps(payload).encode("utf-8")
    pedido = urllib.request.Request(
        PROGRAMA + path,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(pedido, timeout=timeout) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
    if not isinstance(data, dict):
        raise engine.AppError("La PC no contestó el turno.")
    if data.get("error"):
        raise engine.AppError(str(data["error"])[:180])
    return data


def esperar_libre() -> None:
    while agregar_activo():
        time.sleep(20)


def escanear() -> None:
    usuario, clave = leer_acceso()
    if not usuario or not clave:
        marcar("sinclave")
        print("[TURNO] esta PC no tiene el acceso guardado", flush=True)
        return
    esperar_libre()
    print("[TURNO] escaneo en esta PC", flush=True)
    if programa_arriba():
        data = _post("/api/linkeo", {"usuario": usuario, "clave": clave}, 300)
        cursos = data.get("cursos") if isinstance(data.get("cursos"), list) else []
        _post("/api/agregar", {"cursos": cursos}, 30)
    else:
        import app
        import linkeo

        data = linkeo.anotar_cursos(app.leer_clementina({"usuario": usuario, "clave": clave}))
        linkeo.comenzar(data.get("cursos") if isinstance(data, dict) else [])
    marcar("hecho")
    print("[TURNO] pedido listo", flush=True)


def agregar_lectura() -> None:
    esperar_libre()
    lectura = cloud.leer_ajuste("linkeo-lectura.json") or {}
    cursos = lectura.get("cursos") if isinstance(lectura.get("cursos"), list) else []
    if not cursos:
        marcar("error")
        print("[TURNO] la web no dejó clases", flush=True)
        return
    print(f"[TURNO] la web ya leyó. Agrego {len(cursos)} cursos aquí", flush=True)
    if programa_arriba():
        _post("/api/agregar", {"cursos": cursos}, 30)
    else:
        import linkeo

        linkeo.comenzar(cursos)
    cloud.borrar_ajuste("linkeo-lectura.json")
    marcar("hecho")
    print("[TURNO] pedido listo", flush=True)


def atender(accion: str) -> None:
    global OCUPADO
    try:
        if accion == "escanear":
            escanear()
        elif accion == "agregar":
            agregar_lectura()
    except Exception as exc:
        marcar("error")
        print(f"[TURNO] aviso {type(exc).__name__}", flush=True)
    finally:
        with CANDADO:
            OCUPADO = False


def mirar() -> None:
    global OCUPADO
    actual = pulso()
    turno = actual.get("turno") if isinstance(actual.get("turno"), dict) else {}
    accion = accion_de(turno)
    if not accion:
        return
    with CANDADO:
        if OCUPADO:
            return
        OCUPADO = True
    if accion == "escanear":
        marcar("en-pc")
    threading.Thread(target=atender, args=(accion,), daemon=True).start()


class Acceso(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        return

    def _json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:8780")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self._json(204, {})

    def do_POST(self) -> None:
        if self.client_address[0] not in {"127.0.0.1", "::1"}:
            self._json(403, {"error": "Solo esta PC."})
            return
        if self.path.split("?", 1)[0] != "/api/acceso":
            self._json(404, {"error": "No encuentro esa acción."})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > 2000:
            self._json(400, {"error": "Esa petición es demasiado grande."})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(400, {"error": "No pude leer la petición."})
            return
        if not isinstance(body, dict):
            self._json(400, {"error": "No pude leer la petición."})
            return
        if not body.get("recordar"):
            borrar_acceso()
            self._json(200, {"listo": False})
            return
        usuario = " ".join(str(body.get("usuario") or "").split())
        clave = str(body.get("clave") or "")
        if not usuario or not clave or len(usuario) > 200 or len(clave) > 200:
            self._json(400, {"error": "Escribe tu usuario y tu contraseña de Clementina."})
            return
        guardar_acceso(usuario, clave)
        self._json(200, {"listo": True})


def servir_acceso() -> None:
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 8781), Acceso)
    except OSError:
        print("[TURNO] el puerto 8781 ya está en uso", flush=True)
        return
    print("[TURNO] esta PC escucha la orden en segundo plano", flush=True)
    server.serve_forever()


def loop() -> None:
    while True:
        try:
            mirar()
        except Exception as exc:
            print(f"[TURNO] no pude avisar {type(exc).__name__}", flush=True)
        time.sleep(20)


def self_test() -> None:
    assert accion_de({"estado": "pedido"}) == "escanear"
    assert accion_de({"estado": "leido-web"}) == "agregar"
    assert accion_de({"estado": "hecho"}) == ""
    assert cloud._ajuste_turno("linkeo-turno.json") == "ajustes/linkeo-turno.json"
    try:
        cloud._ajuste_turno("clave.json")
        raise AssertionError("no debía guardar otro archivo")
    except engine.AppError:
        pass


if __name__ == "__main__":
    import sys

    if "--probar" in sys.argv:
        self_test()
        print("ok")
    else:
        threading.Thread(target=servir_acceso, daemon=True).start()
        loop()
