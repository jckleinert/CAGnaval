# CAGnaval — manual del contrato (borrador para la red de prueba)

Contrato: `CAGnaval.sol` (un solo archivo, se abre en Remix igual que CAGlorie).
Descripción de funciones: `build/CAGnaval.abi.json`.

## Qué hace

- **Partidas.** El jugador manda de 1 a 5 tickets (ERC-1155) al contrato y empieza una partida. Una sola transacción, sin aprobar nada antes, como las bebidas de CAGlorie. Los tickets quedan guardados en el contrato.
- **Onigiri dorado.** Cuando termina la partida, el árbitro (el servidor del juego) la cierra y, si hubo dorada, el premio sale al instante de la caja del bonus.
- **Pozo semanal.** El lunes 00:00 UTC cierra la semana. El árbitro publica cuánto le toca a cada billetera; una hora después cada jugador cobra desde el juego. Tiene hasta el final de la semana siguiente.

## Por qué es seguro aunque roben la clave del árbitro

- Una partida paga como máximo 105 RON por ticket (21 × 5 RON), y una sola vez.
- Cada partida abierta deja **reservados** esos 105 RON por ticket en la caja. Si la caja no alcanza, la partida no arranca. Así nunca se promete más de lo que hay.
- Una semana solo reparte lo que vos cargaste para esa semana, y recién cuando terminó.
- Hay una hora entre que el árbitro publica el reparto y que se puede cobrar: si algo está mal, lo anulás con `voidResult`.
- Solo vos (OWNER) podés sacar RON o tickets del contrato.

## Deploy (Remix)

1. Compilar `CAGnaval.sol` (EVM version: **paris** · Optimization: tildada).
2. Deploy → Browser Extension → MetaMask en la red correcta, cuenta OWNER.
3. Constructor:
   - `_ticket` = dirección de la colección ERC-1155 de los tickets
   - `_ticketId` = número del ítem ticket dentro de la colección
   - `_referee` = billetera del árbitro (el servidor; te la paso yo)
4. Anotar la dirección del contrato.

## Operación de cada semana

Montos en RON se escriben con 18 ceros (1 RON = `1000000000000000000`). En Remix el valor a mandar va en el campo **Value**, arriba del botón Deploy.

| Qué | Función | Detalle |
|---|---|---|
| Cargar la caja del bonus | `fundBonus` | Mandar RON en Value. |
| Cargar el pozo de una semana | `fundPool(week)` | `week` = `currentWeek()`. Mandar RON en Value. Se puede cargar en varias veces. |
| Retirar tickets para volver a venderlos | `withdrawTickets(amount, to)` | Van a la billetera `to`. Ver cuántos hay con `ticketsHeld()`. |
| Sacar RON sobrante de la caja | `withdrawBonus(amount, to)` | Solo la parte libre (`bonusFree()`); lo reservado para partidas abiertas no se puede tocar. |
| Pasar lo no cobrado a otra semana | `rollover(fromWeek, toWeek)` | Lo hace el árbitro solo; vos también podés. |
| Anular un premio mal publicado | `voidResult(week, player)` | Antes de que lo cobre. |
| Cerrar una partida trabada | `cancelRun(runId)` | Solo si pasó un día y el árbitro no la cerró. No paga nada. |
| Pausar todo | `setPaused(true)` | Frena partidas nuevas y cobros. |

## Ajustes (`setConfig`)

| Campo | Valor inicial | Qué es |
|---|---|---|
| `maxTickets` | 5 | Tickets máximos por partida |
| `capPerTicket` | 105 RON | Premio máximo de la dorada por ticket (y lo que se reserva). Solo se puede cambiar sin partidas abiertas. |
| `claimDelay` | 3600 (1 hora) | Espera entre publicar el reparto y poder cobrar |
| `claimWeeks` | 1 | Semanas para cobrar después del cierre |

## Consultas útiles (gratis)

`currentWeek()`, `weekEndsAt(week)`, `weekPool(week)`, `weekAssigned(week)`, `weekClaimed(week)`, `leftover(week)`, `claimable(player, week)`, `bonusBox()`, `bonusFree()`, `reserved()`, `openRuns()`, `runCount()`, `getRun(runId)`, `ticketsHeld()`, `owed(player)`.

## Para revisar el contrato (técnico)

```
cd contracts && npm install && npm run check
```

Compila y prueba todo en una cadena simulada (38 casos, incluidos intentos de trampa).
