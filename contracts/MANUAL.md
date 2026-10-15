# CAGnaval — manual del contrato (borrador)

Contrato: `CAGnaval.sol` (un solo archivo, se abre en Remix igual que CAGlorie).
Descripción de funciones: `build/CAGnaval.abi.json`.

## Qué hace

- **Partidas.** El jugador manda de 1 a 25 tickets (ERC-1155) al contrato y empieza una partida. Una sola transacción, sin aprobar nada antes, como las bebidas de CAGlorie. Los tickets quedan guardados en el contrato.
- **Ventas.** Tu 5% te llega directo de Ronin Market como comisión de creador (creator fee) de la colección. Lo que te llega como vendedor (el 92,5%, ya sin el 2,5% del mercado ni tu 5%) lo mandás entero con `deposit`. El contrato reconstruye la venta original y reparte sobre el precio completo del ticket: 72,5% al pozo de la semana y 20% a la caja del bonus. Ejemplo: un ticket de 1 RON → te llegan 0,925 → 0,725 al pozo y 0,2 a la caja. Los porcentajes se cambian con `setSplit` (pozo 7250, caja 2000, comisiones ya descontadas 750).
- **Onigiri dorado.** Cuando termina la partida, el árbitro (el servidor del juego) la cierra y, si hubo dorada, el premio queda anotado a nombre del jugador. El jugador lo cobra desde el juego con `claimGold`. Siempre lo cobra completo: si la caja no tiene el total, le aparece pendiente hasta que la cargues.
- **Partidas a la vez.** Pueden jugar todos los que quieran al mismo tiempo. Una partida solo arranca si la caja, después de descontar los premios pendientes, tiene 21 RON por ticket (un premio de ×21 con tickets de 1 RON).
- **Pozo semanal.** El lunes 00:00 UTC cierra la semana. Tenés 24 horas más (`fundGrace`) para cargar el pozo de esa semana con `deposit(semana)`. Después el árbitro publica cuánto le toca a cada billetera (o antes, si se lo pedís desde el panel); una hora después cada jugador cobra desde el juego, hasta el final de la semana siguiente.
- **Panel de admin.** Todo lo de este manual se puede hacer desde `https://<tu-sitio>/admin`, conectando la billetera dueña, sin entrar a Remix.

## Por qué es seguro aunque roben la clave del árbitro

- Una partida paga como máximo 21 RON por ticket (21 × 1 RON), y una sola vez.
- Si la caja no tiene 21 RON libres por ticket, la partida no arranca.
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
   - `_referee` = billetera del árbitro (el servidor): `0x7161ed75cE7fe248E46FBd20f9f0741D08C3fd61`
4. Anotar la dirección del contrato.

## Operación de cada semana

Montos en RON se escriben con 18 ceros (1 RON = `1000000000000000000`). En Remix el valor a mandar va en el campo **Value**, arriba del botón Deploy.

| Qué | Función | Detalle |
|---|---|---|
| Cargar las ventas (reparte solo) | `deposit(week)` | `week` = `currentWeek()`, o la semana anterior durante las 24 h después del cierre. Mandar en Value lo que te llegó de las ventas. |
| Cargar solo la caja del bonus | `fundBonus` | Mandar RON en Value. Habilita el cobro de premios pendientes. |
| Billetera operadora | `setOperator(address)` | Solo la dueña. Billetera de uso diario: puede pausar/reanudar, anular premios (`voidResult`), mover lo no cobrado (`rollover`), liberar partidas trabadas (`cancelRun`) y entrar al panel. Nunca saca RON ni tickets ni cambia ajustes. Para quitarla: `setOperator(0x0000000000000000000000000000000000000000)`. |
| Premio extra para una semana | `fundPool(week)` | `week` = `currentWeek()`. Mandar RON en Value. Va 100% al pozo (nada a la dorada) y queda anotado en `weekExtra(week)`, así los jugadores ven el pozo con el extra. Más fácil: botón "Sumar premio extra" del panel. |
| Retirar tickets para volver a venderlos | `withdrawTickets(amount, to)` | Van a la billetera `to`. Ver cuántos hay con `ticketsHeld()`. |
| Sacar RON de la caja | `withdrawBonus(amount, to)` | Solo la parte libre (`bonusFree()`); lo que se debe a jugadores no se puede tocar. |
| Cambiar porcentajes | `setSplit(poolBps, bonusBps, feeBps, treasury)` | En centésimos de por ciento, sobre el precio completo: 7250 = 72,5%, 2000 = 20%, 750 = comisiones ya descontadas (2,5% del mercado + 5% tuyo). Lo que sobra va a `treasury`. |
| Cambiar de colección de tickets | `setTicket(ticket, ticketId)` | Por ejemplo, de las bebidas de prueba a los tickets de CAGnaval. Sin partidas abiertas. Pozos y caja se mantienen. |
| Retirar tickets de una colección anterior | `withdrawItems(token, id, amount, to)` | |
| Pasar lo no cobrado a otra semana | `rollover(fromWeek, toWeek)` | Cuando terminó el plazo de cobro. |
| Retirar lo no cobrado | `recoverPool(week, to)` | Cuando terminó el plazo de cobro de esa semana (una semana después del reparto). |
| Anular un premio mal publicado | `voidResult(week, player)` | Antes de que lo cobre. |
| Cerrar una partida trabada | `cancelRun(runId)` | Solo si pasó un día y el árbitro no la cerró. No paga nada. |
| Pausar todo | `setPaused(true)` | Frena partidas nuevas y cobros. |
| Horas para cargar el pozo después del cierre | `setFundGrace(segundos)` | 86400 = 24 h (máximo 3 días). |

## Ajustes (`setConfig`)

| Campo | Valor inicial | Qué es |
|---|---|---|
| `maxTickets` | 25 | Tickets máximos por partida. Se puede subir hasta 1000; la caja igual limita sola cuántos se pueden usar (21 RON libres por ticket). |
| `capPerTicket` | 21 RON | Premio máximo de la dorada por ticket, y lo mínimo que tiene que tener la caja por ticket para arrancar. Para probar con poca plata se puede bajar (por ejemplo a 1 RON). |
| `claimDelay` | 3600 (1 hora) | Espera entre publicar el reparto y poder cobrar |
| `claimWeeks` | 1 | Semanas para cobrar después del cierre |

## Consultas útiles (gratis)

`currentWeek()`, `weekEndsAt(week)`, `weekPool(week)`, `weekAssigned(week)`, `weekClaimed(week)`, `leftover(week)`, `claimable(player, week)`, `bonusBox()`, `bonusFree()`, `goldPending()`, `goldClaimable(player)`, `poolBps()`, `bonusBps()`, `feeBps()`, `openRuns()`, `runCount()`, `getRun(runId)`, `ticketsHeld()`.

## Para revisar el contrato (técnico)

```
cd contracts && npm install && npm run check
```

Compila y prueba todo en una cadena simulada (49 casos, incluidos intentos de trampa).

## Tienda de tickets (en la página)

Los jugadores compran tickets desde el juego. La compra se hace en Ronin Market (con la herramienta oficial de Sky Mavis): se compran las publicaciones más baratas del ticket, de cualquier vendedor, y se paga en RON desde la billetera del jugador. Las comisiones y el volumen son los de Ronin Market. El servidor nunca toca el RON.

Variables de Railway (opcionales):
- `MARKET=off` oculta la tienda.
- `MARKET_API_KEY`: clave de la Developer Console de Sky Mavis, solo si Ronin Market la pide.
