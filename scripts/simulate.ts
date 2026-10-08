// Genera pedidos de demo con platos aleatorios.
//   Reutilizable desde /pos-sim (botón "Simular 10 pedidos").
//   CLI contra el emulador:  npm run simulate   (arranca emuladores + seed antes)
import type { PublishResult, SaleInput } from '../src/bridge/posBridge';

export interface SimDish {
  dishId: string;
  name: string;
}
export interface SimOptions {
  count?: number;
  intervalMs?: number;
  onPublish?: (i: number, saleId: string) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

export async function simulateOrders(
  publish: (sale: SaleInput) => Promise<PublishResult>,
  dishes: SimDish[],
  startNumber: number,
  opts: SimOptions = {},
): Promise<void> {
  const count = opts.count ?? 10;
  const intervalMs = opts.intervalMs ?? 3000;
  if (!dishes.length) throw new Error('no hay platos para simular');

  for (let i = 0; i < count; i++) {
    const n = randInt(1, 3);
    const items: SaleInput['items'] = [];
    for (let k = 0; k < n; k++) {
      const d = pick(dishes);
      items.push({ dishId: d.dishId, name: d.name, qty: randInt(1, 2) });
    }
    const saleId = `sim-${Date.now()}-${i}`;
    await publish({ saleId, number: startNumber + i, pager: String(randInt(1, 40)), items });
    opts.onPublish?.(i, saleId);
    if (i < count - 1) await sleep(intervalMs);
  }
}

// --- CLI: conecta el SDK cliente al emulador, inicia sesión como pos y simula ---
async function runCli() {
  const { initializeApp } = await import('firebase/app');
  const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } = await import('firebase/auth');
  const { getFirestore, connectFirestoreEmulator, getDocs, collection } = await import('firebase/firestore');
  const { createPosBridge } = await import('../src/bridge/posBridge');

  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || 'donarepa-kds-demo';
  const app = initializeApp({ apiKey: 'demo-key', projectId, authDomain: `${projectId}.firebaseapp.com` });
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);

  await signInWithEmailAndPassword(auth, 'pos@donarepa.test', 'donarepa123');
  const snap = await getDocs(collection(db, 'dish_stats'));
  const dishes: SimDish[] = snap.docs.map((d) => ({ dishId: d.id, name: d.get('name') as string }));

  const bridge = createPosBridge(db);
  console.log(`Simulando 10 pedidos con ${dishes.length} platos…`);
  await simulateOrders(bridge.publishOrder, dishes, 1, {
    count: 10,
    intervalMs: 3000,
    onPublish: (i, id) => console.log(`✓ pedido ${i + 1}/10 (${id})`),
  });
  console.log('Listo.');
  process.exit(0);
}

// Solo en Node (CLI). En el navegador `process` no existe: no ejecutar nada.
if (typeof process !== 'undefined' && process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/simulate.ts')) {
  runCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
