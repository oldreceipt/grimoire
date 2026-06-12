import { ipcMain } from 'electron';
import { getActiveDeadlockPath } from '../services/settings';
import {
    applyPerformanceConfig,
    getPerformanceConfigStatus,
    removePerformanceConfig,
} from '../services/performanceConfig';
import type { PerformanceConfigStatus } from '../../../src/types/electron';

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
