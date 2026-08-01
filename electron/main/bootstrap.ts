import { app, protocol } from 'electron';
import { isAbsolute, join, resolve } from 'path';

const harnessRoot = process.env['GRIMOIRE_UPDATE_HARNESS_ROOT'];
if (harnessRoot) {
    const absoluteRoot = isAbsolute(harnessRoot) ? harnessRoot : resolve(harnessRoot);
    app.setPath('userData', join(absoluteRoot, 'user-data'));
}

// Privileged schemes must be declared synchronously before app-ready. Keep
// this bootstrap free of application-service imports so harness userData is
// still selected before modules that may touch settings or metadata load.
protocol.registerSchemesAsPrivileged([
    { scheme: 'grimoire-soul', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'grimoire-hero', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
    { scheme: 'grimoire-foundry', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// This must remain a dynamic import. Static imports are evaluated before the
// app.setPath call above and would let settings/metadata modules observe the
// user's normal Grimoire directory during a disposable harness run.
void import('./index');
