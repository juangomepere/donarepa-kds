import { describe, expect, it, vi } from 'vitest';
import { withRetries } from './posBridge';

describe('withRetries (RN-09)', () => {
  it('reintenta tras fallos y resuelve (falla 2 veces → éxito al 3.º)', async () => {
    let n = 0;
    const attempt = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error('fallo transitorio');
      return 'listo';
    });
    const res = await withRetries(attempt, { retryDelaysMs: [1, 1, 1], maxAttempts: 3, timeoutMs: 1000 });
    expect(res).toMatchObject({ ok: true, attempts: 3 });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('tras 3 fallos devuelve ok:false y dispara contingencia', async () => {
    const onNeedsContingency = vi.fn();
    const attempt = vi.fn(async () => {
      throw new Error('sin red');
    });
    const res = await withRetries(attempt, {
      retryDelaysMs: [1, 1, 1],
      maxAttempts: 3,
      timeoutMs: 1000,
      onNeedsContingency,
    });
    expect(res.ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onNeedsContingency).toHaveBeenCalledOnce();
  });

  it('respeta el timeout por intento', async () => {
    const attempt = vi.fn(() => new Promise<string>(() => {})); // nunca resuelve
    const res = await withRetries(attempt, { retryDelaysMs: [1, 1], maxAttempts: 2, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
