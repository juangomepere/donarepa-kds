# Prueba manual guiada — KDS

Checklist de verificación de `/kds` contra las reglas de negocio de `CLAUDE.md`.

## Cómo verificar

**Automático (fuente de los resultados de abajo).** El e2e `src/kds/kds.emulator.test.ts`
ejercita el **mismo código** que usan las páginas (`posBridge`, `kdsActions`, `eta.ts`)
a través de las reglas reales de Firestore, con dos sesiones (pos y kds):

```bash
# requiere un JRE en el PATH (ver README); arranca emuladores y corre todo
npm run test:emulator
```

Última corrida: **13/13 en verde** (11 e2e de cocina + 2 del bridge).

**Manual en navegador** (opcional, mismo guion):

```bash
npm run emulators          # terminal 1 (JRE en PATH)
npm run seed               # terminal 2
npm run dev                # terminal 3
```

Abre `/pos-sim` y `/kds` en dos pestañas. En `/pos-sim` usa “Simular 10 pedidos”
o crea 8 a mano; opera la cola en `/kds`.

## Resultados

| # | Regla | Paso | Resultado |
|---|-------|------|-----------|
| 1 | RN-01 | 8 pedidos creados en POS; la cola del KDS los muestra ordenados por `queueAt`, sin reordenar | ✅ `queueAt` estrictamente ascendente |
| 2 | Enriquecimiento | Al llegar sin `prepMin`, la tablet escribe `prepMin`/`etaCommittedMin`/`waitCommittedMin` en transacción (solo si vacíos), en `orders` y `public` | ✅ `prepMin=8.4`, ETA comprometida > 0 |
| 3 | RN-02 (ventana) | Con 0 en preparación y c=5, “Iniciar” habilitado solo para los 5 más antiguos | ✅ 5 habilitados = `slice(0,5)` |
| 4 | RN-12 | Semáforo por `minutos desde queueAt / etaCommittedMin` | ✅ verde recién creado |
| 5 | RN-13 | Badge “SIN INICIAR” cuando `minutos desde queueAt > waitCommittedMin + 5` | ✅ false al inicio, true pasado el umbral |
| 6 | Iniciar (dentro) | `recibido → en_preparacion`, `tInicio` con serverTimestamp, batch `orders`+`public` | ✅ ambos docs en `en_preparacion` |
| 7 | RN-02 (fuera) | Pulsación larga → motivo → `outOfOrderReason` guardado | ✅ `outOfOrderReason='otro'` |
| 8 | RN-11 | “Completado”: muestra `(tListo − tInicio)` agregada a `dish_stats` de cada plato con descarte de atípicos | ✅ muestra 10 añadida, estado `listo` |
| 9 | RN-04 | Toast “Deshacer” 30 s: revierte estado + limpia timestamp + registra `reversions` + quita la muestra | ✅ vuelve a `en_preparacion`, `tListo=null`, `reversions≥1`, muestra retirada |
| 10 | RN-06 | POS anula un pedido en preparación → `cancelSeen=false`; KDS muestra alerta roja de pantalla completa; “Visto” → `cancelSeen=true`; sale de la cola | ✅ `cancelado`+`cancelSeen=false`, fuera de la cola, luego `true` |
| 11 | Recálculo | El cancelado desaparece de la cola activa y todo se recalcula | ✅ ausente de la cola activa |
| 12 | RN-05 | “Cerrar turno” (confirmación doble) pasa los listos pendientes a `no_recogido` | ✅ `listo → no_recogido` |
| 13 | Entrega | “Entregado” en un listo → `entregado` (batch `orders`+`public`) | ✅ `entregado` |

## Comprobaciones no cubiertas por el e2e (requieren navegador/tablet)

- **RN-05 “Sin recoger”**: lista colapsada para listos > 30 min con buscador por número
  (derivado en UI, cero escrituras). Lógica de corte verificada vía `minutesSince`.
- **Heartbeat** `heartbeats/kds` cada 15 s con página visible.
- **Persistencia offline** + banner “Sin conexión” (requiere cortar la red real).
- **Pantalla completa** (Fullscreen API) y **wake lock** (APIs de navegador).
- **Tiempo transcurrido** actualizándose cada segundo (tick de cliente).
- **Pulsación larga de 800 ms** (gesto táctil) y **botones ≥ 56 px** (inspección visual).
