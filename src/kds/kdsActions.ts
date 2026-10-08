// Escrituras de cocina (solo KDS). Sin React. Toda mutación de estado toca
// orders + public en el mismo batch/transacción, con serverTimestamp (CLAUDE.md).
import {
  type DocumentData,
  type Firestore,
  Timestamp,
  arrayUnion,
  doc,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { updateDishSamples } from '../shared/eta';
import type { Order, OrderStatus } from '../shared/types';

const avg = (xs: number[]): number =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;

export interface EnrichValues {
  prepMin: number;
  etaCommittedMin: number;
  waitCommittedMin: number;
}

// Enriquecimiento: escribe prepMin/etaCommittedMin/waitCommittedMin una sola vez,
// en transacción, solo si siguen vacíos (evita carreras entre tablets).
export async function enrichOrder(db: Firestore, saleId: string, vals: EnrichValues): Promise<void> {
  const orderRef = doc(db, 'orders', saleId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists() || snap.get('prepMin') != null) return; // ya enriquecido
    const token = snap.get('token') as string | undefined;
    tx.update(orderRef, { ...vals });
    if (token) tx.update(doc(db, 'public', token), { prepMin: vals.prepMin });
  });
}

// recibido → en_preparacion (RN-02). outOfOrderReason si fue fuera de la ventana FIFO.
export async function startOrder(
  db: Firestore,
  order: Order,
  outOfOrderReason?: 'producto_rapido' | 'otro',
): Promise<void> {
  const batch = writeBatch(db);
  const upd: DocumentData = { status: 'en_preparacion', tInicio: serverTimestamp() };
  if (outOfOrderReason) upd.outOfOrderReason = outOfOrderReason;
  batch.update(doc(db, 'orders', order.saleId), upd);
  batch.update(doc(db, 'public', order.token), { status: 'en_preparacion', tInicio: serverTimestamp() });
  await batch.commit();
}

// en_preparacion → listo. Agrega la muestra (tListo − tInicio) a cada plato (RN-11).
// Devuelve los platos cuya muestra fue aceptada (para poder revertir en el "Deshacer").
export async function completeOrder(
  db: Firestore,
  order: Order,
  now: number = Date.now(),
): Promise<{ acceptedDishIds: string[] }> {
  const sample = order.tInicio != null ? Math.round((now - order.tInicio) / 60000) : null;
  const dishIds = [...new Set(order.items.map((i) => i.dishId))];
  const accepted: string[] = [];

  await runTransaction(db, async (tx) => {
    const dishRefs = dishIds.map((id) => doc(db, 'dish_stats', id));
    const dishSnaps = sample != null ? await Promise.all(dishRefs.map((r) => tx.get(r))) : [];

    tx.update(doc(db, 'orders', order.saleId), { status: 'listo', tListo: serverTimestamp() });
    tx.update(doc(db, 'public', order.token), { status: 'listo', tListo: serverTimestamp() });

    dishSnaps.forEach((snap, i) => {
      if (!snap.exists() || sample == null) return;
      const cur = (snap.get('samples') as number[]) ?? [];
      const next = updateDishSamples(cur, sample);
      if (next !== cur) {
        // nueva referencia ⇒ muestra aceptada
        tx.update(dishRefs[i], { samples: next, avgMin: avg(next) });
        accepted.push(dishIds[i]);
      }
    });
  });

  return { acceptedDishIds: accepted };
}

// listo → entregado.
export async function deliverOrder(db: Firestore, order: Order): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, 'orders', order.saleId), { status: 'entregado', tEntregado: serverTimestamp() });
  batch.update(doc(db, 'public', order.token), { status: 'entregado' });
  await batch.commit();
}

// RN-06: KDS confirma que vio la anulación de un pedido en preparación.
export async function markCancelSeen(db: Firestore, saleId: string): Promise<void> {
  await writeBatch(db).update(doc(db, 'orders', saleId), { cancelSeen: true }).commit();
}

export interface UndoAction {
  saleId: string;
  token: string;
  label: string;
  from: OrderStatus; // estado al que se vuelve
  to: OrderStatus; // estado actual (tras la acción)
  clearField?: 'tInicio' | 'tListo' | 'tEntregado'; // campo que puso la acción
  acceptedDishIds?: string[]; // muestras a quitar al deshacer un "Completado"
}

// RN-04: revierte el último cambio y lo registra en reversions.
export async function revert(db: Firestore, u: UndoAction): Promise<void> {
  const reversion = { from: u.to, to: u.from, at: Timestamp.now() };
  const orderUpd: DocumentData = { status: u.from, reversions: arrayUnion(reversion) };
  if (u.clearField) orderUpd[u.clearField] = null;
  const pubUpd: DocumentData = { status: u.from };
  if (u.clearField === 'tInicio' || u.clearField === 'tListo') pubUpd[u.clearField] = null;

  if (u.acceptedDishIds?.length) {
    await runTransaction(db, async (tx) => {
      const refs = u.acceptedDishIds!.map((id) => doc(db, 'dish_stats', id));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      tx.update(doc(db, 'orders', u.saleId), orderUpd);
      tx.update(doc(db, 'public', u.token), pubUpd);
      snaps.forEach((snap, i) => {
        if (!snap.exists()) return;
        const cur = (snap.get('samples') as number[]) ?? [];
        const next = cur.slice(0, -1); // quita la última muestra añadida
        tx.update(refs[i], { samples: next, avgMin: avg(next) });
      });
    });
    return;
  }

  const batch = writeBatch(db);
  batch.update(doc(db, 'orders', u.saleId), orderUpd);
  batch.update(doc(db, 'public', u.token), pubUpd);
  await batch.commit();
}

// RN-05: "Cerrar turno" pasa los listos pendientes a no_recogido.
export async function closeTurn(db: Firestore, readyOrders: Order[]): Promise<void> {
  if (!readyOrders.length) return;
  const batch = writeBatch(db);
  for (const o of readyOrders) {
    batch.update(doc(db, 'orders', o.saleId), { status: 'no_recogido' });
    batch.update(doc(db, 'public', o.token), { status: 'no_recogido' });
  }
  await batch.commit();
}

export async function writeHeartbeat(db: Firestore): Promise<void> {
  await setDoc(doc(db, 'heartbeats', 'kds'), { lastSeen: serverTimestamp() });
}
