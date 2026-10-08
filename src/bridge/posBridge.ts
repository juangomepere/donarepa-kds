// Puente POS → Firestore. Sin dependencias de React: reutilizable por el POS real.
// Crea pedidos con idempotencia (RN-08), reintentos (RN-09), anulación/reemplazo (RN-06/07)
// y modo contingencia (RN-15, RF-23).
import {
  type DocumentData,
  type Firestore,
  Timestamp,
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import type { OrderItem } from '../shared/types';

export interface SaleInput {
  saleId: string; // id de la venta en el POS (llave única)
  number: number;
  pager?: string;
  items: OrderItem[];
  notes?: string;
  posClosedAt?: number; // hora del cliente POS (ms); por defecto Date.now()
}

export type PublishResult =
  | { ok: true; token: string; attempts: number; existing: boolean }
  | { ok: true; printKitchenTicket: true; saleId: string; pending: Promise<void> }
  | { ok: false; reason: string; attempts: number };

export type ReplaceResult = { ok: true; token: string; existing: boolean } | { ok: false; reason: string };
export type CancelResult = { ok: true } | { ok: false; reason: string };

export interface KdsHealth {
  connected: boolean;
  reason?: 'sin_red' | 'sin_datos' | 'kds_inactivo' | 'error';
}

export interface PosBridgeOptions {
  onNeedsContingency?: () => void;
  timeoutMs?: number; // RN-09: ≤ 5 s por intento
  retryDelaysMs?: number[]; // esperas entre intentos
  maxAttempts?: number; // RN-09: tras 3 fallos → contingencia
  now?: () => number;
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000];
export const MAX_ATTEMPTS = 3;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const STALE_MS = 60_000; // RF-21

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RN-14: token aleatorio, 16 bytes, base64url.
export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface RetryOpts {
  retryDelaysMs: number[];
  maxAttempts: number;
  timeoutMs: number;
  onNeedsContingency?: () => void;
}

// RN-09: intentos con timeout y backoff; tras agotarlos dispara contingencia.
export async function withRetries<T>(
  attempt: (attemptNo: number) => Promise<T>,
  opts: RetryOpts,
): Promise<{ ok: true; value: T; attempts: number } | { ok: false; reason: string; attempts: number }> {
  let lastErr: unknown;
  for (let i = 1; i <= opts.maxAttempts; i++) {
    try {
      const value = await withTimeout(attempt(i), opts.timeoutMs);
      return { ok: true, value, attempts: i };
    } catch (e) {
      lastErr = e;
      if (i < opts.maxAttempts) await sleep(opts.retryDelaysMs[i - 1] ?? opts.retryDelaysMs.at(-1) ?? 1000);
    }
  }
  opts.onNeedsContingency?.();
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'falló');
  return { ok: false, reason, attempts: opts.maxAttempts };
}

export function createPosBridge(db: Firestore, options: PosBridgeOptions = {}) {
  const nowFn = options.now ?? (() => Date.now());
  const retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? 5000;

  let contingency = false;
  let incidentId: string | null = null;
  let incidentStart = 0;

  function buildOrderDoc(
    sale: SaleInput,
    o: { status: string; channel: string; token?: string; queueAt?: unknown; replacesSaleId?: string },
  ): DocumentData {
    const d: DocumentData = {
      saleId: sale.saleId,
      number: sale.number,
      items: sale.items,
      status: o.status,
      channel: o.channel,
      posClosedAt: Timestamp.fromMillis(sale.posClosedAt ?? nowFn()),
      tRecibido: serverTimestamp(),
      queueAt: o.queueAt ?? serverTimestamp(),
      tInicio: null,
      tListo: null,
      tEntregado: null,
      tCancelado: null,
      prepMin: null,
      etaCommittedMin: null,
      waitCommittedMin: null,
    };
    if (sale.pager) d.pager = sale.pager;
    if (sale.notes) d.notes = sale.notes;
    if (o.token) d.token = o.token;
    if (o.replacesSaleId) d.replacesSaleId = o.replacesSaleId;
    return d;
  }

  function buildPublicDoc(sale: SaleInput, o: { queueAt?: unknown }): DocumentData {
    return {
      number: sale.number,
      status: 'recibido',
      queueAt: o.queueAt ?? serverTimestamp(),
      tInicio: null,
      tListo: null,
      prepMin: null,
      expiresAt: Timestamp.fromMillis(nowFn() + TWO_HOURS_MS), // RN-14
    };
  }

  // RN-08: crea orders + public en transacción; si ya existe, devuelve el token sin escribir.
  async function createInTransaction(sale: SaleInput): Promise<{ token: string; existing: boolean }> {
    const orderRef = doc(db, 'orders', sale.saleId);
    return runTransaction(db, async (tx) => {
      const snap = await tx.get(orderRef);
      if (snap.exists()) return { token: snap.get('token') as string, existing: true };
      const token = generateToken();
      tx.set(orderRef, buildOrderDoc(sale, { status: 'recibido', channel: 'kds', token }));
      tx.set(doc(db, 'public', token), buildPublicDoc(sale, {}));
      return { token, existing: false };
    });
  }

  // RN-15: en contingencia no entra a la cola; se guarda como historico_contingencia.
  function writeContingency(sale: SaleInput): Promise<void> {
    const p = setDoc(
      doc(db, 'orders', sale.saleId),
      buildOrderDoc(sale, { status: 'historico_contingencia', channel: 'contingencia' }),
    );
    if (incidentId) void updateDoc(doc(db, 'incidents', incidentId), { affectedSaleIds: arrayUnion(sale.saleId) });
    return p; // se sincroniza vía la cola offline de Firestore; el llamador no debe bloquear
  }

  async function publishOrder(sale: SaleInput): Promise<PublishResult> {
    if (contingency) {
      return { ok: true, printKitchenTicket: true, saleId: sale.saleId, pending: writeContingency(sale) };
    }
    const res = await withRetries((_n) => createInTransaction(sale), {
      retryDelaysMs,
      maxAttempts,
      timeoutMs,
      onNeedsContingency: options.onNeedsContingency,
    });
    if (res.ok) return { ok: true, token: res.value.token, existing: res.value.existing, attempts: res.attempts };
    return { ok: false, reason: res.reason, attempts: res.attempts };
  }

  // RN-06: solo el POS anula. Si estaba en preparación → cancelSeen=false (alerta en KDS).
  async function cancelOrder(saleId: string): Promise<CancelResult> {
    const orderRef = doc(db, 'orders', saleId);
    const snap = await getDoc(orderRef);
    if (!snap.exists()) return { ok: false, reason: 'el pedido no existe' };
    const token = snap.get('token') as string | undefined;
    const update: DocumentData = { status: 'cancelado', tCancelado: serverTimestamp() };
    if (snap.get('status') === 'en_preparacion') update.cancelSeen = false;
    const batch = writeBatch(db);
    batch.update(orderRef, update);
    if (token) batch.update(doc(db, 'public', token), { status: 'cancelado' });
    await batch.commit();
    return { ok: true };
  }

  // RN-07: anular viejo + publicar nuevo con replacesSaleId y queueAt heredado, en una transacción.
  async function replaceOrder(oldSaleId: string, newSale: SaleInput): Promise<ReplaceResult> {
    const oldRef = doc(db, 'orders', oldSaleId);
    const newRef = doc(db, 'orders', newSale.saleId);
    try {
      return await runTransaction(db, async (tx) => {
        const oldSnap = await tx.get(oldRef);
        if (!oldSnap.exists()) throw new Error('el pedido a modificar no existe');
        const newSnap = await tx.get(newRef);
        if (newSnap.exists()) return { ok: true as const, token: newSnap.get('token') as string, existing: true };

        const inheritedQueueAt = oldSnap.get('queueAt');
        const oldToken = oldSnap.get('token') as string | undefined;

        const cancelUpd: DocumentData = { status: 'cancelado', tCancelado: serverTimestamp() };
        if (oldSnap.get('status') === 'en_preparacion') cancelUpd.cancelSeen = false;
        tx.update(oldRef, cancelUpd);
        if (oldToken) tx.update(doc(db, 'public', oldToken), { status: 'cancelado' });

        const token = generateToken();
        tx.set(
          newRef,
          buildOrderDoc(newSale, {
            status: 'recibido',
            channel: 'kds',
            token,
            queueAt: inheritedQueueAt,
            replacesSaleId: oldSaleId,
          }),
        );
        tx.set(doc(db, 'public', token), buildPublicDoc(newSale, { queueAt: inheritedQueueAt }));
        return { ok: true as const, token, existing: false };
      });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // RF-23: al activar/desactivar crea/cierra un doc en incidents.
  function setContingency(on: boolean): void {
    if (on === contingency) return;
    contingency = on;
    if (on) {
      incidentStart = nowFn();
      const ref = doc(collection(db, 'incidents'));
      incidentId = ref.id;
      void setDoc(ref, {
        start: serverTimestamp(),
        end: null,
        durationMin: 0,
        cause: 'cocina sin conexión',
        affectedSaleIds: [],
      });
    } else if (incidentId) {
      const durationMin = Math.max(0, Math.round((nowFn() - incidentStart) / 60000));
      void updateDoc(doc(db, 'incidents', incidentId), { end: serverTimestamp(), durationMin });
      incidentId = null;
    }
  }

  const isContingency = () => contingency;

  // RF-21: avisa si no hay red o si lastSeen de KDS > 60 s.
  function watchKdsHealth(cb: (h: KdsHealth) => void): () => void {
    let lastSeenMs: number | null = null;
    const evaluate = () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return cb({ connected: false, reason: 'sin_red' });
      if (lastSeenMs == null) return cb({ connected: false, reason: 'sin_datos' });
      const stale = nowFn() - lastSeenMs > STALE_MS;
      cb(stale ? { connected: false, reason: 'kds_inactivo' } : { connected: true });
    };
    const unsub = onSnapshot(
      doc(db, 'heartbeats', 'kds'),
      (snap) => {
        const ls = snap.get('lastSeen') as Timestamp | undefined;
        lastSeenMs = ls ? ls.toMillis() : null;
        evaluate();
      },
      () => cb({ connected: false, reason: 'error' }),
    );
    const interval = setInterval(evaluate, 15_000);
    const onNet = () => evaluate();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onNet);
      window.addEventListener('offline', onNet);
    }
    evaluate();
    return () => {
      unsub();
      clearInterval(interval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onNet);
        window.removeEventListener('offline', onNet);
      }
    };
  }

  return { publishOrder, cancelOrder, replaceOrder, setContingency, isContingency, watchKdsHealth };
}

export type PosBridge = ReturnType<typeof createPosBridge>;
