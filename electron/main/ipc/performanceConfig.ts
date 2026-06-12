import { ipcMain } from 'electron';
import { loadSettings } from '../services/settings';
import {
    applyPerformanceConfig,
    getPerformanceConfigStatus,
    removePerformanceConfig,
} from '../services/performanceConfig';
import type { PerformanceConfigStatus } from '../../../src/types/electron';

function getActiveDeadlockPath(): string | null {
    const settings = loadSettings();
    if (settings.devMode && settings.devDeadlockPath) {
        return settings.devDeadlockPath;
    }
    return settings.deadlockPath;
}

// get-performance-config-status
ipcMain.handle('get-performance-config-status', (): PerformanceConfigStatus => {
    return getPerformanceConfigStatus(getActiveDeadlockPath());
});

// apply-performance-config
ipcMain.handle('apply-performance-config', (): PerformanceConfigStatus => {
    return applyPerformanceConfig(getActiveDeadlockPath());
});

// remove-performance-config
ipcMain.handle('remove-performance-config', (): PerformanceConfigStatus => {
    return removePerformanceConfig(getActiveDeadlockPath());
});
