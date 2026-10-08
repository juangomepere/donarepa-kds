import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { Timestamp, collection, onSnapshot, query, where } from 'firebase/firestore';
import { auth, db } from '../firebase/init';
import { DEFAULT_CONFIG, toConfig, toDishStats, toOrder } from '../firebase/converters';
import { computeQueue, fifoWindow, isNoStartAlert, prepMinForItems, semaphore } from '../shared/eta';
import { formatClock, formatElapsed, minutesSince } from '../shared/time';
import type { Config, DishStats, Order } from '../shared/types';
import {
  closeTurn,
  completeOrder,
  deliverOrder,
  enrichOrder,
  markCancelSeen,
  revert,
  startOrder,
  writeHeartbeat,
  type UndoAction,
} from '../kds/kdsActions';

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const SEM_BORDER: Record<string, string> = {
  verde: 'border-green-500',
  amarillo: 'border-amber-400',
  rojo: 'border-red-600',
};

export default function Kds() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [dishStats, setDishStats] = useState<Record<string, DishStats>>({});
  const [now, setNow] = useState(() => Date.now());
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [reasonFor, setReasonFor] = useState<Order | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [search, setSearch] = useState('');
  const [showUncollected, setShowUncollected] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const enriching = useRef<Set<string>>(new Set());
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  // Tick de 1 s (tiempo transcurrido) — no escribe nada.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Demo: auto-login como kds (mientras /login real no exista).
  useEffect(() => {
    if (!auth.currentUser) {
      signInWithEmailAndPassword(auth, 'kds@donarepa.test', 'donarepa123').catch(() => {});
    }
  }, []);

  // Suscripciones.
  useEffect(() => {
    const since = Timestamp.fromMillis(startOfToday());
    const unsubOrders = onSnapshot(query(collection(db, 'orders'), where('tRecibido', '>=', since)), (snap) =>
      setOrders(snap.docs.map(toOrder)),
    );
    const unsubConfig = onSnapshot(collection(db, 'config'), (snap) => {
      const main = snap.docs.find((d) => d.id === 'main');
      setConfig(toConfig(main));
    });
    const unsubDishes = onSnapshot(collection(db, 'dish_stats'), (snap) => {
      const m: Record<string, DishStats> = {};
      snap.docs.forEach((d) => (m[d.id] = toDishStats(d)));
      setDishStats(m);
    });
    return () => {
      unsubOrders();
      unsubConfig();
      unsubDishes();
    };
  }, []);

  // Red online/offline.
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Heartbeat cada 15 s mientras la página esté visible (RF-20).
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState === 'visible') void writeHeartbeat(db);
    };
    beat();
    const t = setInterval(beat, 15_000);
    return () => clearInterval(t);
  }, []);

  const active = useMemo(
    () =>
      orders
        .filter((o) => o.status === 'recibido' || o.status === 'en_preparacion')
        .sort((a, b) => (a.queueAt ?? 0) - (b.queueAt ?? 0)),
    [orders],
  );
  const ready = useMemo(
    () => orders.filter((o) => o.status === 'listo').sort((a, b) => (a.tListo ?? 0) - (b.tListo ?? 0)),
    [orders],
  );
  const cancelAlerts = useMemo(
    () => orders.filter((o) => o.status === 'cancelado' && o.cancelSeen === false),
    [orders],
  );

  const queue = useMemo(() => computeQueue(active, config, now), [active, config, now]);
  const entryBySale = useMemo(() => new Map(queue.map((e) => [e.order.saleId, e])), [queue]);
  const fifoSet = useMemo(() => new Set(fifoWindow(active, config.c)), [active, config.c]);

  const uncollected = ready.filter((o) => minutesSince(o.tListo, now) > config.uncollectedMin);
  const freshReady = ready.filter((o) => minutesSince(o.tListo, now) <= config.uncollectedMin);

  // Enriquecimiento de pedidos nuevos.
  useEffect(() => {
    for (const o of active) {
      if (o.prepMin != null || o.status !== 'recibido' || !o.token || enriching.current.has(o.saleId)) continue;
      enriching.current.add(o.saleId);
      const prepMin = prepMinForItems(o.items, dishStats, config);
      const withPrep = active.map((x) => (x.saleId === o.saleId ? { ...x, prepMin } : x));
      const entry = computeQueue(withPrep, config, Date.now()).find((e) => e.order.saleId === o.saleId)!;
      enrichOrder(db, o.saleId, {
        prepMin,
        etaCommittedMin: entry.etaMin,
        waitCommittedMin: entry.waitMin,
      }).finally(() => enriching.current.delete(o.saleId));
    }
  }, [active, config, dishStats]);

  const pushUndo = useCallback(
    (u: UndoAction) => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      setUndo(u);
      undoTimer.current = setTimeout(() => setUndo(null), config.undoSec * 1000);
    },
    [config.undoSec],
  );

  const handleStart = useCallback(
    async (o: Order, reason?: 'producto_rapido' | 'otro') => {
      await startOrder(db, o, reason);
      pushUndo({ saleId: o.saleId, token: o.token, label: `Pedido #${o.number} iniciado`, from: 'recibido', to: 'en_preparacion', clearField: 'tInicio' });
    },
    [pushUndo],
  );

  const handleComplete = useCallback(
    async (o: Order) => {
      const { acceptedDishIds } = await completeOrder(db, o);
      pushUndo({ saleId: o.saleId, token: o.token, label: `Pedido #${o.number} completado`, from: 'en_preparacion', to: 'listo', clearField: 'tListo', acceptedDishIds });
    },
    [pushUndo],
  );

  const handleDeliver = useCallback(
    async (o: Order) => {
      await deliverOrder(db, o);
      pushUndo({ saleId: o.saleId, token: o.token, label: `Pedido #${o.number} entregado`, from: 'listo', to: 'entregado', clearField: 'tEntregado' });
    },
    [pushUndo],
  );

  const handleUndo = useCallback(async () => {
    if (!undo) return;
    const u = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    await revert(db, u);
  }, [undo]);

  async function goFullscreen() {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      /* no soportado */
    }
    try {
      wakeLock.current = await navigator.wakeLock?.request('screen');
    } catch {
      /* no soportado */
    }
  }
  // Re-adquiere el wake lock al volver a ser visible.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState === 'visible' && !wakeLock.current) {
        try {
          wakeLock.current = await navigator.wakeLock?.request('screen');
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  async function doCloseTurn() {
    if (!confirmClose) {
      setConfirmClose(true);
      setTimeout(() => setConfirmClose(false), 4000);
      return;
    }
    setConfirmClose(false);
    await closeTurn(db, ready);
  }

  return (
    <div className="flex h-screen flex-col bg-gray-900 text-gray-100">
      {/* Alerta de anulación en preparación (RN-06) */}
      {cancelAlerts.length > 0 && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-red-700 p-8 text-center">
          <h1 className="text-5xl font-black">PEDIDO ANULADO</h1>
          <p className="mt-4 text-3xl">
            #{cancelAlerts[0].number} fue anulado por caja mientras estaba en preparación.
          </p>
          <button
            onClick={() => markCancelSeen(db, cancelAlerts[0].saleId)}
            className="mt-10 min-h-14 rounded-xl bg-white px-16 py-5 text-3xl font-bold text-red-700"
          >
            Visto
          </button>
        </div>
      )}

      {!online && (
        <div className="bg-amber-500 py-2 text-center text-lg font-bold text-black">
          Sin conexión — trabajando offline, se sincronizará al volver la red
        </div>
      )}

      <header className="flex items-center justify-between bg-gray-800 px-6 py-3">
        <h1 className="text-2xl font-bold">Cocina · Doñarepa</h1>
        <div className="flex gap-3">
          <button onClick={goFullscreen} className="min-h-14 rounded-lg bg-gray-700 px-5 text-lg">
            Pantalla completa
          </button>
          <button
            onClick={doCloseTurn}
            className={`min-h-14 rounded-lg px-5 text-lg ${confirmClose ? 'bg-red-600 font-bold' : 'bg-gray-700'}`}
          >
            {confirmClose ? '¿Confirmar cierre de turno?' : 'Cerrar turno'}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Cola */}
        <main className="flex-1 overflow-y-auto p-4">
          <h2 className="mb-3 text-xl font-bold">Cola ({active.length})</h2>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {active.map((o) => {
              const entry = entryBySale.get(o.saleId);
              const sem = semaphore(o, now);
              const inPrep = o.status === 'en_preparacion';
              const noStart = isNoStartAlert(o, now, config);
              const canStart = fifoSet.has(o.saleId);
              return (
                <article key={o.saleId} className={`rounded-xl border-l-8 bg-gray-800 p-4 ${SEM_BORDER[sem]}`}>
                  <div className="flex items-start justify-between">
                    <span className="text-4xl font-black">#{o.number}</span>
                    <div className="text-right">
                      <div className="text-sm text-gray-400">transcurrido</div>
                      <div className="font-mono text-2xl">{formatElapsed(o.queueAt, now)}</div>
                    </div>
                  </div>
                  {o.pager && <div className="mt-1 text-lg">Llamador {o.pager}</div>}
                  {noStart && (
                    <span className="mt-2 inline-block rounded bg-red-600 px-2 py-1 text-sm font-bold">SIN INICIAR</span>
                  )}

                  <ul className="my-3 space-y-1 text-xl">
                    {o.items.map((it, i) => (
                      <li key={i}>
                        <span className="font-bold">{it.qty}×</span> {it.name}
                        {it.notes && <span className="text-amber-300"> — {it.notes}</span>}
                      </li>
                    ))}
                  </ul>
                  {o.notes && (
                    <div className="mb-3 rounded bg-amber-500/20 px-2 py-1 text-amber-200">Obs: {o.notes}</div>
                  )}

                  <div className="mb-3 flex justify-between text-lg text-gray-300">
                    <span>{inPrep ? 'En preparación' : `Posición ${(entry?.position ?? 0) + 1}`}</span>
                    <span>
                      ETA {entry?.etaMin ?? '–'} min · {formatClock(entry?.estimatedReadyAt ?? null)}
                    </span>
                  </div>

                  {inPrep ? (
                    <button
                      onClick={() => handleComplete(o)}
                      className="min-h-14 w-full rounded-lg bg-green-600 text-2xl font-bold"
                    >
                      Completado
                    </button>
                  ) : (
                    <StartButton order={o} canStart={canStart} onStart={handleStart} onReason={setReasonFor} />
                  )}
                </article>
              );
            })}
            {!active.length && <p className="text-gray-500">Cola vacía</p>}
          </div>
        </main>

        {/* Listos para entrega */}
        <aside className="flex w-96 flex-col overflow-y-auto border-l border-gray-700 bg-gray-800 p-4">
          <h2 className="mb-3 text-xl font-bold">Listos para entrega ({freshReady.length})</h2>
          <div className="space-y-3">
            {freshReady.map((o) => (
              <div key={o.saleId} className="rounded-xl bg-gray-700 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-5xl font-black">{o.pager ?? `#${o.number}`}</span>
                  <span className="text-sm text-gray-400">{formatElapsed(o.tListo, now)}</span>
                </div>
                <button
                  onClick={() => handleDeliver(o)}
                  className="mt-3 min-h-14 w-full rounded-lg bg-blue-600 text-2xl font-bold"
                >
                  Entregado
                </button>
              </div>
            ))}
            {!freshReady.length && <p className="text-gray-500">Nada listo aún</p>}
          </div>

          {/* Sin recoger (colapsado, RN-05) */}
          {uncollected.length > 0 && (
            <div className="mt-6">
              <button
                onClick={() => setShowUncollected((v) => !v)}
                className="min-h-14 w-full rounded-lg bg-gray-700 px-4 text-left text-lg font-bold"
              >
                Sin recoger ({uncollected.length}) {showUncollected ? '▲' : '▼'}
              </button>
              {showUncollected && (
                <div className="mt-2 space-y-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar por número"
                    className="w-full rounded bg-gray-900 px-3 py-2"
                  />
                  {uncollected
                    .filter((o) => !search || String(o.number).includes(search))
                    .map((o) => (
                      <div key={o.saleId} className="flex items-center justify-between rounded bg-gray-700 px-3 py-2">
                        <span className="text-2xl font-bold">{o.pager ?? `#${o.number}`}</span>
                        <button onClick={() => handleDeliver(o)} className="min-h-14 rounded bg-blue-600 px-4 font-bold">
                          Entregado
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* Toast Deshacer (RN-04) */}
      {undo && (
        <div className="fixed bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-4 rounded-xl bg-gray-700 px-6 py-3 shadow-lg">
          <span className="text-lg">{undo.label}</span>
          <button onClick={handleUndo} className="min-h-14 rounded-lg bg-white px-6 text-lg font-bold text-gray-900">
            Deshacer
          </button>
        </div>
      )}

      {/* Hoja de motivos para iniciar fuera de la ventana FIFO (RN-02) */}
      {reasonFor && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/50" onClick={() => setReasonFor(null)}>
          <div className="w-full rounded-t-2xl bg-gray-800 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-xl font-bold">Iniciar #{reasonFor.number} fuera de orden — motivo</h3>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => {
                  handleStart(reasonFor, 'producto_rapido');
                  setReasonFor(null);
                }}
                className="min-h-14 rounded-xl bg-gray-700 py-6 text-xl font-bold"
              >
                Producto rápido
              </button>
              <button
                onClick={() => {
                  handleStart(reasonFor, 'otro');
                  setReasonFor(null);
                }}
                className="min-h-14 rounded-xl bg-gray-700 py-6 text-xl font-bold"
              >
                Otro
              </button>
            </div>
            <button onClick={() => setReasonFor(null)} className="mt-4 min-h-14 w-full rounded-lg bg-gray-600 text-lg">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Botón Iniciar: click directo si está en la ventana FIFO; si no, pulsación larga (800 ms).
function StartButton({
  order,
  canStart,
  onStart,
  onReason,
}: {
  order: Order;
  canStart: boolean;
  onStart: (o: Order) => void;
  onReason: (o: Order) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const down = () => {
    if (canStart) return;
    timer.current = setTimeout(() => onReason(order), 800);
  };
  const up = () => timer.current && clearTimeout(timer.current);
  return (
    <button
      onClick={() => canStart && onStart(order)}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      className={`min-h-14 w-full rounded-lg text-2xl font-bold ${canStart ? 'bg-amber-500 text-black' : 'bg-gray-700 text-gray-400'}`}
    >
      Iniciar{!canStart && ' (mantén pulsado)'}
    </button>
  );
}
