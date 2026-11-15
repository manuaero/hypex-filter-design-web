// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import HealthDiagnostics from '../src/components/HealthDiagnostics';
import { decodeStatus, packet } from '../src/hardware/codec';

it('shows reported errors, warnings, signed sensors and unhealthy state without offering device writes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host),
    raw = packet(5, 6, 1);
  raw[55] = 251;
  raw[56] = 67;
  raw[57] = 0x41;
  raw[58] = 0x06;
  raw[60] = 0x12;
  document.body.append(host);
  try {
    await act(async () => root.render(<HealthDiagnostics status={decodeStatus(raw)} expanded />));
    expect(host.querySelector('details')?.open).toBe(true);
    expect(host.querySelector('summary')?.textContent).toContain(
      'Unhealthy · 2 errors · 2 warnings',
    );
    const reported = Array.from(host.querySelectorAll('.diagnostic-flags .reported')).map(
      (element) => element.textContent,
    );
    expect(reported).toEqual([
      'Temperature sensor failureYes',
      'SRC I²C errorYes',
      'Analog clippingYes',
      'Amplifier clippingYes',
      'DSP switch-off requestedYes',
      'System unhealthyYes',
    ]);
    expect(host.querySelector('.diagnostic-values')?.textContent).toContain('Temperature 1-5');
    expect(host.querySelectorAll('button,input,select')).toHaveLength(0);
    const other = packet(5, 6, 1);
    other[57] = 0x80;
    await act(async () =>
      root.render(<HealthDiagnostics status={decodeStatus(other)} expanded={false} />),
    );
    expect(host.querySelector('details')?.open).toBe(false);
    expect(host.querySelector('summary')?.textContent).toContain('0 errors · 0 warnings');
    expect(host.textContent).toContain('additional unrecognized status bits');
    expect(host.querySelectorAll('.diagnostic-flags .reported')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
