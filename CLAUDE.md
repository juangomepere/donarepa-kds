# Doñarepa KDS — MVP (Gerencia de Operaciones de TI, U. de La Sabana)

## Qué es
Reemplazar la comanda impresa caja→cocina del restaurante Doñarepa (The Wagon, Cajicá) por un flujo digital:
POS Indie (software propio, acceso total al código) publica cada venta → KDS en tablet de cocina con estados →
cliente ve estado/posición/ETA por QR impreso en el recibo → monitor de turnos en zona de espera → reporte de KPIs.
Una sola sede, una sola cola de cocina, pedidos en caja (local o para llevar). Sin domicilios, pagos, inventario ni apps nativas.

## Stack (no cambiar sin preguntar)
- Vite + React + TypeScript + Tailwind. Una sola SPA con rutas: `/pos-sim`, `/kds`, `/monitor`, `/t/:token`, `/admin`, `/login`.
- Firebase: Firestore + Auth (email/contraseña) + Hosting. **Plan Spark (gratis): NO usar Cloud Functions** (requieren plan Blaze).
  Toda la lógica corre en clientes; el cálculo de ETA es una función pura compartida.
- Firebase Emulator Suite para desarrollo y tests. Vitest para unitarias. `@firebase/rules-unit-testing` para reglas.
- Identificadores de código en inglés; textos de UI en español (Colombia). Hora local America/Bogota, formato 24 h → mostrar "12:47".

## Estructura
```
src/shared/   types.ts, eta.ts (puro, sin Firebase), rules.ts (constantes RN), time.ts
src/bridge/   posBridge.ts (publicar/anular/reemplazar con idempotencia, reintentos, contingencia) — reutilizable por el POS real
src/firebase/ init, converters, hooks (useActiveQueue, useConfig, useHeartbeat)
src/pages/    PosSim, Kds, Monitor, Track, Admin, Login
scripts/      seed.ts (usuarios, config, platos), simulate.ts (genera pedidos de demo)
firestore.rules, firestore.indexes.json, firebase.json
```

## Modelo de datos (Firestore)
- `orders/{saleId}` (saleId = id de la venta en el POS → llave única, RN-08)
  `number, pager, items[{dishId,name,qty,notes}], notes, status, channel('kds'|'contingencia'),`
  `posClosedAt (hora cliente POS), tRecibido (serverTimestamp), queueAt (= tRecibido, o el del original si es reemplazo),`
  `tInicio, tListo, tEntregado, tCancelado, prepMin, etaCommittedMin, waitCommittedMin,`
  `token, replacesSaleId?, outOfOrderReason?, cancelSeen?, reversions[{from,to,at}]`
- `public/{token}` — SOLO: `number, status, queueAt, tInicio, tListo, prepMin, expiresAt`. Sin ítems ni observaciones (RN-14, Ley 1581).
- `dish_stats/{dishId}` — `name, samples: number[] (últimos 20, minutos), avgMin`
- `config/main` — `c (5), defaultPrepMin (15), minSamples (5), uncollectedMin (30), undoSec (30), noStartGraceMin (5)`; cambios en `config/main/changes/{id}` con autor y fecha (RN-17)
- `heartbeats/kds` — `lastSeen (serverTimestamp)` cada 15 s
- `incidents/{id}` — `start, end, durationMin, cause, affectedSaleIds[]`
- `staff/{uid}` — `role: 'pos'|'kds'|'gerente'|'admin'`

Estados: `recibido → en_preparacion → listo → entregado`; `cancelado`; `no_recogido` (cierre de turno); `historico_contingencia`.
"Sin recoger" NO es un estado guardado: es `listo` con más de 30 min desde `tListo` (derivado en UI, cero escrituras).

## Motor de ETA (src/shared/eta.ts) — implementar exacto
Cola activa = pedidos `recibido` + `en_preparacion`, ordenados por `queueAt` (RN-01).
- `T(i)` = máx de `avgMin` de los platos del pedido (si un plato tiene < minSamples muestras → defaultPrepMin). Se congela en `prepMin` al enriquecer el pedido.
- `R(j)` = `T(j)` si `recibido`; `max(T(j) − minutos desde tInicio(j), 1)` si `en_preparacion`.
- `W(i)` = Σ R(j) de los pedidos anteriores a i / c.
- `ETA(i)` = `W(i) + T(i)`; si i está en preparación, `ETA(i) = R(i)`. Redondear hacia ARRIBA al minuto. Hora estimada = ahora + ETA.
- Posición = nº de pedidos activos antes de i.
- Caso de prueba obligatorio (c=5): 101 prep T15 avance 11 → R4; 102 prep T12 av 6 → R6; 103 prep T15 av 3 → R12; 104 rec T15; 105 rec T18; pedido 106 con platos 18 y 5 → T=18, W=55/5=11, **ETA=29**, posición 5.
- ETA se calcula hasta `listo` (RN-10). Se recalcula en cada snapshot y con un tick de 60 s en cliente (no escribe nada).

## Reglas de negocio clave
- RN-02 ventana FIFO: "Iniciar" habilitado para los k `recibido` más antiguos, k = max(1, c − nº en_preparacion). Fuera de ventana: pulsación larga + motivo (`producto rápido`, `otro`) → `outOfOrderReason`.
- RN-03 `listo` sale de la cola activa al instante y pasa al panel "Listos para entrega".
- RN-04 Deshacer durante 30 s; registrar en `reversions`.
- RN-05 `listo` > 30 min → lista colapsada "Sin recoger"; QR dice "Listo, pendiente de recoger". "Cerrar turno" pasa pendientes a `no_recogido`.
- RN-06 solo el POS anula. Si estaba en preparación, KDS muestra alerta roja que exige "Visto" (`cancelSeen`).
- RN-07 modificación = anular + nuevo pedido con `replacesSaleId`, hereda `queueAt`.
- RN-08 idempotencia: crear en transacción; si `orders/{saleId}` existe, devolver el token existente y no crear nada.
- RN-09 confirmación ≤ 5 s; reintentos con espera 1, 2, 4 s; tras 3 fallos alerta al cajero y propone contingencia.
- RN-11 muestra = (tListo − tInicio) en minutos, se agrega a cada plato del pedido; descartar < 1 min o > 3× mediana; ventana de 20.
- RN-12 semáforo: ratio = minutos desde queueAt / etaCommittedMin → verde < 0,8; amarillo 0,8–1; rojo > 1.
- RN-13 alerta "sin iniciar": `recibido` y minutos desde queueAt > waitCommittedMin + 5.
- RN-14 token aleatorio (crypto, ≥ 16 bytes base64url); `expiresAt` = tRecibido + 2 h; vencido → "Pedido finalizado".
- RN-15 pedidos en contingencia se guardan como `historico_contingencia`, nunca entran a la cola.
- Quién escribe qué: el POS/bridge crea `orders` + `public` en la misma transacción y anula. El KDS es el ÚNICO que cambia estados de cocina y que "enriquece" un pedido nuevo (escribe una sola vez `prepMin`, `etaCommittedMin`, `waitCommittedMin` en ambos docs, en transacción si están vacíos). Toda escritura que toque estado actualiza `orders` y `public` en el mismo batch.

## Presupuesto Spark (S4)
50k lecturas / 20k escrituras al día. ~120 pedidos/día. No hacer polling ni escrituras periódicas salvo el heartbeat (15 s). Ordenar en cliente para evitar índices compuestos. Vistas públicas escuchan solo pedidos activos + listos recientes.

## Convenciones
- Tests antes de dar algo por terminado: `npm run test` (Vitest) y tests de reglas contra el emulador.
- Commits pequeños por módulo. No dejar TODOs sin listar en README.
- UI de KDS: botones grandes (tablet 10", uso con dedos húmedos), alto contraste, sin modales salvo la alerta de anulación.
