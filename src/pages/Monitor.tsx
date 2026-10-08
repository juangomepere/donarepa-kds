import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from '../firebase/init';
import { latestEventMs, toPublic, type PublicView } from '../firebase/converters';
import { formatClock } from '../shared/time';

export default function Monitor() {
  const [params] = useSearchParams();
  const debug = params.get('debug') === '1';
  const [items, setItems] = useState<PublicView[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const prevStatus = useRef<Record<string, string>>({});
  const blinkUntil = useRef<Record<string, number>>({});
  const latency = useRef<number | null>(null);

  // Reloj / tick de 1 s (también apaga el parpadeo a los 10 s).
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const q = query(collection(db, 'public'), where('status', 'in', ['en_preparacion', 'listo']));
    return onSnapshot(q, (snap) => {
      const docs = snap.docs.map(toPublic);
      for (const d of docs) {
        if (d.status === 'listo' && prevStatus.current[d.token] !== 'listo') {
          blinkUntil.current[d.token] = Date.now() + 10_000; // parpadea 10 s
        }
        prevStatus.current[d.token] = d.status;
      }
      setItems(docs);
      const ev = snap.docChanges().map((c) => latestEventMs(toPublic(c.doc))).filter((v): v is number => v != null);
      if (ev.length) latency.current = Date.now() - Math.max(...ev);
    });
  }, []);

  const preparing = items
    .filter((i) => i.status === 'en_preparacion')
    .sort((a, b) => (a.tInicio ?? 0) - (b.tInicio ?? 0));
  const ready = items.filter((i) => i.status === 'listo').sort((a, b) => (b.tListo ?? 0) - (a.tListo ?? 0));

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-white">
      <header className="flex items-center justify-between px-10 py-4">
        <span className="text-3xl font-black tracking-wide text-orange-500">Doñarepa</span>
        <span className="font-mono text-5xl tabular-nums">{formatClock(now)}</span>
        <button
          onClick={() => document.documentElement.requestFullscreen().catch(() => {})}
          className="rounded-lg bg-gray-800 px-5 py-3 text-lg"
        >
          Pantalla completa
        </button>
      </header>

      <div className="grid flex-1 grid-cols-2 gap-6 px-8 pb-8">
        <Column title="En preparación" accent="text-amber-400">
          {preparing.map((o) => (
            <Num key={o.token}>{o.number}</Num>
          ))}
          {!preparing.length && <Empty />}
        </Column>

        <Column title="Listos" accent="text-green-400">
          {ready.map((o) => (
            <Num key={o.token} blink={(blinkUntil.current[o.token] ?? 0) > now} highlight>
              {o.number}
            </Num>
          ))}
          {!ready.length && <Empty />}
        </Column>
      </div>

      {debug && (
        <div className="fixed bottom-2 left-2 rounded bg-black/80 px-2 py-1 font-mono text-sm text-green-300">
          K5 latencia: {latency.current == null ? '—' : `${latency.current} ms`}
        </div>
      )}
    </div>
  );
}

function Column({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl bg-gray-900 p-6">
      <h2 className={`mb-4 text-4xl font-black ${accent}`}>{title}</h2>
      <div className="flex flex-wrap content-start gap-4 overflow-y-auto">{children}</div>
    </section>
  );
}

function Num({ children, blink, highlight }: { children: React.ReactNode; blink?: boolean; highlight?: boolean }) {
  return (
    <span
      className={`rounded-xl px-6 py-4 text-6xl font-black tabular-nums ${
        highlight ? 'bg-green-600' : 'bg-gray-800'
      } ${blink ? 'blink' : ''}`}
    >
      {children}
    </span>
  );
}

const Empty = () => <span className="text-2xl text-gray-600">—</span>;
