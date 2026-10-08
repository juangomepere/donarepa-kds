// Pruebas del bridge contra la Emulator Suite. Ejecutar con: npm run test:emulator
// firebase-admin prepara el usuario pos + staff (bypassa reglas); el bridge usa el SDK cliente.
import { beforeAll, describe, expect, it } from 'vitest';
import { initializeApp as initAdmin } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';
import { initializeApp as initClient } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore } from 'firebase/firestore';
import { createPosBridge, type PosBridge, type SaleInput } from './posBridge';

// Debe coincidir con firebase.json (singleProjectMode) y .firebaserc.
const projectId = 'donarepa-kds-demo';
process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';

let bridge: PosBridge;
let db: ReturnType<typeof getFirestore>;

const item: SaleInput['items'] = [{ dishId: 'arepa_queso', name: 'Arepa de queso', qty: 1 }];

beforeAll(async () => {
  const admin = initAdmin({ projectId });
  const adminAuth = getAdminAuth(admin);
  const adminDb = getAdminFirestore(admin);

  const uid = await adminAuth
    .createUser({ email: 'pos@donarepa.test', password: 'donarepa123' })
    .then((u) => u.uid)
    .catch(async (e: { code?: string }) => {
      if (e.code === 'auth/email-already-exists') return (await adminAuth.getUserByEmail('pos@donarepa.test')).uid;
      throw e;
    });
  await adminDb.doc(`staff/${uid}`).set({ role: 'pos' });

  const app = initClient({ apiKey: 'demo-key', projectId, authDomain: `${projectId}.firebaseapp.com` });
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  await signInWithEmailAndPassword(auth, 'pos@donarepa.test', 'donarepa123');

  bridge = createPosBridge(db, { retryDelaysMs: [5, 5, 5], maxAttempts: 3, timeoutMs: 5000 });
});

describe('publishOrder idempotencia (RN-08)', () => {
  it('publicar 2 veces el mismo saleId → 1 doc, mismo token', async () => {
    const sale: SaleInput = { saleId: 'sale-idem', number: 101, items: item };
    const r1 = await bridge.publishOrder(sale);
    const r2 = await bridge.publishOrder(sale);

    expect(r1.ok && r2.ok).toBe(true);
    if (!('token' in r1) || !('token' in r2)) throw new Error('faltó token');
    expect(r2.token).toBe(r1.token);
    expect(r2.existing).toBe(true);

    const snap = await getDoc(doc(db, 'orders', 'sale-idem'));
    expect(snap.exists()).toBe(true);
    expect(snap.get('status')).toBe('recibido');
    // un solo public con ese token
    const pub = await getDoc(doc(db, 'public', r1.token));
    expect(pub.exists()).toBe(true);
  });
});

describe('contingencia (RN-15)', () => {
  it('no crea pedido activo: queda como historico_contingencia y sin public', async () => {
    bridge.setContingency(true);
    const sale: SaleInput = { saleId: 'sale-cont', number: 102, items: item };
    const res = await bridge.publishOrder(sale);

    expect('printKitchenTicket' in res && res.printKitchenTicket).toBe(true);
    if ('pending' in res) await res.pending;

    const snap = await getDoc(doc(db, 'orders', 'sale-cont'));
    expect(snap.get('status')).toBe('historico_contingencia');
    expect(snap.get('channel')).toBe('contingencia');
    expect(['recibido', 'en_preparacion']).not.toContain(snap.get('status'));
    expect(snap.get('token')).toBeUndefined(); // sin token → no está en vistas públicas

    // se abrió un incidente (RF-23)
    const incidents = await getDocs(collection(db, 'incidents'));
    expect(incidents.size).toBeGreaterThanOrEqual(1);

    bridge.setContingency(false);
  });
});
