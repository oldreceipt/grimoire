// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomConvarSettings, CustomConvarStatus } from '../../types/electron';
import CustomConvars from './CustomConvars';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../common/ui', () => ({
  Button: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  Toggle: ({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) => <label>{label}<input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /></label>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('personal convar editor', () => {
  let host: HTMLDivElement;
  let root: Root;
  let stored: CustomConvarSettings;
  let getStatus: ReturnType<typeof vi.fn<() => Promise<CustomConvarStatus>>>;
  let save: ReturnType<typeof vi.fn<(settings: CustomConvarSettings) => Promise<CustomConvarStatus>>>;
  let apply: ReturnType<typeof vi.fn<() => Promise<CustomConvarStatus>>>;
  let onApplied: ReturnType<typeof vi.fn<() => void>>;
  const status = (): CustomConvarStatus => ({ settings: stored, applied: false, error: null });

  beforeEach(() => {
    stored = { entries: [{ key: 'r_aspectratio', value: '2.15', enabled: true }], autoRestore: false };
    getStatus = vi.fn<() => Promise<CustomConvarStatus>>().mockImplementation(async () => status());
    save = vi.fn<(settings: CustomConvarSettings) => Promise<CustomConvarStatus>>().mockImplementation(async (settings) => {
      stored = structuredClone(settings);
      return status();
    });
    apply = vi.fn<() => Promise<CustomConvarStatus>>().mockImplementation(async () => ({ ...status(), applied: true }));
    onApplied = vi.fn<() => void>();
    window.electronAPI = { getCustomConvarStatus: getStatus, saveCustomConvars: save, applyCustomConvars: apply } as unknown as Window['electronAPI'];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });
  const button = (key: string) => [...host.querySelectorAll('button')].find((element) => element.textContent === `performance.custom.${key}`)!;
  const inputs = () => [...host.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')];
  const render = () => act(async () => root.render(<CustomConvars revision={null} onApplied={onApplied} />));
  const click = (element: HTMLElement) => act(async () => element.click());
  async function edit(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('saves edits without applying or reporting them applied when Save only is chosen', async () => {
    await render();
    await edit(inputs()[1], '1.8');
    expect(button('save').disabled).toBe(false);
    await click(button('save'));
    expect(save).toHaveBeenCalledWith({ entries: [{ key: 'r_aspectratio', value: '1.8', enabled: true }], autoRestore: false });
    expect(apply).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
    expect(button('save').disabled).toBe(true);
    expect(host.textContent).toContain('performance.custom.saved');
    expect(host.textContent).toContain('performance.custom.pending');
  });

  it('waits for validated saved preferences before applying and retains them after the running-game rejection', async () => {
    await render();
    await edit(inputs()[0], ' R_ASPECTRATIO ');
    await edit(inputs()[1], '1.7');
    const saving = deferred<CustomConvarStatus>();
    save.mockReturnValueOnce(saving.promise);
    apply.mockRejectedValueOnce(new Error('Close Deadlock before changing gameinfo.gi.'));
    await click(button('saveApply'));
    expect(apply).not.toHaveBeenCalled();
    expect(button('saveApply').disabled).toBe(true);
    stored = { entries: [{ key: 'r_aspectratio', value: '1.7', enabled: true }], autoRestore: false };
    await act(async () => saving.resolve(status()));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(inputs()[0].value).toBe('r_aspectratio');
    expect(inputs()[1].value).toBe('1.7');
    expect(button('save').disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Close Deadlock');
    expect(host.textContent).not.toContain('performance.custom.applied');
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('never applies a rejected save and leaves the draft available to fix', async () => {
    await render();
    await edit(inputs()[1], 'bad"value');
    save.mockRejectedValueOnce(new Error('Invalid convar value'));
    await click(button('saveApply'));
    expect(apply).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Invalid convar value');
    expect(inputs()[1].value).toBe('bad"value');
    expect(button('save').disabled).toBe(false);
  });

  it('saves a disabled row without deleting it, and removes it only after the remove action', async () => {
    await render();
    await click(host.querySelector<HTMLInputElement>('[aria-label="performance.custom.enable"]')!);
    await click(button('save'));
    expect(stored.entries).toEqual([{ key: 'r_aspectratio', value: '2.15', enabled: false }]);
    expect(inputs()).toHaveLength(2);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="performance.custom.remove"]')!);
    expect(inputs()).toHaveLength(0);
    await click(button('saveApply'));
    expect(stored.entries).toEqual([]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
