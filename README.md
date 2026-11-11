# Rocket Keep (nombre provisional)

Prototipo de juego 1 vs 1 por turnos. Cada jugador tiene un castillo con orugas y dispara
una ráfaga de cohetes en parábola: si cruzan una compuerta (x2, x4, x8, x20, x30) se
multiplican antes de caer sobre el castillo rival. Gana quien derribe el castillo del
otro (no hay límite de rondas). Entre rondas, el daño causado da monedas para mejoras.

HTML + Canvas + JavaScript vanilla, módulos ES, sin bundler. La única dependencia es
PeerJS (desde CDN, solo al jugar en línea).

## Jugar en línea

1. Uno pulsa **Crear sala**: sale un código de 4 letras, un enlace y un QR.
2. El amigo abre el enlace (o escribe el código en **Unirse**) y entra directo.

La pestaña de quien crea la sala **es el servidor** (host autoritativo): no hay backend.
Basta con publicar la carpeta en GitHub Pages (o cualquier hosting estático). PeerJS solo
"presenta" a los navegadores (servidor público de señalización) y trae STUN/TURN propios,
así que la conexión funciona también entre redes complicadas (datos móviles, NAT).

- Si el invitado pierde la conexión o recarga la página, vuelve solo a su lugar
  (hasta 90 s). El anfitrión ve "Tu amigo perdió la conexión…" mientras tanto.
- Si el anfitrión cierra o recarga su pestaña, la partida termina (es el servidor):
  por eso la sala avisa y el navegador pide confirmación antes de cerrar.
- Un tercero que intente entrar ve "Sala llena".

## Cómo correrlo

Los módulos ES no cargan abriendo `index.html` con doble clic (`file://`), así que hace
falta un servidor estático. Desde esta carpeta:

```bash
python -m http.server 8000
```

y abre <http://localhost:8000>. Cualquier otro servidor estático sirve igual.

- **Jugar:** arrastra desde tu castillo: la dirección es el ángulo y la distancia, la
  potencia. Suelta para disparar. Teclado: ↑/↓ ángulo, ←/→ potencia, Espacio dispara.
- **`debug.html`:** inspector de la lógica (compuertas de una semilla, mapa de daño por
  ángulo × potencia, partida simulada y huella de determinismo).

## Sonido

El juego incluye efectos arcade sintetizados con **Web Audio API**: lanzamientos
por arma, multiplicadores, racimos, explosiones, suelo, derribo, interfaz, compras,
turnos, minijuegos y fin de partida. No requiere dependencias ni archivos de audio.

- La barra **Sonido / Volumen** está disponible en el menú y durante la partida.
  El volumen inicial es 65 %. Silencio y volumen se guardan en `localStorage`
  (`rocket-keep.audio.v1`); si está bloqueado, funcionan durante la sesión.
- El navegador activa el audio tras una interacción (puntero o teclado). Si se
  entra directamente con `?play=...`, hay que tocar o pulsar una tecla primero.
  Los sonidos anteriores al desbloqueo se descartan, no se reproducen atrasados.
- Ocultar la pestaña cancela los efectos y suspende el contexto; al volver,
  el siguiente gesto lo reanuda. Salir al menú corta las voces de la partida.
- Si Web Audio no está disponible, la partida continúa y los controles indican
  «Sonido no disponible». No hay música de fondo por ahora.

### Integración y mantenimiento del audio

`main.js` crea una sola instancia de `GameAudio` y la comparte con UI y controller.
El renderer recibe un callback opcional `onSound(name, data)`; emite los efectos
cuando la animación alcanza el lanzamiento, cruce o impacto, usando su reloj
visual. El controller anuncia turnos y fin de partida cuando se muestran, y las
compras solo suenan después de ser aceptadas por el host. Los minijuegos emiten
sus tonos desde la interfaz. No se añaden sonidos al estado ni al protocolo.

La API de `game/audio.js` es `unlock()`, `play(name, options)`, `setVolume(0..1)`,
`setMuted(bool)`, `settings`, `subscribe(callback)`, `stopAll()` y `dispose()`.
`unlock()` intenta reanudar el contexto desde un gesto; `dispose()` libera voces,
contexto y listeners cuando se descarta definitivamente el servicio.

Para ajustar o añadir un efecto, cambia su receta en `GameAudio.play()` y emite
su nombre desde la presentación. Las opciones usadas son `pan` (-1..1), `weapon`,
`mult` e `index` (color de Simón). Las recetas combinan osciladores, ruido filtrado
y envolventes cortas. `MAX_VOICES` limita las voces a 20, `COOLDOWNS` agrupa
sonidos repetidos próximos y un compresor ayuda a controlar los picos.

Comprobación manual: empezar una partida, probar las tres armas y los minijuegos,
cambiar volumen/silencio y recargar; ocultar/volver a la pestaña; salir durante un
disparo y empezar otra partida. Verificar además en móvil y con teclado que mover
el volumen no cambie el apuntado ni dispare. Las pruebas de Node cubren gestión
del audio y orden de avisos; la escucha final requiere un navegador con salida de audio.

El detalle de esta entrega está en [CHANGELOG.md](CHANGELOG.md).

## Tests

```bash
npm test
```

Usa el runner nativo de Node (`node --test`), sin dependencias:

- `tests/logic.test.js`: misma semilla + mismos inputs = mismo resultado, reproducción de
  inputs, paso por JSON, simetría entre lados, reglas, tienda y victoria.
- `tests/net.test.js`: host + clientes por transportes locales, reconstrucción de la
  partida solo con los mensajes del host, rechazo de mensajes inválidos, resincronización
  y aviso de desconexión.
- `tests/audio.test.js`: desbloqueo por interacción, síntesis de efectos, límites,
  cancelación de voces, silencio, persistencia, pestaña oculta y fallos de API/almacenamiento.
- `tests/controller-audio.test.js`: avisos únicos de turno, compras aceptadas,
  victoria después de la animación y salida con sonidos pendientes.
- `tests/rng.test.js`: generador con semilla y trigonometría determinista.
- `tests/peer.test.js`: canal en línea con conexiones simuladas (latido, caída, reconexión,
  salida voluntaria) y partidas que se recuperan tras perder la conexión o recargar.

**Huella de determinismo:** `tests/scenario.js` juega partidas guionizadas y resume sus
hashes en una cadena. El test la compara con un valor de referencia: si cambias las reglas
a propósito, actualízalo. Para comprobar otro navegador (Firefox, Safari en el celular),
abre `debug.html`, pulsa «Calcular huella» y compárala con la del test.
- **Parámetros de desarrollo:** `?play=easy|normal|hard` empieza sin menú;
  `?autofire=<ms>` dispara solo (para capturas); `?minigame=needle,simon` limita los
  minijuegos a esos ids.

## Arquitectura

```
 input ─► controller ─► client ──(transport)──► host ──► logic (reglas puras)
              │            ▲                     │
              │            └──── mensajes ◄──────┘
              ├─► render  (canvas: dibuja estados y reproduce disparos)
              └─► ui      (DOM: HUD, tienda, menús)
```

| Archivo | Responsabilidad |
|---|---|
| `game/logic.js` | Reglas **puras y deterministas**: estado, física de la ráfaga, compuertas, daño, economía, rondas y victoria. Sin DOM, sin `Math.random`. |
| `game/world.js` | Geometría fija del campo (enteros) y `dsin`/`dcos` deterministas. |
| `game/rng.js` | Generador con semilla (mulberry32) y hashes. |
| `game/minigames.js` | Minijuegos de inicio de ronda: generación con semilla, validación y quién gana (puro). |
| `game/minigames-ui.js` | Interfaz DOM de los minijuegos: los muestra, mide al jugador y devuelve su resultado. |
| `game/config.js` | Todos los números de balance. Viaja dentro del estado. |
| `game/host.js` | Árbitro autoritativo: genera las semillas, valida inputs con `logic.js` y difunde resultados. |
| `game/client.js` | Copia del estado de cada jugador: reaplica los inputs del host y compara hashes (si no coinciden, pide resync). |
| `game/controller.js` | Une input, cliente, render y UI. Encola los eventos para que las animaciones no se adelanten. |
| `game/render.js` | Dibujo en canvas. **Intercambiable**: cualquier clase con la misma interfaz sirve. |
| `game/audio.js` | Servicio de efectos sintetizados, volumen/silencio, preferencias y ciclo de vida del audio. Solo presentación. |
| `game/effects.js` | Partículas y sacudida (solo visual). |
| `game/ui.js` | Interfaz DOM a partir de un modelo de vista. |
| `net/protocol.js` | Tipos de mensaje y validación de forma. |
| `net/transport.js` | Interfaz `send(msg)` / `onMessage(cb)` / `onClose(cb)` / `close()`, más `LocalTransport` y `BotTransport`. |
| `net/peer.js` | En línea: `PeerLink` (canal con latido y reconexión), `createRoom()` y `joinRoom()` sobre PeerJS. |
| `game/qr.js` | Generador de códigos QR propio (para el enlace de invitación). |
| `game/fullscreen.js` | Pantalla completa en teléfonos (automática al empezar a jugar) y bloqueo en horizontal. |
| `net/bot.js` | Rival simulado: un cliente más que elige ángulo y potencia probando tiros con la lógica. |

### Modelo de red (host autoritativo)

- El cliente solo envía intenciones: `{type:'pickWeapon', weapon}`, `{type:'minigame',
  entry}`, `{type:'fire', angle, power}`, `{type:'buy', upgrade}` (mejoras y perks),
  `{type:'ready'}`, `{type:'rematch'}`.
- El host responde con lo que pasó: `weaponPicked {player}` (sin decir cuál),
  `weaponsChosen {weapons}` (cuando ambos eligieron), `roundStart {round, seed}`,
  `minigameIn {player}` y `minigameResult {entries}` (minijuego, también en secreto),
  `shotResult {shooter, angle, power, hash}`, `roundResult {round, seed, hp, coins, hash}`,
  `bought`, `playerReady`, `gameOver`.
- Como la lógica es determinista, cada cliente recalcula el disparo exacto a partir de la
  semilla y los inputs, y lo anima. El `hash` del estado detecta cualquier desincronización.
- Contra el bot, el host vive en la misma pestaña. En línea vive en la pestaña de quien crea
  la sala; solo cambia el transporte. Al volver tras una desconexión, el host manda el estado
  completo (`state`) y lo que aún es secreto pero le toca al jugador (su arma, si ya jugó el
  minijuego). `peerStatus` avisa cuando un jugador pierde o recupera la conexión.

### Determinismo

Misma semilla + mismos inputs = mismo resultado exacto en cualquier navegador: solo se
usan `+ - * /` (exactos en IEEE-754), la geometría son enteros fijos y el seno/coseno se
calculan con una serie de Taylor propia. Los dos lados del campo son espejo exacto.

### Cambiar los gráficos

`render.js` documenta la interfaz (`setState`, `setAim`, `playShot`, `pointerToAim`,
`destroy`). Crea otra clase que la cumpla y cámbiala en `main.js`.

## Estado

- [x] Fase 1: juego completo contra el bot (lógica, host/transporte/bot, render, HUD y
  tienda, efectos, balance).
- [x] Fase 2: tests de determinismo en Node (`npm test`).
- [x] Armas elegidas al inicio (Ráfaga, Mortero, Racimo), en secreto hasta que ambos eligen.
- [x] Curación al inicio de cada ronda (30 de vida), mejorable con «Reparación» en la tienda.
- [x] Perks pasivos de compra única: Blindaje, Ahorro y Ojo de halcón (se añaden más en
  `config.perks`).
- [x] Minijuego en cada ronda (5): Detén la aguja, Cuenta rápida, Simón, Machaca y
  Piedra-papel-tijera. Gana = abre la ronda.
- [x] Sin límite de rondas: solo se gana por derribo.
- Ideas anotadas para después (más minijuegos y armas): `IDEAS.md`.
- [x] Sonido de combate, interfaz y minijuegos, con volumen y silencio persistentes.
- [x] Fase 3: partidas en línea con PeerJS: sala con código de 4 letras, enlace con
  entrada directa, compartir y QR, reconexión automática y avisos claros al desconectarse.
- [ ] Fase 4: pulido y ajustes para móvil vertical.
