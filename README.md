# Doñarepa KDS

Sistema de pantalla de cocina (**KDS — Kitchen Display System**) que reemplaza la comanda
impresa caja→cocina del restaurante **Doñarepa** (The Wagon, Cajicá) por un flujo digital
en tiempo real: la caja publica cada venta, la cocina gestiona los estados en una tablet,
y el cliente ve su posición y tiempo estimado escaneando un QR del recibo.

> Proyecto de la **Gerencia de Operaciones de TI — Universidad de La Sabana**.
> Alcance completo y reglas de negocio en [`CLAUDE.md`](./CLAUDE.md).

---

## 🔗 Demo en vivo

**https://donarepa-kds-production.up.railway.app**

| Pantalla | Enlace | Qué es |
|----------|--------|--------|
| 🧾 Caja (POS) | [`/pos-sim`](https://donarepa-kds-production.up.railway.app/pos-sim) | Simulador del punto de venta: crea pedidos e imprime recibo con QR |
| 👨‍🍳 Cocina (KDS) | [`/kds`](https://donarepa-kds-production.up.railway.app/kds) | Cola de preparación con estados, ETA y semáforo |
| 📺 Monitor de sala | [`/monitor`](https://donarepa-kds-production.up.railway.app/monitor) | Pantalla de la zona de espera (En preparación / Listos) |
| 📱 Seguimiento cliente | `/t/:token` | Se abre al escanear el QR del recibo (sin app, sin registro) |

### Recorrido sugerido para evaluar (2 minutos)

1. Abre **`/pos-sim`** y pulsa **“Simular 10 pedidos”** (o arma una venta a mano y “Cerrar venta”; sale un recibo con QR).
2. En **otra ventana (o incógnito)** abre **`/kds`**: verás la cola llenarse en tiempo real. Pulsa **Iniciar** → **Completado**; prueba **Deshacer** (30 s).
3. Abre **`/monitor`**: los números pasan de *En preparación* a *Listos* (parpadean 10 s).
4. Escanea el **QR del recibo** (o abre `/t/<token>`) para ver, como cliente, estado + posición + hora estimada.

> 💡 Abre POS y KDS en ventanas/navegadores distintos: la sesión de Firebase se comparte
> entre pestañas del mismo navegador. Las pantallas públicas (`/monitor`, `/t/:token`) no
> necesitan nada. Añade `?debug=1` a `/monitor` o `/t/...` para ver la latencia (métrica K5).

---

## Arquitectura

```
  Caja (/pos-sim) ──publica venta──►  ┌─────────────┐  ◄──escucha── Cocina (/kds)
                                      │  Firestore   │
  Cliente (/t/:token) ──lee──────────►│  (tiempo real)│──► Monitor (/monitor)
                                      └─────────────┘
```

- **Frontend:** React + Vite + TypeScript (una sola SPA) — desplegado en **Railway**.
- **Backend:** **Firebase** (Firestore + Auth), plan **Spark (gratis)**, **sin Cloud Functions**.
  Toda la lógica corre en el cliente; el **motor de ETA es una función pura compartida**
  ([`src/shared/eta.ts`](./src/shared/eta.ts)), probada con tests.
- **Tiempo real** vía listeners de Firestore; **persistencia offline** en el KDS para que la
  cocina siga operando sin red.

### Funcionalidades destacadas
- **ETA dinámica** por cola FIFO con concurrencia configurable, **posición** y **semáforo** (verde/amarillo/rojo).
- Estados: `recibido → en preparación → listo → entregado`, más **anulación** y **modo contingencia** (caída de red → comanda imprimible).
- **Idempotencia** de pedidos, **reintentos** con backoff y **deshacer** de 30 s.
- Aprendizaje de tiempos: cada plato promedia sus últimas muestras reales de preparación.
- Seguimiento del cliente **por QR, sin instalar nada**; monitor de sala a 16:9.

### Stack
`Vite` · `React` · `TypeScript` · `Tailwind CSS` · `React Router` · `Firebase (Firestore + Auth)` · `Vitest` · `Docker` (para Railway).

---

## Correr en local (opcional, para desarrollo)

Requisitos: Node 20+ y **Java** (el emulador de Firestore lo necesita).

```bash
npm install
npm run emulators   # Terminal 1 — Firestore/Auth/Hosting + UI
npm run seed        # Terminal 2 — config + 8 platos + 4 usuarios (emuladores arriba)
npm run dev         # Terminal 3 — app en http://localhost:5173
```

Usuarios de prueba: `pos@`, `kds@`, `gerente@`, `admin@donarepa.test` — contraseña `donarepa123`.

### Pruebas
```bash
npm run test            # unitarias (motor de ETA + lógica del bridge)
npm run test:emulator   # e2e contra la Emulator Suite (requiere Java)
```
Checklist de verificación funcional del KDS: [`docs/pruebas-kds.md`](./docs/pruebas-kds.md).

### Scripts
| script | qué hace |
|--------|----------|
| `npm run dev` | servidor de desarrollo (Vite) |
| `npm run emulators` | Firebase Emulator Suite |
| `npm run seed` | siembra el emulador (`-- --prod` siembra producción con una service account) |
| `npm run simulate` | publica 10 pedidos de demo |
| `npm run test` / `test:emulator` | pruebas |
| `npm run build` | build de producción → `dist/` |

Despliegue (Railway + Firebase en la nube): ver [`DEPLOY.md`](./DEPLOY.md).

---

## Notas

- Es una **demostración**: `/pos-sim` y `/kds` inician sesión automáticamente con cuentas de
  prueba (aún no hay pantalla `/login`). Las credenciales son de demo, no de producción real.
- Estructura del código y modelo de datos documentados en [`CLAUDE.md`](./CLAUDE.md).
- Pendiente por diseño: pantallas reales de `/login` y `/admin`.

---

## Limitaciones técnicas y recomendaciones de mantenimiento

### Limitaciones conocidas

| Área | Limitación |
|------|-----------|
| **Cuota Firebase Spark** | 50 k lecturas / 20 k escrituras por día. Con ~120 pedidos/día hay margen, pero picos de demanda o bugs de escritura pueden agotarla. El heartbeat del KDS consume ~1 920 escrituras/día (cada 15 s × 8 h). |
| **Sin Cloud Functions** | Toda la lógica corre en cliente. No hay tareas programadas: el cierre de turno, la expiración de tokens y el recálculo de estadísticas son responsabilidad de las pantallas abiertas en ese momento. |
| **ETA FIFO simple** | El motor asume una sola cocina con `c` puestos idénticos. No modela estaciones separadas (plancha/freidora), variaciones de personal ni dependencias entre platos. |
| **Una sola cola** | No hay soporte para múltiples estaciones de cocina ni múltiples cajas simultáneas. |
| **Ordenación en cliente** | Para evitar índices compuestos en Spark, los pedidos se ordenan en memoria. Cada cliente descarga todos los pedidos activos; con colas muy largas aumenta el tráfico. |
| **Ventana de aprendizaje de platos** | `dish_stats` guarda las últimas 20 muestras. Platos nuevos o de bajo volumen usan `defaultPrepMin` hasta alcanzar `minSamples` (5 por defecto). |
| **Contingencia por instancia** | El modo contingencia de `posBridge` es estado local en memoria; si se recarga la página o hay varias terminales POS, cada instancia gestiona su propio modo. |
| **Expiración de QR en 2 horas** | El enlace `/t/:token` expira 2 h después de creado. Pedidos que tarden más (ej. cierre de turno tardío) mostrarán "Pedido finalizado". |
| **Login automático en demo** | `/pos-sim` y `/kds` inician sesión con cuentas de prueba; no existe pantalla `/login` ni `/admin` todavía. |

### Recomendaciones de mantenimiento

1. **Primera semana de operación real:** revisar en Firebase Console el consumo de cuota diario; ajustar parámetros de `config/main` (`c`, `defaultPrepMin`, `noStartGraceMin`) según el comportamiento real de la cocina.

2. **Si el volumen crece:** migrar a plan Blaze (pago por uso) para habilitar Cloud Functions y exportaciones automáticas de Firestore. Esto permite mover la validación de ETA al servidor y programar tareas de limpieza nocturna.

3. **Antes de producción real:** reemplazar el login automático por las pantallas `/login` y `/admin`; rotar las credenciales de demo; revisar las reglas de Firestore (`firestore.rules`) para el contexto de personal real.

4. **Sembrar `dish_stats` inicialmente:** ejecutar `npm run seed` con tiempos reales de preparación para que el motor de ETA no arranque todo en `defaultPrepMin` durante los primeros turnos.

5. **Monitorear la alerta de KDS inactivo:** si `watchKdsHealth` reporta `kds_inactivo` con frecuencia, verificar la conexión de red de la tablet de cocina o aumentar el umbral `STALE_MS` en `posBridge.ts`.

6. **Revisar `dish_stats` tras cambios de menú:** cuando se agrega un plato nuevo o cambia su receta, sus 20 muestras anteriores pueden quedar obsoletas; limpiarlas desde `/admin` o directamente en Firestore.
