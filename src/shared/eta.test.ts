import { describe, expect, it } from 'vitest';
import {
  computeQueue,
  fifoWindow,
  remainingMin,
  updateDishSamples,
} from './eta';
import type { Config, Order, OrderStatus } from './types';

const config: Config = {
  c: 5,
  defaultPrepMin: 15,
  minSamples: 5,
  uncollectedMin: 30,
  undoSec: 30,
  noStartGraceMin: 5,
};

const NOW = 1_700_000_000_000; // base fija
const min = (m: number) => m * 60000;

function order(
  saleId: string,
  status: OrderStatus,
  prepMin: number,
  opts: Partial<Order> = {},
): Order {
  return {
    saleId,
    number: Number(saleId),
    items: [],
    status,
    channel: 'kds',
    posClosedAt: null,
    tRecibido: NOW,
    queueAt: NOW,
    tInicio: null,
    tListo: null,
    tEntregado: null,
    tCancelado: null,
    prepMin,
    etaCommittedMin: null,
    waitCommittedMin: null,
    token: `tok-${saleId}`,
    ...opts,
  };
}

// en_preparacion con `advanceMin` minutos transcurridos desde tInicio.
function prep(saleId: string, prepMin: number, advanceMin: number, queueAt: number): Order {
  return order(saleId, 'en_preparacion', prepMin, {
    tInicio: NOW - min(advanceMin),
    queueAt,
  });
}

describe('caso obligatorio 101–106 (CLAUDE.md)', () => {
  it('ETA de 106 = 29 y posición 5', () => {
    const q: Order[] = [
      prep('101', 15, 11, NOW - min(50)), // R4
      prep('102', 12, 6, NOW - min(40)), // R6
      prep('103', 15, 3, NOW - min(30)), // R12
      order('104', 'recibido', 15, { queueAt: NOW - min(20) }), // R15
      order('105', 'recibido', 18, { queueAt: NOW - min(10) }), // R18
      order('106', 'recibido', 18, { queueAt: NOW }), // T=18
    ];
    const entries = computeQueue(q, config, NOW);
    const e106 = entries.find((e) => e.order.saleId === '106')!;
    expect(e106.etaMin).toBe(29);
    expect(e106.position).toBe(5);
    // R individuales
    expect(remainingMin(q[0], NOW)).toBe(4);
    expect(remainingMin(q[1], NOW)).toBe(6);
    expect(remainingMin(q[2], NOW)).toBe(12);
  });
});

describe('cola vacía / un solo pedido', () => {
  it('W=0 para el primer pedido', () => {
    const [e] = computeQueue([order('1', 'recibido', 15)], config, NOW);
    expect(e.waitMin).toBe(0);
    expect(e.etaMin).toBe(15); // ETA = 0 + T
    expect(e.position).toBe(0);
  });
});

describe('pedido en preparación con avance > T', () => {
  it('ETA mínima de 1 min', () => {
    const o = prep('1', 10, 15, NOW); // avance 15 > T 10
    expect(remainingMin(o, NOW)).toBe(1);
    const [e] = computeQueue([o], config, NOW);
    expect(e.etaMin).toBe(1);
  });
});

describe('redondeo hacia arriba', () => {
  it('ETA fraccionaria sube al minuto', () => {
    // dos recibido: W(segundo) = 10/5 = 2; T=5 → 7 exacto. Forzamos fracción con T no entero.
    const q = [
      order('1', 'recibido', 10, { queueAt: NOW - min(5) }),
      order('2', 'recibido', 5.5, { queueAt: NOW }),
    ];
    const e2 = computeQueue(q, config, NOW).find((e) => e.order.saleId === '2')!;
    // W = 10/5 = 2; 2 + 5.5 = 7.5 → 8
    expect(e2.etaMin).toBe(8);
  });
});

describe('reemplazo con queueAt heredado', () => {
  it('se ordena en la posición del original, no al final', () => {
    const q = [
      order('A', 'recibido', 15, { queueAt: NOW - min(30) }),
      order('B', 'recibido', 15, { queueAt: NOW - min(10) }),
      // reemplazo de A, creado ahora pero hereda queueAt de A
      order('A2', 'recibido', 15, {
        queueAt: NOW - min(30),
        tRecibido: NOW,
        replacesSaleId: 'A',
      }),
    ];
    const entries = computeQueue(q, config, NOW);
    // A2 hereda queueAt antiguo → va primero (empatado con A, estable), B después.
    expect(entries[entries.length - 1].order.saleId).toBe('B');
    expect(entries.find((e) => e.order.saleId === 'A2')!.position).toBeLessThan(
      entries.find((e) => e.order.saleId === 'B')!.position,
    );
  });
});

describe('ventana FIFO (RN-02)', () => {
  it('c=5 con 3 en preparación → 2 habilitados', () => {
    const q = [
      prep('1', 15, 2, NOW - min(50)),
      prep('2', 15, 2, NOW - min(45)),
      prep('3', 15, 2, NOW - min(40)),
      order('4', 'recibido', 15, { queueAt: NOW - min(30) }),
      order('5', 'recibido', 15, { queueAt: NOW - min(20) }),
      order('6', 'recibido', 15, { queueAt: NOW - min(10) }),
    ];
    const enabled = fifoWindow(q, config.c);
    expect(enabled).toEqual(['4', '5']); // los 2 recibido más antiguos
  });

  it('todos en preparación → al menos 1 habilitado', () => {
    const q = [
      prep('1', 15, 2, NOW - min(50)),
      prep('2', 15, 2, NOW - min(45)),
      prep('3', 15, 2, NOW - min(40)),
      prep('4', 15, 2, NOW - min(35)),
      prep('5', 15, 2, NOW - min(30)),
      order('6', 'recibido', 15, { queueAt: NOW - min(10) }),
    ];
    expect(fifoWindow(q, config.c)).toEqual(['6']);
  });
});

describe('descarte de atípicos (RN-11)', () => {
  it('rechaza < 1 min', () => {
    expect(updateDishSamples([10, 12, 11], 0.5)).toEqual([10, 12, 11]);
  });
  it('rechaza > 3× mediana', () => {
    // mediana = 11 → umbral 33; 40 se descarta
    expect(updateDishSamples([10, 12, 11], 40)).toEqual([10, 12, 11]);
  });
  it('acepta muestra válida y mantiene ventana de 20', () => {
    expect(updateDishSamples([10, 12, 11], 13)).toEqual([10, 12, 11, 13]);
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    const res = updateDishSamples(twenty, 10);
    expect(res).toHaveLength(20);
    expect(res[res.length - 1]).toBe(10);
    expect(res[0]).toBe(2); // se descartó el más antiguo
  });
});
