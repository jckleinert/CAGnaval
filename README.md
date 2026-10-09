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

- 11 comidas que se fusionan en este orden: caramelo, cookie, onigiri, donut, lata de CAG Energy, waffle, ramen, pizza, sushi, torta y caja de pizza (Pizza Box). El onigiri es triangular, la lata de CAG Energy (nivel 4) alargada y la caja de pizza cuadrada. La lata se suelta inclinada (alternando el lado en cada tirada) para que caiga de punta, dé un saltito y se acueste, en vez de caer seca.
- Hasta 200 fichas por partida y 15 segundos para soltar cada una. Si se acaba el tiempo, cae sola.
- La partida termina cuando el frasco se llena o se acaban las fichas.
- El frasco se considera lleno cuando el centro de una comida queda por encima de la línea durante 3 segundos seguidos (o sea, puede asomar hasta la mitad). Mientras tanto la línea titila y aparece una cuenta regresiva; si la pila se acomoda o hay una fusión y la comida baja, la cuenta se corta. Una comida recién caída o recién fusionada no cuenta durante el primer segundo. Si mientras una comida está pasada de la línea queda **otra** también pasada, la partida termina en el momento, sin esperar la cuenta.
- Las comidas descansan: una comida que estuvo un segundo en el mismo lugar se queda completamente quieta (sin temblar ni girar) hasta que otra en movimiento la toca. Si sigue rebotando o girando sin moverse del lugar, descansa igual a los dos segundos y medio. Cuando se saca una comida del frasco (una fusión, Sweep) o se usa Shake, se despiertan todas, para que ninguna quede colgada.
- Las paredes y el piso del frasco son sólidos: ninguna comida puede hundirse en el vidrio ni salirse del frasco, por más que la aprieten las grandes.
- Comida dorada en 1 de cada 8 partidas. Es siempre el onigiri, en su versión de oro. Si se fusiona, el árbitro revela un multiplicador de ×0,5 a ×21 (en práctica no paga nada).
- Ventajas Shake, Swap y Sweep, un uso de cada una por partida (en práctica son gratis).
- Dos rankings semanales: **Total** (las calorías de todas las partidas de la semana, con la cantidad de partidas jugadas) y **Best run** (la mejor partida de cada jugador; si dos empatan, gana quien llegó primero). En la pantalla de ranking se cambia con dos pestañas.

## Dibujos de las comidas

Las once comidas tienen dibujo propio. Si a alguna le faltara, se mostraría como un sticker provisorio con un emoji. Son el caramelo (nivel 0, sin cara), la cookie (nivel 1, sin cara), el onigiri (nivel 2, con cara), la donut (nivel 3, sin cara), la lata de CAG Energy (nivel 4, sin cara), el waffle (nivel 5, sin cara), el ramen (nivel 6, sin cara), la pizza (nivel 7, sin cara), el sushi (nivel 8, sin cara), la torta (nivel 9, sin cara) y la caja de pizza (nivel 10, Pizza Box, una caja de pizza de CAG, sin cara).

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

**Versión dorada.** El onigiri tiene además su versión de oro, que es la comida dorada de la partida. No se dibuja aparte: el armado toma las cuatro caras del onigiri común y las pinta con los colores de oro indicados en `art/foods/2/art.json`, así parpadea igual y calza en el mismo contorno. `gold-reference.png` es el dibujo del que salieron esos colores. En el frasco lleva un resplandor dorado alrededor.

**Contorno parejo.** Todas las comidas quedan con el contorno negro del mismo grosor en el frasco, sin importar su tamaño ni con qué línea se dibujaron. El armado mide el contorno de cada dibujo y le suma por fuera lo que falte (nunca lo afina); el dibujo original no se toca. El grosor se cambia con `OUTLINE` en `scripts/gen-art.py`. Para dejar una comida tal como se dibujó, poner un archivo `art.json` con `{"outline": false}` en su carpeta.

Para poner o cambiar un dibujo:

1. Guardar las caras en `art/foods/<nivel>/` (`0` es la comida más chica y `10` la más grande).
2. Correr `npm run build:art` (necesita Python con Pillow y numpy). Arma la imagen que usa el juego en `web/img/foods/<nivel>.webp` y vuelve a generar `shared/foods.js`.
3. Subir `RULES.VERSION` en `shared/sim.js` si la comida no es redonda (ver abajo).

Cuándo aparece cada cara: la comida parpadea sola cada pocos segundos, cada una a su ritmo. Pone cara de sorpresa mientras cae, recién fusionada, cuando se usa Shake, cuando asoma por encima de la línea y, la que está por caer, en los últimos 3 segundos.

Aparte de las caras, todas las comidas del frasco (con dibujo propio o no) se aplastan un poco y rebotan cuando algo las golpea, aparecen con un pequeño salto al nacer de una fusión y tienen una sombra que cae siempre hacia abajo, aunque giren. Es solo visual: lo hace la página y no cambia la partida.

**El borde con el que chocan.** Las comidas redondas chocan como un círculo, y su dibujo se ajusta a ese círculo. Entre dos redondas el choque se calcula como círculo perfecto (no como un polígono de muchas caras), para que una chica no pueda quedarse haciendo equilibrio arriba de una grande: siempre termina rodando hacia un costado. Las que no son redondas (onigiri, lata, caja de pizza) chocan con el contorno de su propio dibujo, llevado al mismo tamaño que tenían. Por eso, cambiar el dibujo de una comida no redonda cambia un poco cómo rebota y obliga a subir `RULES.VERSION`.

Cambiar el tamaño de una comida o su forma general sí cambia el juego, y obliga a volver a probar la dificultad.

## Pantalla y festejos

- En celulares altos, los botones Shake, Swap y Sweep van sobre el mostrador, debajo del frasco, para que el frasco use todo el ancho. En pantallas más bajas o anchas quedan en una columna al costado.
- Cada fusión tira chispitas con los colores de la comida y muestra las calorías ganadas, más grandes cuanto más grande es la comida. Las fusiones encadenadas (menos de un segundo entre una y otra) muestran un cartel de combo; es solo un festejo, no suma puntos. Al formarse un ramen o algo más grande, el frasco da un pequeño sacudón.
- CAG va de un cartel al otro: al apretar Play se esconde detrás del cartel y sube por detrás del frasco; cuando la partida termina se esconde detrás del frasco y aparece arriba del cartel final, y también arriba del ranking.
- La pantalla de inicio muestra a CAG asomándose (dibujada al tamaño exacto de la pantalla, para que se vea nítida) y el orden de las comidas. Al apretar Play, CAG se esconde detrás del cartel y aparece subiendo por detrás del frasco.
- En la pantalla de inicio CAG aparece subiendo desde atrás del cartel apenas termina de cargar su dibujo, en vez de aparecer de golpe.
- La pantalla final muestra la comida más grande en un círculo con papelitos, el puntaje contando desde cero, un sticker de "New best!" cuando se supera el récord, y tres cuadritos de colores: comidas usadas, puesto de la semana y comida dorada.
- Todo esto es solo visual: no cambia ninguna partida.

## Sonido

- Las fusiones suenan con uno de tres "pops" elegido al azar (sin repetir el anterior), más agudo para las comidas chicas y más grave para las grandes. Los pops salen de `art/sounds/pops-original.mp3`, cortados en `web/snd/pop0.mp3`, `pop1.mp3` y `pop2.mp3`.
- Cuando se fusiona el onigiri dorado, además del pop suena un "polvo de hada" (`web/snd/gold.mp3`, cortado de `art/sounds/fairy-dust-original.mp3`).
- Al soltar una comida suena un "fiu" muy bajito (`web/snd/drop.mp3`), cada vez un poco distinto de tono y volumen, y algo más grave para las comidas grandes.
- El botón del parlante, en la punta derecha del toldo, apaga y prende el sonido; el juego lo recuerda.
- Los navegadores solo dejan sonar una página después de que la persona la toca, así que el sonido arranca con el primer toque o con el botón Play.

## El personaje (CAG)

CAG está asomada arriba del frasco, encima de la comida que va a caer, y sigue la puntería. Respira, parpadea, y abre los ojos al soltar y cuando el frasco está por llenarse. El borde de abajo del busto queda escondido detrás del borde del frasco, así no se ve un hueco cuando se mueve. Es solo visual.

Los dibujos están en `art/cag/`:

| Archivo | Qué es |
|---|---|
| `normal.png`, `closed.png`, `wide.png` | El busto con tres caras: normal, ojos cerrados y ojos abiertos. Mismo tamaño y misma posición. |
| `cag.json` | Dónde están los ojos, a qué altura se corta el busto y qué ancho tiene en el juego. |

Se arman con `npm run build:cag` (Python con Pillow y numpy), que escribe `web/img/cag/body.webp` y `web/cag-art.js`. De `closed.png` y `wide.png` solo se usan los ojos: el resto del busto sale siempre de `normal.png`, para que no tiemble al parpadear aunque los dibujos no coincidan al píxel.

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

- En una pila apretada el motor de física nunca deja las comidas del todo quietas: las corrige una fracción de unidad en cada paso y por eso temblaban y giraban solas. Hay dos cosas contra eso. En las reglas (`shared/sim.js`, "Rest"): la comida que no se movió de su lugar durante `REST_STEPS` pasa a descansar y el motor la trata como parte del frasco hasta que algo la despierta. En la pantalla (`web/game.js`, `steady`): el dibujo sigue a la simulación con un filtro suave que se traga el temblor que quede; es solo visual y no cambia ninguna partida.
- El motor saca a una comida de adentro de una pared de a poco, y una chica apretada por varias grandes podía hundirse hasta quedar del otro lado. `_keepIn` (en `shared/sim.js`) la devuelve contra la pared después de cada paso si entró más de `WALL_GIVE`. Usa el contorno real de la comida y no `body.bounds`, que el motor estira hacia donde la comida se está moviendo.
- Los toques muy suaves no rebotan (`BOUNCE_MIN`): si no, una comida pesada apoyada sobre una liviana se quedaba martillándola para siempre. Todo lo que cae de verdad rebota igual que antes.
- Una comida que descansa se suelta un momento (`REST_CHECK`) cada vez que una vecina cambia de lugar de verdad, para que no quede colgada si lo que la sostenía se corre despacio.
- `shared/sim.js` es la única fuente de verdad de las reglas. Si cambia algo que altera el resultado de una partida, hay que subir `RULES.VERSION`.
- Dentro de la simulación no se puede usar `Math.sin`, `Math.pow`, `Math.random` ni nada parecido: no dan el mismo resultado en todos los navegadores. `shared/detmath.js` los reemplaza o los bloquea.
- `shared/matter-det.js`, `shared/foods.js`, `scripts/art.json` y `web/img/foods/*.webp` son archivos generados. Se rehacen con `npm run build:matter`, `npm run build:foods` y `npm run build:art`.
- Prueba de punta a punta en navegador (necesita Playwright): `node scripts/e2e.js`.
