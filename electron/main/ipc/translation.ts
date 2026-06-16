import { ipcMain } from 'electron';
import type { TranslationSuggestionRequest } from '../../../src/types/translation';
import {
    getTranslationCatalog,
    getTranslationProgress,
    registerTranslationContributor,
    saveTranslationSuggestion,
} from '../services/translation';

ipcMain.handle('translation:getCatalog', async (_event, languageCode: string) => {
    return getTranslationCatalog(languageCode);
});

ipcMain.handle('translation:getProgress', async (_event, languageCode: string) => {
    return getTranslationProgress(languageCode);
});

ipcMain.handle('translation:saveSuggestion', async (_event, body: TranslationSuggestionRequest) => {
    return saveTranslationSuggestion(body);
});

ipcMain.handle('translation:registerContributor', async () => {
    return registerTranslationContributor();
});
