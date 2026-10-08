import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase/init';
import { DEFAULT_CONFIG, latestEventMs, publicToOrder, toPublic, type PublicView } from '../firebase/converters';
import { computeQueue } from '../shared/eta';
import { formatClock, minutesSince } from '../shared/time';

type Me = PublicView | 'missing' | null;

export default function Track() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const debug = params.get('debug') === '1';
  const [me, setMe] = useState<Me>(null);
  const [active, setActive] = useState<PublicView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const latency = useRef<number | null>(null);

  // Tick local de 30 s (refresca minutos, no lee nada).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const measure = (views: PublicView[]) => {
    const ev = views.map(latestEventMs).filter((v): v is number => v != null);
    if (ev.length) latency.current = Date.now() - Math.max(...ev);
  };

  // Mi pedido (cualquier estado).
  useEffect(() => {
    if (!token) return;
    return onSnapshot(
      doc(db, 'public', token),
      (snap) => {
        if (!snap.exists()) return setMe('missing');
        const v = toPublic(snap);
        setMe(v);
        measure([v]);
        setNow(Date.now());
      },
      () => setMe('missing'),
    );
  }, [token]);

  // Cola activa (para posición y ETA).
  useEffect(() => {
    const q = query(collection(db, 'public'), where('status', 'in', ['recibido', 'en_preparacion']));
    return onSnapshot(q, (snap) => {
      setActive(snap.docs.map(toPublic));
      measure(snap.docChanges().map((c) => toPublic(c.doc)));
      setNow(Date.now());
    });
  }, []);

  const info = useMemo(() => {
    if (!me || me === 'missing') return null;
    const entry = computeQueue(active.map(publicToOrder), DEFAULT_CONFIG, now).find((e) => e.order.saleId === token);
    return entry ?? null;
  }, [me, active, now, token]);

  if (me === null) return <Shell>Cargando…</Shell>;

  const expired = me !== 'missing' && me.expiresAt != null && me.expiresAt < now;
  if (me === 'missing' || expired) {
    return (
      <Shell>
        <p className="text-2xl font-bold text-orange-900">Pedido finalizado</p>
        <p className="mt-2 text-orange-800/70">Este enlace ya no está disponible.</p>
      </Shell>
    );
  }

  const isActive = me.status === 'recibido' || me.status === 'en_preparacion';
  const uncollected = me.status === 'listo' && minutesSince(me.tListo, now) > DEFAULT_CONFIG.uncollectedMin;
  const late = me.status === 'en_preparacion' && me.prepMin != null && minutesSince(me.tInicio, now) > me.prepMin;
  const position = info?.position ?? 0;
  const etaMin = info?.etaMin ?? me.prepMin ?? null;
  const readyAt = info?.estimatedReadyAt ?? null;

  const statusText =
    me.status === 'recibido'
      ? 'En fila'
      : me.status === 'en_preparacion'
        ? 'Preparando'
        : me.status === 'listo'
          ? uncollected
            ? 'Listo, pendiente de recoger'
            : '¡Listo! Acércate a recoger'
          : me.status === 'cancelado'
            ? 'Cancelado'
            : me.status === 'entregado'
              ? 'Entregado ✓'
              : 'Pedido finalizado';

  return (
    <Shell>
      <div className="text-orange-800/70">Tu pedido</div>
      <div className="text-6xl font-black text-orange-900">#{me.number}</div>
      <div
        className={`mt-4 rounded-xl px-4 py-3 text-2xl font-bold ${
          me.status === 'listo' && !uncollected
            ? 'bg-green-600 text-white'
            : me.status === 'cancelado'
              ? 'bg-red-600 text-white'
              : 'bg-orange-200 text-orange-900'
        }`}
      >
        {statusText}
      </div>

      {isActive && (
        <div className="mt-6 space-y-3 text-lg text-orange-900">
          <p>
            {position === 0 ? 'Eres el siguiente de la fila.' : `Hay ${position} pedido${position === 1 ? '' : 's'} antes del tuyo.`}
          </p>
          {etaMin != null && (
            <p className="text-xl">
              Tiempo estimado: <span className="font-bold">{etaMin} min</span>
            </p>
          )}
          {readyAt != null && <p className="text-xl">Listo aprox. a las {formatClock(readyAt)}</p>}
          {late && (
            <p className="rounded-lg bg-amber-200 px-3 py-2 font-semibold text-amber-900">
              Tu pedido está tardando más de lo estimado. Nuevo restante: {etaMin} min.
            </p>
          )}
        </div>
      )}

      {me.status === 'listo' && !uncollected && (
        <p className="mt-6 text-lg text-orange-900">Muestra tu número #{me.number} en el mostrador.</p>
      )}

      {debug && (
        <div className="fixed bottom-2 left-2 rounded bg-black/80 px-2 py-1 font-mono text-xs text-green-300">
          K5 latencia: {latency.current == null ? '—' : `${latency.current} ms`}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center bg-gradient-to-b from-orange-50 to-amber-100 px-6 py-10">
      <div className="text-xl font-black tracking-wide text-orange-700">Doñarepa</div>
      <div className="mt-8 w-full max-w-sm text-center">{children}</div>
    </main>
  );
}
