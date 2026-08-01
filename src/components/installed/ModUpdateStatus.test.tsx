// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModUpdateProgress } from '../../types/modUpdate';
import ModUpdateStatus from './ModUpdateStatus';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const base: ModUpdateProgress = {
  operationId: 'op-1',
  stableKey: 'gamebanana:42',
  phase: 'preparing',
  displayName: 'Fixture Mod',
  gameBananaId: 42,
  fileId: 99,
};

describe('ModUpdateStatus', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function render(progress: ModUpdateProgress, props: { onCancel?: () => void; onRetry?: () => void } = {}) {
    act(() => root.render(<ModUpdateStatus progress={progress} {...props} />));
  }

  it.each([
    ['preparing', 'Preparing'],
    ['installing', 'Installing'],
    ['updated', 'Updated'],
    ['failed', 'Update failed'],
    ['cancelled', 'Cancelled'],
    ['needs-choice', 'Needs user choice'],
  ] as const)('communicates the %s phase in text', (phase, label) => {
    render({ ...base, phase });
    expect(host.textContent).toContain(label);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(label);
  });

  it('exposes determinate download progress with accessible values', () => {
    render({ ...base, phase: 'downloading', downloaded: 25, total: 100 });
    const progressbar = host.querySelector('[role="progressbar"]');
    expect(progressbar?.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar?.getAttribute('aria-valuemax')).toBe('100');
    expect(progressbar?.getAttribute('aria-valuenow')).toBe('25');
    expect(progressbar?.getAttribute('aria-valuetext')).toBe('25 percent');
    expect(host.textContent).toContain('25%');
  });

  it('uses indeterminate progress semantics when a total is unavailable', () => {
    render({ ...base, phase: 'downloading', downloaded: 512 });
    const progressbar = host.querySelector('[role="progressbar"]');
    expect(progressbar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(progressbar?.getAttribute('aria-valuetext')).toBe('Downloading');
  });

  it('does not put byte-level progress into the live announcement', () => {
    render({ ...base, phase: 'downloading', downloaded: 10, total: 100 });
    const live = host.querySelector('[role="status"]');
    expect(live?.textContent).toBe('Downloading');

    render({ ...base, phase: 'downloading', downloaded: 90, total: 100 });
    expect(host.querySelector('[role="status"]')).toBe(live);
    expect(live?.textContent).toBe('Downloading');
  });

  it('offers a native keyboard-accessible retry after failure', () => {
    const onRetry = vi.fn();
    render({ ...base, phase: 'failed', message: 'Old VPK retained' }, { onRetry });
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent?.includes('Retry'));
    expect(retry?.getAttribute('type')).toBe('button');
    act(() => retry!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('allows cancellation before the swap but not during installation', () => {
    const onCancel = vi.fn();
    render({ ...base, phase: 'downloading' }, { onCancel });
    const cancel = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Cancel');
    expect(cancel).toBeDefined();
    act(() => cancel!.click());
    expect(onCancel).toHaveBeenCalledOnce();

    render({ ...base, phase: 'installing' }, { onCancel });
    expect(host.textContent).not.toContain('Cancel');
  });

  it('contains reduced-motion overrides for animation and progress transitions', () => {
    render({ ...base, phase: 'downloading' });
    expect(host.innerHTML).toContain('motion-reduce:animate-none');
    expect(host.innerHTML).toContain('motion-reduce:transition-none');
    expect(host.textContent).toContain('Downloading');
  });
});
