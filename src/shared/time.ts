// Hora local America/Bogota, 24 h.
export function formatClock(ms: number | null): string {
  if (ms == null) return '--:--';
  return new Date(ms).toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Bogota',
  });
}

// "m:ss" transcurridos desde `fromMs`.
export function formatElapsed(fromMs: number | null, now: number): string {
  if (fromMs == null) return '0:00';
  const s = Math.max(0, Math.floor((now - fromMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const minutesSince = (fromMs: number | null, now: number): number =>
  fromMs == null ? 0 : (now - fromMs) / 60000;
