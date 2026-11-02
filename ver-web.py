"""Abre en esta PC la misma página de la web, sin publicarla.

El nombre localtest no es localhost, así que la página entra por la cuenta
y muestra Preparar clase. Las funciones siguen siendo las ya publicadas.
"""
import mimetypes
import os
import socket
import threading
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
ORIGEN = "https://clases-universitarias.netlify.app"
HOST = "127.0.0.1.nip.io"
PUERTO = 8755


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self._servir()

    def do_HEAD(self) -> None:
        self._servir(cuerpo=False)

    def do_POST(self) -> None:
        self._servir()

    def do_PUT(self) -> None:
        self._servir()

    def do_DELETE(self) -> None:
        self._servir()

    def do_OPTIONS(self) -> None:
        self._servir()

    def _servir(self, cuerpo: bool = True) -> None:
        ruta = self.path.split("?", 1)[0]
        if ruta.startswith("/.netlify/functions/"):
            self._reenviar()
            return
        if ruta in ("/LINKEODECLASESCLARA", "/LINKEODECLASESCLARA/"):
            ruta = "/LINKEODECLASESCLARA.html"
        if ruta in ("", "/"):
            ruta = "/index.html"
        archivo = (STATIC / ruta.lstrip("/")).resolve()
        raiz = STATIC.resolve()
        if archivo != raiz and not str(archivo).startswith(str(raiz) + os.sep):
            self.send_error(404)
            return
        if not archivo.is_file():
            self.send_error(404)
            return
        data = archivo.read_bytes()
        tipo = mimetypes.guess_type(archivo.name)[0] or "application/octet-stream"
        if tipo.startswith("text/") or tipo in ("application/javascript", "image/svg+xml"):
            tipo = f"{tipo}; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if cuerpo:
            self.wfile.write(data)

    def _reenviar(self) -> None:
        largo = int(self.headers.get("Content-Length") or 0)
        if self.command in ("POST", "PUT", "PATCH"):
            cuerpo = self.rfile.read(largo) if largo else b""
        else:
            cuerpo = None
        cabeceras = {}
        for clave in ("Content-Type", "Authorization", "Accept"):
            valor = self.headers.get(clave)
            if valor:
                cabeceras[clave] = valor
        pedido = urllib.request.Request(
            ORIGEN + self.path,
            data=cuerpo,
            headers=cabeceras,
            method=self.command,
        )
        try:
            with urllib.request.urlopen(pedido, timeout=120) as respuesta:
                payload = respuesta.read()
                estado = respuesta.status
                tipo = respuesta.headers.get("Content-Type")
        except urllib.error.HTTPError as error:
            payload = error.read()
            estado = error.code
            tipo = error.headers.get("Content-Type") if error.headers else None
        except Exception:
            payload = b'{"error":"No pude hablar con la web publicada."}'
            estado = 502
            tipo = "application/json"
        self.send_response(estado)
        if tipo:
            self.send_header("Content-Type", tipo)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, formato: str, *args) -> None:
        print(f"[web] {self.address_string()} {formato % args}", flush=True)


def main() -> None:
    socket.getaddrinfo(HOST, PUERTO)
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("127.0.0.1", PUERTO), Handler)
    url = f"http://{HOST}:{PUERTO}/"
    print(f"La web de ClaseClara en {url}", flush=True)
    print("Es la página de la web, con los archivos de esta PC.", flush=True)
    print("No publica nada. Cierra esta ventana para salir.", flush=True)
    threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nWeb local cerrada.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
