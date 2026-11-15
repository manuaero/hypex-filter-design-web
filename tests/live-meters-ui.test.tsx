// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import LiveMeters from '../src/components/LiveMeters';
import { decodeStatus, packet } from '../src/hardware/codec';

it('shows independent Left/Right input and aggregate output, then removes disconnected readings', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const make = (serial: string, input: number, muted: boolean) => {
    const bytes = packet(5, 6, 1),
      view = new DataView(bytes.buffer);
    bytes[6] = muted ? 128 : 0;
    view.setInt16(46, input, true);
    view.setInt16(48, 16384, true);
    view.setUint16(44, 480, true);
    return { status: decodeStatus(bytes), identity: { serial } };
  };
  try {
    await act(async () =>
      root.render(
        <LiveMeters
          connections={{ left: make('LEFT', 4096, false), right: make('RIGHT', 8192, true) }}
        />,
      ),
    );
    const left = host.querySelector('[aria-label="Left amplifier levels"]')!,
      right = host.querySelector('[aria-label="Right amplifier levels"]')!;
    expect(left.querySelector('[aria-label="Input"]')?.getAttribute('aria-valuenow')).toBe('0');
    expect(right.querySelector('[aria-label="Input"]')?.getAttribute('aria-valuetext')).toBe(
      '6.0 dB',
    );
    expect(right.querySelector('[aria-label="Output"]')?.getAttribute('aria-valuenow')).toBe('-72');
    expect(left.querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(right.getAttribute('title')).toContain('master muted');
    expect(right.getAttribute('title')).toContain('48,000 Hz');
    await act(async () =>
      root.render(<LiveMeters paused connections={{ left: make('LEFT', -1, false) }} />),
    );
    expect(host.querySelector('[aria-label="Input"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.querySelector('[aria-label="Input"]')?.getAttribute('aria-valuetext')).toBe(
      'Unavailable',
    );
    expect(host.querySelector('[aria-label="Right amplifier levels"]')?.textContent).toBe(
      'ROffline',
    );
    expect(host.querySelectorAll('[role="meter"]')).toHaveLength(2);
    expect(host.querySelector('.live-meters')?.classList.contains('paused')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
