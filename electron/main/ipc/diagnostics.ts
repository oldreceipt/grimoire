import { ipcMain } from 'electron';
import { buildReportText } from '../services/diagnostics';

ipcMain.handle(
    'diagnostics:buildReport',
    (_, description: unknown, options: unknown): Promise<string> => {
        const includeFullLog =
            typeof options === 'object' &&
            options !== null &&
            (options as { includeFullLog?: unknown }).includeFullLog === true;
        return buildReportText(
            typeof description === 'string' ? description : '',
            { includeFullLog },
        );
    },
);
