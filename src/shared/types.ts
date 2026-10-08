// Modelo de datos (CLAUDE.md). Las marcas de tiempo son epoch ms en el dominio;
// los converters de Firestore traducen Timestamp <-> number.

export type Role = 'pos' | 'kds' | 'gerente' | 'admin';
export type Channel = 'kds' | 'contingencia';

export type OrderStatus =
  | 'recibido'
  | 'en_preparacion'
  | 'listo'
  | 'entregado'
  | 'cancelado'
  | 'no_recogido'
  | 'historico_contingencia';

export type OutOfOrderReason = 'producto_rapido' | 'otro';

export interface OrderItem {
  dishId: string;
  name: string;
  qty: number;
  notes?: string;
}

export interface Reversion {
  from: OrderStatus;
  to: OrderStatus;
  at: number;
}

export interface Order {
  saleId: string; // = id de la venta en el POS (llave única, RN-08)
  number: number;
  pager?: string;
  items: OrderItem[];
  notes?: string;
  status: OrderStatus;
  channel: Channel;
  posClosedAt: number | null; // hora cliente POS
  tRecibido: number | null; // serverTimestamp
  queueAt: number | null; // = tRecibido, o el del original si es reemplazo
  tInicio: number | null;
  tListo: number | null;
  tEntregado: number | null;
  tCancelado: number | null;
  prepMin: number | null; // T congelado al enriquecer
  etaCommittedMin: number | null;
  waitCommittedMin: number | null;
  token: string;
  replacesSaleId?: string;
  outOfOrderReason?: OutOfOrderReason;
  cancelSeen?: boolean;
  reversions?: Reversion[];
}

// public/{token} — sin ítems ni observaciones (RN-14, Ley 1581)
export interface PublicOrder {
  number: number;
  status: OrderStatus;
  queueAt: number | null;
  tInicio: number | null;
  tListo: number | null;
  prepMin: number | null;
  expiresAt: number | null;
}

export interface DishStats {
  name: string;
  samples: number[]; // últimos 20, minutos
  avgMin: number;
}

export interface Config {
  c: number;
  defaultPrepMin: number;
  minSamples: number;
  uncollectedMin: number;
  undoSec: number;
  noStartGraceMin: number;
}

export interface ConfigChange {
  by: string;
  at: number | null;
  before: Partial<Config>;
  after: Partial<Config>;
}

export interface Staff {
  role: Role;
}

export interface Heartbeat {
  lastSeen: number | null;
}

export interface Incident {
  start: number | null;
  end: number | null;
  durationMin: number;
  cause: string;
  affectedSaleIds: string[];
}
