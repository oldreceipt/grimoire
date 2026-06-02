import { ipcMain } from 'electron';
import { updatePresence, clearPresence, type PresenceContext } from '../services/discordRpc';

// discord:update - set Rich Presence for the current surface. Fire-and-forget;
// the service connects lazily and throttles, so the renderer can call this on
// every navigation without coordinating.
ipcMain.handle('discord:update', (_, ctx: PresenceContext): void => {
    updatePresence(ctx);
});

// discord:clear - drop the presence and disconnect (toggle turned off).
ipcMain.handle('discord:clear', (): Promise<void> => {
    return clearPresence();
});
