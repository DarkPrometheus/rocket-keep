"""Servidor local para desarrollo: igual que `python -m http.server`, pero le dice
al navegador que NO guarde copias de los archivos. Así, al recargar siempre ves
los cambios (con el servidor normal, los módulos JS se quedan en caché y a veces
parece que los cambios no hacen nada).

Uso:   python serve.py [puerto]      (por defecto 8000)
Abre:  http://localhost:8000/index.html
"""
import http.server
import sys


class SinCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with http.server.ThreadingHTTPServer(('', puerto), SinCache) as servidor:
        print(f'Rocket Keep en http://localhost:{puerto}/index.html (sin caché)')
        servidor.serve_forever()
