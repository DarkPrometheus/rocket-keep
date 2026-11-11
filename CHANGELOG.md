# Registro de cambios

## 2026-11-10 — Bot más rápido en los minijuegos

- El bot entrega su resultado del minijuego casi al instante (0,3–0,8 s) en vez de esperar
  lo que tardaría un humano. Su habilidad no cambia: el tiempo que cuenta va en el resultado.

## 2026-11-10 — Disparo con barra de carga

- Arrastrar (o mover el ratón) ahora solo fija el **ángulo**. La potencia sale de una barra
  que se carga **manteniendo el clic** —sobre el campo o sobre Disparar—: se llena en 1,5 s y
  al soltar dispara; más carga, más lejos. El teclado ya no dispara (solo ↑/↓ para el ángulo). Soltar casi sin carga (menos del 6 %) no dispara y avisa cómo se usa.
  Mientras se carga, la mira muestra la trayectoria con la potencia actual.

## 2026-11-10 — Terreno destructible (cráteres)

- Los cohetes que caen en terreno elevado dejan un **cráter**: el suelo (`field.ground`,
  101 alturas) baja en un cuenco alrededor del impacto. Radio por arma (`craterR`): Ráfaga 22,
  Racimo 16, Mortero 95; crece un poco si el cohete representa a muchos.
- Los cráteres duran toda la partida (el mapa y el suelo se conservan entre rondas) y nunca
  bajan del nivel llano donde están los castillos. Los árboles caen con el suelo.
- La mira, el bot y la simulación usan el suelo actual; el dibujo lo hunde en el instante del
  impacto. Protocolo 8.

## 2026-11-10 — Minijuego Laberinto

- Nuevo minijuego **Laberinto** 🧭: cuadrado de 9×9 generado con la semilla (igual para los
  dos); se recorre con las flechas o WASD, y en el celular con botones de flechas (mantener
  pulsado sigue avanzando). Gana quien llegue antes a la meta; llegar gana a no llegar.
- El bot lo juega siguiendo el camino más corto según su dificultad.

## 2026-11-10 — Mapa más grande y obstáculos

- El campo pasa de 1600 a 2400 de ancho y se ve **completo, sin zoom** en cualquier
  pantalla (textos, barras y cohetes se agrandan solos cuando se ve pequeño).
- 5 mapas con obstáculos (`game/maps.js`): Dos colinas (con roca flotante), La muralla,
  Islas flotantes, El cañón (mesetas y aguja de roca) y El volcán. Se sortea uno al azar
  al empezar la partida y no cambia entre rondas (la revancha sortea otro). Los cohetes
  explotan al chocar con un obstáculo.
- Física: velocidades ×1,29 para que el alcance crezca con el campo. Protocolo 7.
- Desarrollo: `?map=wall,canyon` limita los mapas.

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
