# Registro de cambios

## 2026-11-10 — Menos minijuegos, teléfono en horizontal

- Quitados Cálculo rápido, Subasta secreta y Cartas: quedan 5 minijuegos (Aguja, Cuenta
  rápida, Simón, Machaca y Piedra-papel-tijera). Anotados en `IDEAS.md`.
- Teléfono en horizontal: el campo usa toda la altura; HUD flotante y columna lateral con
  sonido y Disparar. Pantalla completa automática al jugar (`game/fullscreen.js`).
- Funciona también por http (sin `crypto.randomUUID`).

## 2026-11-08 — Juego en línea (fase 3)

- `net/peer.js`: salas con PeerJS (CDN). Quien crea la sala hace de servidor en su pestaña.
- Menú: nombre del jugador, **Crear sala** y **Unirse** con código de 4 letras.
- Sala: código grande, enlace de invitación (`#CODIGO`, entra directo), Compartir
  (Web Share), Copiar enlace y QR (`game/qr.js`, generador propio).
- Latido ping/pong, reconexión automática del invitado (90 s de gracia) y vuelta a su
  lugar si recarga. Avisos: "Reconectando…", "Tu amigo perdió la conexión…", "Sala llena",
  "La sala no existe", "Tu amigo cerró la sala".
- Protocolo 6: `peerStatus` y `state` con nombres y datos pendientes del jugador.
- Verificado con dos pestañas reales conectadas por internet: partida, recarga del invitado,
  salida de cada lado, sala llena y código inexistente. QR verificado con un decodificador.

## 2026-11-08 — Sonido del juego

- Añadido `game/audio.js`: efectos arcade sintetizados con Web Audio API, sin
  dependencias, descargas ni archivos de sonido.
- Lanzamientos distintos para Ráfaga, Mortero y Racimo; tonos de multiplicadores,
  apertura de racimos, impactos en castillo/suelo y explosión de derribo.
- Sonidos de botones, compras aceptadas, errores, inicio de minijuego, turno,
  resultados y victoria/derrota/empate. Simón tiene una nota por color; Machaca,
  cuenta atrás y golpes; Cálculo rápido, acierto/error; Aguja, confirmación al parar.
- Controles de silencio y volumen disponibles en menú y partida, con etiquetas
  accesibles y preferencias guardadas en `localStorage`.
- Audio activado por gesto del usuario; al ocultar la pestaña se cancelan los
  sonidos y se suspende el contexto. El siguiente gesto visible lo reanuda.
- Máximo de 20 voces, intervalos mínimos entre efectos repetidos, compresor y
  posición estéreo según la ubicación visible del evento.
- Salir de una partida cancela sonidos y explosiones pendientes. El controlador
  descarta su cola al destruirse y espera las animaciones antes de anunciar el resultado.
- Las flechas y el espacio usados en controles de interfaz no accionan el cañón;
  los controles de sonido tampoco accionan los atajos de los minijuegos.
- La lógica, el protocolo y la huella de determinismo se conservan. No se incluye
  música de fondo en esta entrega.

### Verificación

- `npm test`: 50 pruebas (41 existentes y 9 nuevas de audio y sincronización).
- Chrome sin interfaz: inicio con interacción, partida con Mortero y Machaca,
  lanzamiento/impacto, silencio, persistencia tras recarga y controles a 390 px.
- Renderizado con `OfflineAudioContext` de las 19 recetas: señal finita,
  distinta de cero y sin superar el rango digital. Sin errores de JavaScript.
- Pendiente de escucha y ajuste subjetivo, y de comprobación en dispositivos
  físicos con Safari/iOS y Firefox.
