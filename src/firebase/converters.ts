import { type DocumentSnapshot, Timestamp } from 'firebase/firestore';
import type { Config, DishStats, Order } from '../shared/types';

const ms = (v: unknown): number | null =>
  v instanceof Timestamp ? v.toMillis() : typeof v === 'number' ? v : null;

// Firestore doc → Order de dominio (marcas de tiempo en ms para eta.ts).
export function toOrder(d: DocumentSnapshot): Order {
  const x = (d.data() ?? {}) as Record<string, unknown>;
  return {
    saleId: d.id,
    number: (x.number as number) ?? 0,
    pager: x.pager as string | undefined,
    items: (x.items as Order['items']) ?? [],
    notes: x.notes as string | undefined,
    status: x.status as Order['status'],
    channel: (x.channel as Order['channel']) ?? 'kds',
    posClosedAt: ms(x.posClosedAt),
    tRecibido: ms(x.tRecibido),
    queueAt: ms(x.queueAt),
    tInicio: ms(x.tInicio),
    tListo: ms(x.tListo),
    tEntregado: ms(x.tEntregado),
    tCancelado: ms(x.tCancelado),
    prepMin: (x.prepMin as number) ?? null,
    etaCommittedMin: (x.etaCommittedMin as number) ?? null,
    waitCommittedMin: (x.waitCommittedMin as number) ?? null,
    token: (x.token as string) ?? '',
    replacesSaleId: x.replacesSaleId as string | undefined,
    outOfOrderReason: x.outOfOrderReason as Order['outOfOrderReason'],
    cancelSeen: x.cancelSeen as boolean | undefined,
    reversions: x.reversions as Order['reversions'],
  };
}

export const DEFAULT_CONFIG: Config = {
  c: 5,
  defaultPrepMin: 15,
  minSamples: 5,
  uncollectedMin: 30,
  undoSec: 30,
  noStartGraceMin: 5,
};

export function toConfig(d: DocumentSnapshot | undefined): Config {
  if (!d?.exists()) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...(d.data() as Partial<Config>) };
}

export interface PublicView {
  token: string;
  number: number;
  status: Order['status'];
  queueAt: number | null;
  tInicio: number | null;
  tListo: number | null;
  prepMin: number | null;
  expiresAt: number | null;
}

// public/{token} → vista pública (sin ítems ni datos personales).
export function toPublic(d: DocumentSnapshot): PublicView {
  const x = (d.data() ?? {}) as Record<string, unknown>;
  return {
    token: d.id,
    number: (x.number as number) ?? 0,
    status: x.status as Order['status'],
    queueAt: ms(x.queueAt),
    tInicio: ms(x.tInicio),
    tListo: ms(x.tListo),
    prepMin: (x.prepMin as number) ?? null,
    expiresAt: ms(x.expiresAt),
  };
}

// Adaptador para eta.ts (solo usa saleId, queueAt, status, prepMin, tInicio).
export function publicToOrder(p: PublicView): Order {
  return {
    saleId: p.token,
    number: p.number,
    items: [],
    status: p.status,
    channel: 'kds',
    posClosedAt: null,
    tRecibido: null,
    queueAt: p.queueAt,
    tInicio: p.tInicio,
    tListo: p.tListo,
    tEntregado: null,
    tCancelado: null,
    prepMin: p.prepMin,
    etaCommittedMin: null,
    waitCommittedMin: null,
    token: p.token,
  };
}

// K5: timestamp del evento más reciente de un doc public (para medir latencia).
export function latestEventMs(p: Pick<PublicView, 'queueAt' | 'tInicio' | 'tListo'>): number | null {
  return [p.tListo, p.tInicio, p.queueAt].reduce<number | null>(
    (max, v) => (v != null && (max == null || v > max) ? v : max),
    null,
  );
}

export function toDishStats(d: DocumentSnapshot): DishStats {
  const x = (d.data() ?? {}) as Record<string, unknown>;
  return {
    name: (x.name as string) ?? d.id,
    samples: (x.samples as number[]) ?? [],
    avgMin: (x.avgMin as number) ?? 0,
  };
}
