import type { CSSProperties } from 'react';
import { getAssetPath } from '../lib/assetPath';

const TITLE_ICON = getAssetPath('/grimoire-title-icon.svg');

// Matches the titleBarOverlay height set in electron/main/index.ts. The OS
// draws the min/max/close controls over the right edge of this strip; the
// strip itself provides the drag region and title the hidden frame used to.
const TITLE_BAR_HEIGHT = 36;

const dragStyle: CSSProperties & { WebkitAppRegion: string } = {
    height: TITLE_BAR_HEIGHT,
    WebkitAppRegion: 'drag',
};

export default function WindowsTitleBar() {
    if (window.electronAPI.platform !== 'win32') return null;
    return (
        <header
            style={dragStyle}
            className="flex flex-shrink-0 select-none items-center gap-2 border-b border-border bg-bg-primary px-3"
        >
            <img
                src={TITLE_ICON}
                alt=""
                aria-hidden
                draggable={false}
                className="h-4 w-4 flex-shrink-0 opacity-80"
            />
            <span className="text-xs font-medium tracking-wide text-text-secondary">Grimoire</span>
        </header>
    );
}
