import { useEffect, useMemo, useState } from 'react';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { Timestamp, collection, getDocs, onSnapshot } from 'firebase/firestore';
import QRCode from 'qrcode';
import { auth, db } from '../firebase/init';
import { createPosBridge, type KdsHealth, type SaleInput } from '../bridge/posBridge';
import { simulateOrders, type SimDish } from '../../scripts/simulate';
import type { OrderItem } from '../shared/types';

interface SaleRow {
  saleId: string;
  number: number;
  status: string;
  items: OrderItem[];
  pager?: string;
  notes?: string;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export default function PosSim() {
  const bridge = useMemo(() => createPosBridge(db), []);
  const [dishes, setDishes] = useState<SimDish[]>([]);
  const [cart, setCart] = useState<OrderItem[]>([]);
  const [notes, setNotes] = useState('');
  const [pager, setPager] = useState('');
  const [sales, setSales] = useState<SaleRow[]>([]);
  const [replacingId, setReplacingId] = useState<string | null>(null);
  const [health, setHealth] = useState<KdsHealth>({ connected: false, reason: 'sin_datos' });
  const [contingency, setContingency] = useState(false);
  const [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<{ number: number; qr: string; url: string } | null>(null);
  const [comanda, setComanda] = useState<SaleRow | null>(null);

  // Demo: inicia sesión como pos automáticamente (el /login real llega después).
  useEffect(() => {
    if (!auth.currentUser) {
      signInWithEmailAndPassword(auth, 'pos@donarepa.test', 'donarepa123').catch(() => {});
    }
  }, []);

  useEffect(() => {
    getDocs(collection(db, 'dish_stats')).then((snap) =>
      setDishes(snap.docs.map((d) => ({ dishId: d.id, name: d.get('name') as string }))),
    );
  }, []);

  useEffect(() => bridge.watchKdsHealth(setHealth), [bridge]);

  useEffect(() => {
    const since = startOfToday();
    return onSnapshot(collection(db, 'orders'), (snap) => {
      const rows = snap.docs
        .map((d) => ({ id: d.id, data: d.data() }))
        .filter(({ data }) => data.channel === 'kds')
        .filter(({ data }) => {
          const t = data.tRecibido as Timestamp | undefined;
          return !t || t.toMillis() >= since;
        })
        .map(({ id, data }) => ({
          saleId: id,
          number: data.number as number,
          status: data.status as string,
          items: (data.items ?? []) as OrderItem[],
          pager: data.pager as string | undefined,
          notes: data.notes as string | undefined,
        }))
        .sort((a, b) => b.number - a.number);
      setSales(rows);
    });
  }, []);

  const nextNumber = (sales[0]?.number ?? 0) + 1;

  function addDish(d: SimDish) {
    setCart((c) => {
      const found = c.find((i) => i.dishId === d.dishId);
      if (found) return c.map((i) => (i.dishId === d.dishId ? { ...i, qty: i.qty + 1 } : i));
      return [...c, { dishId: d.dishId, name: d.name, qty: 1 }];
    });
  }

  function resetCart() {
    setCart([]);
    setNotes('');
    setPager('');
    setReplacingId(null);
  }

  async function closeSale() {
    if (!cart.length) {
      setMessage('Agrega al menos un plato.');
      return;
    }
    const sale: SaleInput = {
      saleId: `pos-${Date.now()}`,
      number: nextNumber,
      pager: pager || undefined,
      items: cart,
      notes: notes || undefined,
      posClosedAt: Date.now(),
    };
    const res = replacingId ? await bridge.replaceOrder(replacingId, sale) : await bridge.publishOrder(sale);

    if (!res.ok) {
      setMessage(`No se pudo registrar: ${res.reason}. Considera activar contingencia.`);
      return;
    }
    if ('printKitchenTicket' in res) {
      setComanda({
        saleId: sale.saleId,
        number: sale.number,
        status: 'historico_contingencia',
        items: cart,
        pager: sale.pager,
        notes: sale.notes,
      });
      setMessage('Contingencia: imprime la comanda para cocina.');
      resetCart();
      return;
    }
    const url = `${window.location.origin}/t/${res.token}`;
    const qr = await QRCode.toDataURL(url, { width: 220 });
    setReceipt({ number: sale.number, qr, url });
    setMessage('');
    resetCart();
  }

  function startReplace(row: SaleRow) {
    setReplacingId(row.saleId);
    setCart(row.items);
    setPager(row.pager ?? '');
    setNotes(row.notes ?? '');
    setMessage(`Modificando pedido #${row.number}. Ajusta y presiona "Guardar cambios".`);
  }

  async function annul(row: SaleRow) {
    const res = await bridge.cancelOrder(row.saleId);
    setMessage(res.ok ? `Pedido #${row.number} anulado.` : `No se pudo anular: ${res.reason}`);
  }

  function toggleContingency() {
    const next = !contingency;
    bridge.setContingency(next);
    setContingency(next);
  }

  async function runSim() {
    if (!dishes.length) return;
    setMessage('Simulando 10 pedidos…');
    await simulateOrders(bridge.publishOrder, dishes, nextNumber, {
      count: 10,
      intervalMs: 3000,
      onPublish: (i) => setMessage(`Simulados ${i + 1}/10 pedidos…`),
    });
    setMessage('Simulación completada.');
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Indicador de cocina */}
      <header
        className={`flex items-center justify-between px-4 py-3 text-white ${health.connected ? 'bg-green-700' : 'bg-red-700'}`}
      >
        <span className="font-semibold">
          {health.connected ? '● Cocina conectada' : '● Cocina sin conexión – activar contingencia'}
        </span>
        <button
          onClick={toggleContingency}
          className={`rounded px-3 py-1 text-sm font-semibold ${contingency ? 'bg-yellow-400 text-black' : 'bg-white/20'}`}
        >
          {contingency ? 'Contingencia ACTIVA' : 'Activar contingencia'}
        </button>
      </header>

      {message && <div className="bg-blue-100 px-4 py-2 text-blue-900">{message}</div>}

      <div className="grid gap-4 p-4 md:grid-cols-2">
        {/* Caja */}
        <section className="rounded-lg bg-white p-4 shadow">
          <h2 className="mb-2 text-xl font-bold">Caja</h2>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {dishes.map((d) => (
              <button
                key={d.dishId}
                onClick={() => addDish(d)}
                className="rounded border border-gray-300 px-3 py-3 text-left hover:bg-gray-50"
              >
                {d.name}
              </button>
            ))}
          </div>

          <ul className="mb-3 divide-y">
            {cart.map((i) => (
              <li key={i.dishId} className="flex justify-between py-1">
                <span>
                  {i.qty}× {i.name}
                </span>
                <button className="text-red-600" onClick={() => setCart((c) => c.filter((x) => x.dishId !== i.dishId))}>
                  quitar
                </button>
              </li>
            ))}
            {!cart.length && <li className="py-2 text-gray-400">Sin ítems</li>}
          </ul>

          <label className="mb-2 block text-sm">
            Llamador
            <input
              value={pager}
              onChange={(e) => setPager(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              placeholder="n.º de llamador"
            />
          </label>
          <label className="mb-3 block text-sm">
            Observaciones
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded border px-2 py-1"
              rows={2}
            />
          </label>

          <div className="flex items-center gap-2">
            <button onClick={closeSale} className="flex-1 rounded bg-green-600 py-3 text-lg font-bold text-white">
              {replacingId ? 'Guardar cambios' : `Cerrar venta #${nextNumber}`}
            </button>
            {replacingId && (
              <button onClick={resetCart} className="rounded border px-3 py-3">
                Cancelar
              </button>
            )}
          </div>

          {import.meta.env.DEV && (
            <button onClick={runSim} className="mt-3 w-full rounded border border-dashed border-gray-400 py-2 text-sm">
              Simular 10 pedidos (dev)
            </button>
          )}
        </section>

        {/* Ventas del día */}
        <section className="rounded-lg bg-white p-4 shadow">
          <h2 className="mb-2 text-xl font-bold">Ventas de hoy</h2>
          <ul className="divide-y">
            {sales.map((s) => (
              <li key={s.saleId} className="flex items-center justify-between py-2">
                <span>
                  <span className="font-bold">#{s.number}</span>{' '}
                  <span className="text-sm text-gray-500">{s.status}</span>
                </span>
                {s.status !== 'cancelado' && (
                  <span className="flex gap-2">
                    <button onClick={() => startReplace(s)} className="rounded border px-2 py-1 text-sm">
                      Modificar
                    </button>
                    <button onClick={() => annul(s)} className="rounded border border-red-300 px-2 py-1 text-sm text-red-600">
                      Anular
                    </button>
                  </span>
                )}
              </li>
            ))}
            {!sales.length && <li className="py-2 text-gray-400">Sin ventas hoy</li>}
          </ul>
        </section>
      </div>

      {/* Recibo con QR */}
      {receipt && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50">
          <div className="printable w-80 rounded-lg bg-white p-6 text-center">
            <h3 className="text-lg font-bold">Doñarepa</h3>
            <p className="my-1 text-3xl font-bold">Pedido #{receipt.number}</p>
            <img src={receipt.qr} alt="QR de seguimiento" className="mx-auto my-3" />
            <p className="break-all text-xs text-gray-500">{receipt.url}</p>
            <p className="mt-2 text-sm">Escanea para ver estado, posición y tiempo estimado.</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => window.print()} className="flex-1 rounded bg-gray-800 py-2 text-white">
                Imprimir
              </button>
              <button onClick={() => setReceipt(null)} className="flex-1 rounded border py-2">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Comanda de contingencia */}
      {comanda && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50">
          <div className="printable w-80 rounded-lg bg-white p-6">
            <h3 className="text-center text-lg font-bold">COMANDA (contingencia)</h3>
            <p className="my-1 text-center text-3xl font-bold">#{comanda.number}</p>
            {comanda.pager && <p className="text-center">Llamador: {comanda.pager}</p>}
            <ul className="my-3 divide-y">
              {comanda.items.map((i) => (
                <li key={i.dishId} className="py-1">
                  {i.qty}× {i.name}
                </li>
              ))}
            </ul>
            {comanda.notes && <p className="text-sm">Obs: {comanda.notes}</p>}
            <div className="mt-4 flex gap-2">
              <button onClick={() => window.print()} className="flex-1 rounded bg-gray-800 py-2 text-white">
                Imprimir
              </button>
              <button onClick={() => setComanda(null)} className="flex-1 rounded border py-2">
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
