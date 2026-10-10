# CAGnaval — manual del contrato (borrador)

Contrato: `CAGnaval.sol` (un solo archivo, se abre en Remix igual que CAGlorie).
Descripción de funciones: `build/CAGnaval.abi.json`.

## Qué hace

- **Partidas.** El jugador manda de 1 a 5 tickets (ERC-1155) al contrato y empieza una partida. Una sola transacción, sin aprobar nada antes, como las bebidas de CAGlorie. Los tickets quedan guardados en el contrato.
- **Ventas.** Lo que te llega de Ronin Market (ya sin su 2,5%) lo mandás con `deposit`. El contrato reconstruye la venta original y reparte sobre el precio completo del ticket: 72,5% al pozo de la semana, 20% a la caja del bonus y 7,5% para vos, del que ya se descuenta el 2,5% que cobró el mercado (te llega el 5%). Ejemplo: un ticket de 5 RON → te llegan 4,875 → 3,625 al pozo, 1 a la caja y 0,25 a tu billetera. Los porcentajes se cambian con `setSplit`.
- **Onigiri dorado.** Cuando termina la partida, el árbitro (el servidor del juego) la cierra y, si hubo dorada, el premio queda anotado a nombre del jugador. El jugador lo cobra desde el juego con `claimGold`. Si la caja no alcanza, el premio le aparece pendiente hasta que la cargues; puede cobrar una parte ahora y el resto después.
- **Partidas a la vez.** Pueden jugar todos los que quieran al mismo tiempo. Una partida solo arranca si la caja, después de descontar los premios pendientes, tiene 105 RON por ticket (un premio de ×21).
- **Pozo semanal.** El lunes 00:00 UTC cierra la semana. El árbitro publica cuánto le toca a cada billetera; una hora después cada jugador cobra desde el juego. Tiene hasta el final de la semana siguiente.

## Por qué es seguro aunque roben la clave del árbitro

- Una partida paga como máximo 105 RON por ticket (21 × 5 RON), y una sola vez.
- Si la caja no tiene 105 RON libres por ticket, la partida no arranca.
- Lo que se debe a jugadores no lo podés retirar por error: `withdrawBonus` solo saca la parte libre.
- Una semana solo reparte lo que vos cargaste para esa semana, y recién cuando terminó.
- Hay una hora entre que el árbitro publica el reparto y que se puede cobrar: si algo está mal, lo anulás con `voidResult`.
- Solo vos (OWNER) podés sacar RON o tickets del contrato.

## Deploy (Remix)

1. Compilar `CAGnaval.sol` (EVM version: **paris** · Optimization: tildada).
2. Deploy → Browser Extension → MetaMask en la red correcta, cuenta OWNER.
3. Constructor:
   - `_ticket` = dirección de la colección ERC-1155 de los tickets (para la prueba, las bebidas de CAG: `0xb170845fccd48c7c055235e8435312568ff93f09`)
   - `_ticketId` = número del ítem dentro de la colección (para la prueba, `1` = CAG Energy Drink)
   - `_referee` = billetera del árbitro (el servidor; te la paso yo)
4. Anotar la dirección del contrato.

## Operación de cada semana

Montos en RON se escriben con 18 ceros (1 RON = `1000000000000000000`). En Remix el valor a mandar va en el campo **Value**, arriba del botón Deploy.

| Qué | Función | Detalle |
|---|---|---|
| Cargar las ventas (reparte solo) | `deposit(week)` | `week` = `currentWeek()`. Mandar en Value lo que te llegó de las ventas. |
| Cargar solo la caja del bonus | `fundBonus` | Mandar RON en Value. Habilita el cobro de premios pendientes. |
| Cargar el pozo de una semana | `fundPool(week)` | `week` = `currentWeek()`. Mandar RON en Value. Se puede cargar en varias veces. |
| Retirar tickets para volver a venderlos | `withdrawTickets(amount, to)` | Van a la billetera `to`. Ver cuántos hay con `ticketsHeld()`. |
| Sacar RON de la caja | `withdrawBonus(amount, to)` | Solo la parte libre (`bonusFree()`); lo que se debe a jugadores no se puede tocar. |
| Cambiar porcentajes | `setSplit(poolBps, bonusBps, feeBps, treasury)` | En centésimos de por ciento, sobre el precio completo: 7250 = 72,5%, 2000 = 20%, 250 = 2,5% del mercado. Lo que sobra va a `treasury`. |
| Cambiar de colección de tickets | `setTicket(ticket, ticketId)` | Por ejemplo, de las bebidas de prueba a los tickets de CAGnaval. Sin partidas abiertas. Pozos y caja se mantienen. |
| Retirar tickets de una colección anterior | `withdrawItems(token, id, amount, to)` | |
| Pasar lo no cobrado a otra semana | `rollover(fromWeek, toWeek)` | Lo hace el árbitro solo; vos también podés. |
| Anular un premio mal publicado | `voidResult(week, player)` | Antes de que lo cobre. |
| Cerrar una partida trabada | `cancelRun(runId)` | Solo si pasó un día y el árbitro no la cerró. No paga nada. |
| Pausar todo | `setPaused(true)` | Frena partidas nuevas y cobros. |

## Ajustes (`setConfig`)

| Campo | Valor inicial | Qué es |
|---|---|---|
| `maxTickets` | 5 | Tickets máximos por partida |
| `capPerTicket` | 105 RON | Premio máximo de la dorada por ticket, y lo mínimo que tiene que tener la caja por ticket para arrancar. Para probar con poca plata se puede bajar (por ejemplo a 1 RON). |
| `claimDelay` | 3600 (1 hora) | Espera entre publicar el reparto y poder cobrar |
| `claimWeeks` | 1 | Semanas para cobrar después del cierre |

## Consultas útiles (gratis)

`currentWeek()`, `weekEndsAt(week)`, `weekPool(week)`, `weekAssigned(week)`, `weekClaimed(week)`, `leftover(week)`, `claimable(player, week)`, `bonusBox()`, `bonusFree()`, `goldPending()`, `goldClaimable(player)`, `poolBps()`, `bonusBps()`, `feeBps()`, `openRuns()`, `runCount()`, `getRun(runId)`, `ticketsHeld()`.

## Para revisar el contrato (técnico)

```
cd contracts && npm install && npm run check
```

Compila y prueba todo en una cadena simulada (46 casos, incluidos intentos de trampa).
