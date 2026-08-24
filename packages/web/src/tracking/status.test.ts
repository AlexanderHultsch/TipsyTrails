import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { computeConnectionStatus, computeGpsStatus } from './status.js';

describe('computeGpsStatus', () => {
  it('is poor with no fix at all', () => {
    expect(computeGpsStatus(null, 0)).toBe('poor');
  });

  it('is good at and below the good boundary', () => {
    expect(computeGpsStatus({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M, receivedAt: 0 }, 0)).toBe(
      'good',
    );
    expect(computeGpsStatus({ accuracy: 1, receivedAt: 0 }, 0)).toBe('good');
  });

  it('is fair just above the good boundary and up to the fair boundary', () => {
    expect(computeGpsStatus({ accuracy: CONFIG.GPS_ACCURACY_GOOD_M + 1, receivedAt: 0 }, 0)).toBe(
      'fair',
    );
    expect(computeGpsStatus({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M, receivedAt: 0 }, 0)).toBe(
      'fair',
    );
  });

  it('is poor above the fair boundary', () => {
    expect(computeGpsStatus({ accuracy: CONFIG.GPS_ACCURACY_FAIR_M + 1, receivedAt: 0 }, 0)).toBe(
      'poor',
    );
  });

  it('goes poor once GPS_STALE_MS has passed since the last fix, even with good accuracy', () => {
    const fix = { accuracy: 1, receivedAt: 0 };
    expect(computeGpsStatus(fix, CONFIG.GPS_STALE_MS - 1)).toBe('good');
    expect(computeGpsStatus(fix, CONFIG.GPS_STALE_MS)).toBe('poor');
  });
});

describe('computeConnectionStatus', () => {
  it('is offline when navigator.onLine is false, however far behind this device is', () => {
    expect(computeConnectionStatus(false, 0)).toBe('offline');
    expect(computeConnectionStatus(false, 3)).toBe('offline');
  });

  it('is online when online and nothing has missed a send cycle', () => {
    expect(computeConnectionStatus(true, 0)).toBe('online');
  });

  it('is syncing when online with samples that have survived a send attempt', () => {
    expect(computeConnectionStatus(true, 1)).toBe('syncing');
  });
});
