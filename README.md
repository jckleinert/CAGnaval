# CAGnaval

Juego web de soltar y combinar comidas, con un árbitro (servidor) que reparte las fichas y valida cada partida.

**Estado: etapa 1, modo práctica.** Se juega gratis, sin wallet, sin tickets y sin premios. Sirve para probar el juego real y el árbitro antes de conectar plata.

El diseño completo (reparto 70/23/7, dorada, tickets, seguridad) está en el documento "CAG Food Merge: diseño del juego".

## Qué hay en cada carpeta

| Carpeta | Qué contiene |
| --- | --- |
| `shared/` | El motor del juego. Es el mismo archivo para la página y para el árbitro, y da exactamente el mismo resultado en los dos. |
| `server/` | El árbitro: inicia partidas, entrega las fichas de a una, valida cada jugada y lleva el ranking semanal. |
| `web/` | La página del juego. |
| `test/` | Pruebas automáticas del motor y del árbitro. |
| `scripts/` | Herramientas: regenerar archivos de `shared/` y la prueba de punta a punta en navegador. |
| `vendor/` | La librería de física (Matter.js 0.19.0, licencia MIT), fijada en esa versión. |

## Cómo probarlo en tu computadora

Hace falta tener instalado Node.js 20 o más nuevo. No hay nada más que instalar.

1. Abrí una terminal en la carpeta del proyecto.
2. Escribí `npm start`.
3. Abrí `http://localhost:3000` en el navegador.

Para correr las pruebas automáticas: `npm test`.

## Cómo publicarlo en Railway

1. En Railway, creá un proyecto nuevo desde este repositorio de GitHub.
2. Railway detecta Node y usa `npm start`. No hace falta configurar un comando.
3. Agregá un volumen montado en `/data` y estas variables:

| Variable | Valor | Para qué |
| --- | --- | --- |
| `DATA_DIR` | `/data` | Que el ranking y las partidas guardadas sobrevivan a un reinicio |
| `TRUST_PROXY` | `1` | Que el límite de pedidos por visitante funcione detrás de Railway |

4. Generá un dominio público para el servicio y abrilo.

## Configuración

Todo se cambia con variables de entorno. Ninguna es obligatoria.

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `PORT` | `3000` | Puerto del servidor |
| `DATA_DIR` | `./data` | Dónde se guardan partidas y ranking |
| `GOLD_ODDS` | `0.125` | Probabilidad de que una partida tenga comida dorada (1 de cada 8). Para probarla seguido, poné `1` |
| `GOLD_FROM` / `GOLD_TO` | `5` / `120` | Entre qué fichas de la partida puede salir la dorada |
| `WEEK_START_DOW` | `1` | Día en que arranca la semana, en UTC (0 domingo, 1 lunes, ... 6 sábado) |
| `WEEK_START_HOUR` | `0` | Hora en que arranca la semana, en UTC |
| `TURN_WALL_MS` | `25000` | Tiempo real máximo entre dos jugadas antes de dar la partida por abandonada |
| `MAX_LAG_MS` | `10000` | Cuánto puede atrasarse el reloj del juego respecto del tiempo real |
| `MAX_ACTIVE_RUNS` | `300` | Partidas en curso permitidas en total |
| `MAX_ACTIVE_PER_IP` | `6` | Partidas en curso permitidas desde una misma dirección |
| `ALLOWED_ORIGIN` | vacío | Dirección del sitio, si la página se aloja en otro lado que el árbitro |
| `TRUST_PROXY` | apagado | Poner `1` detrás de un proxy como Railway |
| `RATE_LIMIT_PER_MIN` | `600` | Pedidos por minuto permitidos por visitante |

El cierre semanal por defecto es lunes 00:00 UTC. Hay que ajustarlo al día y hora de CAGlorie con `WEEK_START_DOW` y `WEEK_START_HOUR`.

## Reglas del juego que ya están implementadas

- 11 comidas, de Candy a Big Order. El onigiri es triangular, la lata de CAG Energy (nivel 4) alargada y el Big Order cuadrado. La lata se suelta inclinada (alternando el lado en cada tirada) para que caiga de punta, dé un saltito y se acueste, en vez de caer seca.
- Hasta 200 fichas por partida y 15 segundos para soltar cada una. Si se acaba el tiempo, cae sola.
- La partida termina cuando el frasco se llena o se acaban las fichas.
- Comida dorada en 1 de cada 8 partidas. Si se fusiona, el árbitro revela un multiplicador de ×0,5 a ×21 (en práctica no paga nada).
- Ventajas Shake, Swap y Sweep, un uso de cada una por partida (en práctica son gratis).
- Ranking semanal por calorías sumadas.

## Dibujos de las comidas

Mientras una comida no tenga dibujo propio, se muestra como un sticker provisorio con un emoji. Hoy tienen dibujo propio el caramelo (nivel 0, sin cara), la cookie (nivel 1, sin cara), el onigiri (nivel 2, con cara), la lata de CAG Energy (nivel 4, sin cara) y el ramen (nivel 5, sin cara).

Una comida puede tener un solo dibujo, o hasta cuatro caras para que parpadee y se sorprenda. No hace falta que todas tengan cara:

| Archivo | Cara | ¿Obligatorio? |
|---|---|---|
| `open.png` | Normal, ojos abiertos | Sí |
| `half.png` | Ojos a medio cerrar | No |
| `closed.png` | Ojos cerrados | No (sin esta no parpadea) |
| `wow.png` | Sorpresa | No |

Cómo tienen que ser los dibujos:

- PNG cuadrado con fondo transparente, de 512 x 512 o más.
- Las caras de una misma comida, todas del mismo tamaño y con la comida exactamente en el mismo lugar. Solo cambian los ojos o la boca.
- Sin tocar el borde de la imagen.
- Las comidas alargadas, acostadas: el dibujo se guarda como va a caer en el frasco (la lata está guardada de costado).
- Las plantillas de `docs/plantillas/` sirven de guía para la forma general (redonda, triángulo, óvalo o cuadrada).

Para poner o cambiar un dibujo:

1. Guardar las caras en `art/foods/<nivel>/` (`0` es la comida más chica y `10` la más grande).
2. Correr `npm run build:art` (necesita Python con Pillow y numpy). Arma la imagen que usa el juego en `web/img/foods/<nivel>.webp` y vuelve a generar `shared/foods.js`.
3. Subir `RULES.VERSION` en `shared/sim.js` si la comida no es redonda (ver abajo).

Cuándo aparece cada cara: la comida parpadea sola cada pocos segundos, cada una a su ritmo. Pone cara de sorpresa mientras cae, recién fusionada, cuando se usa Shake, cuando asoma por encima de la línea y, la que está por caer, en los últimos 3 segundos.

Aparte de las caras, todas las comidas del frasco (con dibujo propio o no) se aplastan un poco y rebotan cuando algo las golpea, aparecen con un pequeño salto al nacer de una fusión y tienen una sombra que cae siempre hacia abajo, aunque giren. Es solo visual: lo hace la página y no cambia la partida.

**El borde con el que chocan.** Las comidas redondas siguen chocando como un círculo, y su dibujo se ajusta a ese círculo. Las que no son redondas (onigiri, lata, Big Order) chocan con el contorno de su propio dibujo, llevado al mismo tamaño que tenían. Por eso, cambiar el dibujo de una comida no redonda cambia un poco cómo rebota y obliga a subir `RULES.VERSION`.

Cambiar el tamaño de una comida o su forma general sí cambia el juego, y obliga a volver a probar la dificultad.

## Qué controla el árbitro

- **Las fichas las decide el árbitro.** La página solo conoce la ficha actual y la siguiente.
- **La dorada y su premio se deciden al iniciar la partida** y quedan ocultos. Al empezar, la página recibe una huella del secreto de la partida; al terminar recibe el secreto, así cualquiera puede comprobar que nada cambió en el medio.
- **El puntaje es el del árbitro.** Juega la misma partida con las jugadas que recibe, y el número que manda la página no se usa.
- **Cada jugada tiene que ser legal** en la partida del árbitro, llegar en orden y dentro del tiempo.
- **No se puede adelantar el reloj.** El reloj del juego no puede ir más rápido que el tiempo real.
- **No se puede pausar para pensar.** El reloj del juego tampoco puede atrasarse más de 10 segundos respecto del tiempo real, y más de 25 segundos sin jugar cierran la partida. En los dos casos se conservan las calorías hechas hasta ahí.
- **Una partida cuenta para la semana en la que termina.**
- **Cada partida queda guardada** con todas sus jugadas y se puede volver a jugar para auditarla.

## Límites conocidos de esta etapa

- **Navegadores:** el mismo resultado en página y árbitro está probado en Chrome. Falta probarlo en Safari (iPhone) y Firefox. Cada jugada lleva una huella del estado del juego; si alguna vez la página y el árbitro se separan, la partida queda marcada con la jugada exacta donde pasó.
- **Identidad:** el jugador es un código guardado en el navegador más un nombre. No es seguro; con wallet se reemplaza.
- **Guardado:** archivos en disco. Antes de usar tickets reales hay que pasar a una base de datos.
- **Reinicios:** si el servidor se reinicia, las partidas en curso se pierden.
- **Un solo servidor:** el árbitro guarda las partidas en curso en memoria, así que no se puede repartir en varias copias.
- **Bots:** la página tiene el motor completo, así que un programa puede simular jugadas antes de mover. El árbitro le limita el tiempo por jugada, pero todavía no detecta que sea un bot.
- **Si el jugador cambia de pestaña**, el reloj sigue corriendo: al volver, el juego se pone al día y la ficha puede haber caído sola.

## Qué falta para las próximas etapas

1. Contratos en la red de prueba de Ronin: ticket NFT, caja del bonus y cobro semanal.
2. Conectar la Ronin Wallet, pedir ticket para jugar, partidas de 1 a 5 tickets y pago del bonus al instante.
3. Playtest cerrado.
4. Lanzamiento en la red real.

## Para quien toque el código

- `shared/sim.js` es la única fuente de verdad de las reglas. Si cambia algo que altera el resultado de una partida, hay que subir `RULES.VERSION`.
- Dentro de la simulación no se puede usar `Math.sin`, `Math.pow`, `Math.random` ni nada parecido: no dan el mismo resultado en todos los navegadores. `shared/detmath.js` los reemplaza o los bloquea.
- `shared/matter-det.js`, `shared/foods.js`, `scripts/art.json` y `web/img/foods/*.webp` son archivos generados. Se rehacen con `npm run build:matter`, `npm run build:foods` y `npm run build:art`.
- Prueba de punta a punta en navegador (necesita Playwright): `node scripts/e2e.js`.
