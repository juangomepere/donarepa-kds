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
