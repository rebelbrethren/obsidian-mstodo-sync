/* eslint-disable unicorn/filename-case */

/* eslint-disable @typescript-eslint/naming-convention */

import _ from 'obsidian';

declare module 'obsidian' {
    interface MetadataCache {
        metadataCache: Record<string, CachedMetadata>;
    }

    interface App {
        appId: string;
        plugins: {
            enabledPlugins: Set<string>;
        };
    }

    interface View {
        tree: {
            toggleCollapseAll: () => void;
            setCollapseAll: (collapse: boolean) => void;
            isAllCollapsed: boolean;
        };
        toggleCollapseAll: () => void;
        setCollapseAll: (collapse: boolean) => void;
        isAllCollapsed: boolean;
        collapseOrExpandAllEl: HTMLDivElement;
    }

}

