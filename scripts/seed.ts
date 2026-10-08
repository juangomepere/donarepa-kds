// Seed de config, platos y usuarios.
//   npm run seed            → contra la Emulator Suite (arráncala antes)
//   npm run seed -- --prod  → contra producción (requiere GOOGLE_APPLICATION_CREDENTIALS)
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import type { Config, DishStats, Role } from '../src/shared/types';

const PROD = process.argv.includes('--prod');
const projectId =
  process.env.VITE_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'donarepa-kds-demo';

if (!PROD) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8080';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9099';
}

initializeApp(PROD ? { credential: applicationDefault(), projectId } : { projectId });
const db = getFirestore();
const auth = getAuth();

const defaultConfig: Config = {
  c: 5,
  defaultPrepMin: 15,
  minSamples: 5,
  uncollectedMin: 30,
  undoSec: 30,
  noStartGraceMin: 5,
};

// 8 platos de ejemplo. samples en minutos; avgMin = promedio.
const dishes: Record<string, DishStats> = {
  arepa_queso: dish('Arepa de queso', [8, 9, 7, 8, 10, 9]),
  arepa_huevo: dish('Arepa de huevo', [10, 12, 11, 9, 13, 11]),
  arepa_reina: dish('Arepa reina pepiada', [12, 14, 13, 11, 15, 13]),
  arepa_carne: dish('Arepa de carne mechada', [16, 18, 17, 15, 19, 18]),
  patacon: dish('Patacón', [18, 20, 19, 17, 21, 20]),
  empanada: dish('Empanada', [6, 7, 5, 6, 8, 7]),
  jugo_natural: dish('Jugo natural', [4, 5, 3, 4, 5, 4]),
  gaseosa: dish('Gaseosa', [1, 1, 2, 1, 1, 1]),
};

// 4 usuarios con su doc staff/{uid}.
const users: { email: string; role: Role }[] = [
  { email: 'pos@donarepa.test', role: 'pos' },
  { email: 'kds@donarepa.test', role: 'kds' },
  { email: 'gerente@donarepa.test', role: 'gerente' },
  { email: 'admin@donarepa.test', role: 'admin' },
];
const PASSWORD = 'donarepa123';

function dish(name: string, samples: number[]): DishStats {
  const avgMin = Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;
  return { name, samples, avgMin };
}

async function upsertUser(email: string): Promise<string> {
  try {
    const u = await auth.createUser({ email, password: PASSWORD, emailVerified: true });
    return u.uid;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === 'auth/email-already-exists') {
      return (await auth.getUserByEmail(email)).uid;
    }
    throw e;
  }
}

async function main() {
  console.log(`Seeding ${PROD ? 'PRODUCCIÓN' : 'EMULADOR'} (${projectId})…`);

  await db.doc('config/main').set(defaultConfig);
  console.log('✓ config/main');

  for (const [id, data] of Object.entries(dishes)) {
    await db.doc(`dish_stats/${id}`).set(data);
  }
  console.log(`✓ ${Object.keys(dishes).length} platos en dish_stats`);

  for (const { email, role } of users) {
    const uid = await upsertUser(email);
    await db.doc(`staff/${uid}`).set({ role });
    console.log(`✓ ${email} (${role}) → staff/${uid}`);
  }

  console.log(`\nListo. Contraseña de todos los usuarios: ${PASSWORD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
