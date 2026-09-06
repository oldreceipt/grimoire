// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mod } from '../types/mod';
import type { ImportCustomModArgs, ImportCustomModResult } from '../lib/api';
import ImportCustomModsModal from './ImportCustomModsModal';

const mocks = vi.hoisted(() => ({
  mods: [] as Mod[],
  prepare: vi.fn(),
  pick: vi.fn(),
  pickMulti: vi.fn(),
}));
vi.mock('../stores/appStore', () => ({ useAppStore: (selector: (state: { mods: Mod[] }) => unknown) => selector({ mods: mocks.mods }) }));
vi.mock('../lib/api', () => ({
  prepareLocalVpkReplacement: mocks.prepare,
  showOpenDialog: mocks.pick,
  showOpenDialogMulti: mocks.pickMulti,
  onImportCustomModsProgress: () => () => {},
  peekImprint: async () => null,
  readImageDataUrl: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => String(values?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
  Trans: () => <span>Drop files</span>,
}));
vi.mock('./common/Modal', () => ({ Modal: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('./common/ui', () => ({
  Button: ({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  IconButton: ({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick?: () => void }) => <button disabled={disabled} onClick={onClick}>{label}</button>,
  ModalHeader: ({ title }: { title: ReactNode }) => <h1>{title}</h1>,
  Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  CheckboxMark: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const target: Mod = {
  id: 'a', name: 'Blue Ivy', metaKey: 'pak01_dir.vpk', fileName: 'pak01_dir.vpk',
  path: '/addons/pak01_dir.vpk', enabled: true, priority: 1, size: 100,
  installedAt: '', sha256: 'canonical-a',
};
const fingerprint = (mod: Mod, physical: string) => ({ metaKey: mod.metaKey, expectedSha256: mod.sha256!, expectedFileSha256: physical });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('local replacement review', () => {
  let host: HTMLDivElement;
  let root: Root;
  let onImport: ReturnType<typeof vi.fn<(items: ImportCustomModArgs[]) => Promise<ImportCustomModResult[]>>>;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mods = [target];
    mocks.pick.mockResolvedValue('/download/blue_ivy.vpk');
    mocks.pickMulti.mockResolvedValue(['/download/blue_ivy.vpk']);
    window.electronAPI = { platform: 'win32' } as Window['electronAPI'];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    onImport = vi.fn<(items: ImportCustomModArgs[]) => Promise<ImportCustomModResult[]>>().mockResolvedValue([{ vpkPath: '/download/blue_ivy.vpk', ok: true, imported: 1 }]);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  const footer = () => host.querySelectorAll('button')[host.querySelectorAll('button').length - 1];
  async function render(explicit = false) {
    await act(async () => root.render(<ImportCustomModsModal onClose={vi.fn()} onImport={onImport} replacementTarget={explicit ? target : undefined} />));
    await act(async () => (host.querySelector('[role="button"]') as HTMLElement).click());
  }
  async function choose(metaKey: string) {
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = metaKey;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('requires preparation and submits the physical fingerprint reviewed when the explicit dialog opened', async () => {
    const preparation = deferred<ReturnType<typeof fingerprint>>();
    mocks.prepare.mockReturnValue(preparation.promise);
    await render(true);
    expect(footer().disabled).toBe(true);
    expect(host.textContent).toContain('Checking the installed VPK');
    await act(async () => preparation.resolve(fingerprint(target, 'physical-original')));
    expect(footer().disabled).toBe(false);
    await act(async () => footer().click());
    expect(onImport.mock.calls[0][0][0].replacement).toEqual(fingerprint(target, 'physical-original'));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });

  it('keeps name collisions as separate imports until the user chooses replacement', async () => {
    await render();
    expect(host.querySelector('select')!.value).toBe('');
    expect(mocks.prepare).not.toHaveBeenCalled();
    await act(async () => footer().click());
    expect(onImport.mock.calls[0][0][0].replacement).toBeUndefined();
  });

  it('discards an older preparation response after a different target is selected', async () => {
    const other = { ...target, id: 'b', metaKey: 'pak02_dir.vpk', sha256: 'canonical-b' };
    mocks.mods = [target, other];
    const first = deferred<ReturnType<typeof fingerprint>>();
    const second = deferred<ReturnType<typeof fingerprint>>();
    mocks.prepare.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await choose(target.metaKey);
    await choose(other.metaKey);
    expect(footer().disabled).toBe(true);
    await act(async () => second.resolve(fingerprint(other, 'physical-b')));
    await act(async () => first.resolve(fingerprint(target, 'physical-a')));
    await act(async () => footer().click());
    expect(onImport.mock.calls[0][0][0].replacement).toEqual(fingerprint(other, 'physical-b'));
  });

  it('shows preparation failure and never silently falls back to adding a duplicate', async () => {
    mocks.prepare.mockRejectedValue(new Error('Installed VPK changed'));
    await render();
    await choose(target.metaKey);
    expect(host.textContent).toContain('Installed VPK changed');
    expect(footer().disabled).toBe(true);
    expect(host.querySelector('select')!.value).toBe(target.metaKey);
    expect(onImport).not.toHaveBeenCalled();
    await choose('');
    expect(footer().disabled).toBe(false);
  });
});
