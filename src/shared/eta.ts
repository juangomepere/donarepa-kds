// Motor de ETA — funciones puras, sin Firebase (CLAUDE.md).
// Marcas de tiempo en epoch ms; `now` también.
import type { Config, DishStats, Order, OrderItem } from './types';

export function minutesBetween(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / 60000;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// T(i) = máx de avgMin de los platos del pedido; plato con < minSamples muestras → defaultPrepMin.
export function prepMinForItems(
  items: OrderItem[],
  dishStats: Record<string, DishStats>,
  config: Config,
): number {
  let max = 0;
  for (const it of items) {
    const stat = dishStats[it.dishId];
    const t =
      stat && stat.samples.length >= config.minSamples ? stat.avgMin : config.defaultPrepMin;
    if (t > max) max = t;
  }
  return max || config.defaultPrepMin;
}

// R(j): T si recibido; max(T − minutos desde tInicio, 1) si en_preparacion.
export function remainingMin(order: Order, now: number): number {
  const t = order.prepMin ?? 0;
  if (order.status === 'en_preparacion' && order.tInicio != null) {
    return Math.max(t - minutesBetween(order.tInicio, now), 1);
  }
  return t;
}

export interface QueueEntry {
  order: Order;
  position: number; // nº de pedidos activos antes de i
  etaMin: number;
  waitMin: number;
  estimatedReadyAt: number; // epoch ms
}

// Cola activa = recibido + en_preparacion, ordenados por queueAt (RN-01).
export function computeQueue(activeOrders: Order[], config: Config, now: number): QueueEntry[] {
  const sorted = [...activeOrders].sort((a, b) => (a.queueAt ?? 0) - (b.queueAt ?? 0));
  const r = sorted.map((o) => remainingMin(o, now));
  const out: QueueEntry[] = [];
  let sumBefore = 0;
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    const t = o.prepMin ?? 0;
    const w = sumBefore / config.c; // W(i) = Σ R(anteriores) / c
    const etaMin =
      o.status === 'en_preparacion' ? Math.ceil(r[i]) : Math.ceil(w + t); // ETA = W + T
    out.push({
      order: o,
      position: i,
      etaMin,
      waitMin: Math.ceil(w),
      estimatedReadyAt: now + etaMin * 60000,
    });
    sumBefore += r[i];
  }
  return out;
}

// RN-12: ratio = min desde queueAt / etaCommittedMin → verde <0.8, amarillo 0.8–1, rojo >1.
export function semaphore(order: Order, now: number): 'verde' | 'amarillo' | 'rojo' {
  const committed = order.etaCommittedMin ?? 0;
  if (!committed || order.queueAt == null) return 'verde';
  const ratio = minutesBetween(order.queueAt, now) / committed;
  if (ratio < 0.8) return 'verde';
  if (ratio <= 1) return 'amarillo';
  return 'rojo';
}

// RN-13: recibido y minutos desde queueAt > waitCommittedMin + 5.
export function isNoStartAlert(order: Order, now: number, _config: Config): boolean {
  if (order.status !== 'recibido' || order.queueAt == null) return false;
  const wait = order.waitCommittedMin ?? 0;
  return minutesBetween(order.queueAt, now) > wait + 5;
}

// RN-11: descartar < 1 min o > 3× mediana; ventana de 20.
export function updateDishSamples(samples: number[], newSampleMin: number): number[] {
  if (newSampleMin < 1) return samples;
  if (samples.length > 0 && newSampleMin > 3 * median(samples)) return samples;
  return [...samples, newSampleMin].slice(-20);
}

// RN-02: "Iniciar" habilitado para los k recibido más antiguos, k = max(1, c − nº en_preparacion).
export function fifoWindow(queue: Order[], c: number): string[] {
  const inPrep = queue.filter((o) => o.status === 'en_preparacion').length;
  const k = Math.max(1, c - inPrep);
  return queue
    .filter((o) => o.status === 'recibido')
    .sort((a, b) => (a.queueAt ?? 0) - (b.queueAt ?? 0))
    .slice(0, k)
    .map((o) => o.saleId);
}
