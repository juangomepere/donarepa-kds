// E2E de cocina contra la Emulator Suite: ejercita el MISMO código que usan
// /pos-sim (posBridge) y /kds (kdsActions, eta.ts) a través de las reglas reales.
// Replica la prueba manual guiada. Ejecutar: npm run test:emulator
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { type FirebaseApp, initializeApp as initClient } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import {
  type Firestore,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
} from 'firebase/firestore';
import { createPosBridge, type PosBridge } from '../bridge/posBridge';
import { toOrder } from '../firebase/converters';
import { computeQueue, fifoWindow, isNoStartAlert, prepMinForItems, semaphore } from '../shared/eta';
import { completeOrder, deliverOrder, enrichOrder, markCancelSeen, revert, closeTurn, startOrder } from './kdsActions';
import type { Config, DishStats, Order } from '../shared/types';

const projectId = 'donarepa-kds-demo';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';

const config: Config = { c: 5, defaultPrepMin: 15, minSamples: 5, uncollectedMin: 30, undoSec: 30, noStartGraceMin: 5 };
const QUEUE_DISH = { dishId: 'arepa_queso', name: 'Arepa de queso', qty: 1 };

let posBridge: PosBridge;
let kdsDb: Firestore;

async function allOrders(): Promise<Order[]> {
  const snap = await getDocs(collection(kdsDb, 'orders'));
  return snap.docs.map(toOrder);
}
const active = (os: Order[]) =>
  os.filter((o) => o.status === 'recibido' || o.status === 'en_preparacion').sort((a, b) => (a.queueAt ?? 0) - (b.queueAt ?? 0));
const getOrder = async (id: string) => toOrder(await getDoc(doc(kdsDb, 'orders', id)));

// Enriquecimiento tal como lo hace la página /kds.
async function enrich(saleId: string, dishStats: Record<string, DishStats>) {
  const act = active(await allOrders());
  const o = act.find((x) => x.saleId === saleId)!;
  const prepMin = prepMinForItems(o.items, dishStats, config);
  const withPrep = act.map((x) => (x.saleId === saleId ? { ...x, prepMin } : x));
  const entry = computeQueue(withPrep, config, Date.now()).find((e) => e.order.saleId === saleId)!;
  await enrichOrder(kdsDb, saleId, { prepMin, etaCommittedMin: entry.etaMin, waitCommittedMin: entry.waitMin });
}

beforeAll(async () => {
  const admin = initAdmin({ projectId });
  const adminAuth = getAdminAuth(admin);
  const adminDb = getAdminFirestore(admin);

  const ensure = async (email: string, role: string) => {
    const uid = await adminAuth
      .createUser({ email, password: 'donarepa123' })
      .then((u) => u.uid)
      .catch(async (e: { code?: string }) => {
        if (e.code === 'auth/email-already-exists') return (await adminAuth.getUserByEmail(email)).uid;
        throw e;
      });
    await adminDb.doc(`staff/${uid}`).set({ role });
  };
  await ensure('pos@donarepa.test', 'pos');
  await ensure('kds@donarepa.test', 'kds');

  // Datos base (como el seed).
  await adminDb.doc('config/main').set(config);
  await adminDb.doc('dish_stats/arepa_queso').set({ name: 'Arepa de queso', samples: [8, 9, 7, 8, 10], avgMin: 8.4 });

  const signIn = async (name: string, email: string): Promise<FirebaseApp> => {
    const app = initClient({ apiKey: 'demo-key', projectId, authDomain: `${projectId}.firebaseapp.com` }, name);
    const auth = getAuth(app);
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    await signInWithEmailAndPassword(auth, email, 'donarepa123');
    return app;
  };
  const posApp = await signIn('e2e-pos', 'pos@donarepa.test');
  const kdsApp = await signIn('e2e-kds', 'kds@donarepa.test');
  const posDb = getFirestore(posApp);
  connectFirestoreEmulator(posDb, '127.0.0.1', 8080);
  kdsDb = getFirestore(kdsApp);
  connectFirestoreEmulator(kdsDb, '127.0.0.1', 8080);
  posBridge = createPosBridge(posDb, { retryDelaysMs: [5, 5, 5], maxAttempts: 3, timeoutMs: 5000 });
});

describe('prueba guiada KDS (8 pedidos)', () => {
  const dishStats: Record<string, DishStats> = {
    arepa_queso: { name: 'Arepa de queso', samples: [8, 9, 7, 8, 10], avgMin: 8.4 },
  };
  const ids: string[] = [];

  it('POS crea 8 pedidos y KDS los enriquece', async () => {
    for (let n = 1; n <= 8; n++) {
      const saleId = `e2e-${n}`;
      ids.push(saleId);
      const r = await posBridge.publishOrder({ saleId, number: n, pager: String(n), items: [QUEUE_DISH] });
      expect(r.ok).toBe(true);
    }
    for (const id of ids) await enrich(id, dishStats);
    const enriched = await getOrder('e2e-1');
    expect(enriched.prepMin).toBe(8.4);
    expect(enriched.etaCommittedMin).toBeGreaterThan(0);
  });

  it('RN-01: cola ordenada por queueAt', async () => {
    const act = active(await allOrders());
    const qs = act.map((o) => o.queueAt ?? 0);
    expect(qs).toEqual([...qs].sort((a, b) => a - b));
  });

  it('RN-02: ventana FIFO = 5 primeros (0 en preparación)', async () => {
    const act = active(await allOrders());
    const enabled = fifoWindow(act, config.c);
    expect(enabled).toHaveLength(5);
    expect(enabled).toEqual(act.slice(0, 5).map((o) => o.saleId));
  });

  it('RN-12 / RN-13: semáforo verde y sin alerta al inicio; alerta al superar el umbral', async () => {
    const o = await getOrder('e2e-1');
    expect(semaphore(o, Date.now())).toBe('verde');
    expect(isNoStartAlert(o, Date.now(), config)).toBe(false);
    const future = (o.queueAt ?? 0) + ((o.waitCommittedMin ?? 0) + 6) * 60000;
    expect(isNoStartAlert(o, future, config)).toBe(true);
  });

  it('Iniciar dentro de ventana (RN-02): recibido → en_preparacion, orders+public', async () => {
    await startOrder(kdsDb, await getOrder('e2e-1'));
    const o = await getOrder('e2e-1');
    expect(o.status).toBe('en_preparacion');
    expect(o.tInicio).not.toBeNull();
    const pub = await getDoc(doc(kdsDb, 'public', o.token));
    expect(pub.get('status')).toBe('en_preparacion');
  });

  it('RN-02 fuera de ventana: guarda outOfOrderReason', async () => {
    const act = active(await allOrders());
    const outside = act.find((o) => o.status === 'recibido' && !fifoWindow(act, config.c).includes(o.saleId))!;
    await startOrder(kdsDb, outside, 'otro');
    expect((await getOrder(outside.saleId)).outOfOrderReason).toBe('otro');
  });

  it('RN-11: Completado agrega muestra (tListo − tInicio) a dish_stats', async () => {
    const o = await getOrder('e2e-1');
    const before = (await getDoc(doc(kdsDb, 'dish_stats', 'arepa_queso'))).get('samples') as number[];
    const { acceptedDishIds } = await completeOrder(kdsDb, o, (o.tInicio ?? Date.now()) + 10 * 60000); // 10 min
    expect(acceptedDishIds).toContain('arepa_queso');
    const after = (await getDoc(doc(kdsDb, 'dish_stats', 'arepa_queso'))).get('samples') as number[];
    expect(after.length).toBe(before.length + 1);
    expect(after.at(-1)).toBe(10);
    expect((await getOrder('e2e-1')).status).toBe('listo');
  });

  it('RN-04: Deshacer revierte estado, registra reversion y quita la muestra', async () => {
    const o = await getOrder('e2e-1');
    const before = ((await getDoc(doc(kdsDb, 'dish_stats', 'arepa_queso'))).get('samples') as number[]).length;
    await revert(kdsDb, {
      saleId: o.saleId,
      token: o.token,
      label: '',
      from: 'en_preparacion',
      to: 'listo',
      clearField: 'tListo',
      acceptedDishIds: ['arepa_queso'],
    });
    const back = await getOrder('e2e-1');
    expect(back.status).toBe('en_preparacion');
    expect(back.tListo).toBeNull();
    expect((back.reversions ?? []).length).toBeGreaterThanOrEqual(1);
    const after = ((await getDoc(doc(kdsDb, 'dish_stats', 'arepa_queso'))).get('samples') as number[]).length;
    expect(after).toBe(before - 1);
  });

  it('RN-06: anular en preparación deja cancelSeen=false; "Visto" lo marca; sale de la cola', async () => {
    const r = await posBridge.cancelOrder('e2e-1'); // sigue en_preparacion
    expect(r.ok).toBe(true);
    let o = await getOrder('e2e-1');
    expect(o.status).toBe('cancelado');
    expect(o.cancelSeen).toBe(false);
    // ya no está en la cola activa (recálculo)
    expect(active(await allOrders()).some((x) => x.saleId === 'e2e-1')).toBe(false);
    await markCancelSeen(kdsDb, 'e2e-1');
    o = await getOrder('e2e-1');
    expect(o.cancelSeen).toBe(true);
  });

  it('RN-05: Cerrar turno pasa los listos pendientes a no_recogido', async () => {
    // dejamos un pedido en estado listo
    const o2 = await getOrder('e2e-2');
    await startOrder(kdsDb, o2);
    await completeOrder(kdsDb, await getOrder('e2e-2'), (o2.tInicio ?? Date.now()) + 5 * 60000);
    const listos = (await allOrders()).filter((x) => x.status === 'listo');
    expect(listos.length).toBeGreaterThanOrEqual(1);
    await closeTurn(kdsDb, listos);
    expect((await getOrder('e2e-2')).status).toBe('no_recogido');
  });

  it('entregar un listo → entregado', async () => {
    const o3 = await getOrder('e2e-3');
    await startOrder(kdsDb, o3);
    await completeOrder(kdsDb, await getOrder('e2e-3'), (o3.tInicio ?? Date.now()) + 3 * 60000);
    await deliverOrder(kdsDb, await getOrder('e2e-3'));
    expect((await getOrder('e2e-3')).status).toBe('entregado');
  });
});
