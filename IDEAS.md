# Ideas pendientes

Ideas anotadas para más adelante (no implementadas).

## Minijuegos (para decidir quién abre la ronda)

Ya implementados: uno de cada tipo (ver `game/minigames.js`).

| Minijuego | Cómo funciona | Tipo |
|---|---|---|
| Reflejos | Aparece "¡YA!" tras una espera al azar; gana quien toque primero. Tocar antes de tiempo = pierdes. | Habilidad |
| Cronómetro mental | Detener un reloj en 5,00 s exactos; el reloj se oculta a los 2 s. | Habilidad |

Notas:
- Los de tiempo se miden en el dispositivo de cada jugador y solo se envía el resultado
  (el lag no influye; entre amigos la trampa no importa).
- Se añaden en `game/minigames.js` (lógica) y `game/minigames-ui.js` (interfaz).

## Armas

| Arma | Idea | Qué cambia | Dificultad |
|---|---|---|---|
| Escopeta | Muchos perdigones en abanico ancho, poco daño cada uno | Cruza varias compuertas a la vez | Baja |
| Rebote | Rebota una vez en la colina en vez de explotar | Abre ángulos nuevos | Media |
| Incendiaria | Menos daño al impactar, pero el castillo arde y pierde vida al inicio de las siguientes rondas | Daño a largo plazo, contrarresta la curación | Baja |
| Vampiro | Te curas un % del daño que haces | Partidas más largas | Baja |
| Perforante | Ignora el Blindaje y atraviesa la colina una vez | Contrarresta perks | Media |
| Fuegos artificiales | Además de ángulo y potencia eliges la mecha: estalla en el aire donde decidas | Nueva forma de apuntar | Media |
| Láser | Línea recta sin gravedad; pocos disparos pero las compuertas valen el doble | Mucha precisión | Media |
| Teledirigido | Se curva un poco hacia el castillo en el último tramo | Ideal para principiantes | Media |
| Congelador | Al impactar, el siguiente disparo del rival tiene menos potencia máxima | Control | Baja |

Recomendadas para la próxima tanda: Escopeta, Incendiaria, Rebote y Fuegos artificiales.
