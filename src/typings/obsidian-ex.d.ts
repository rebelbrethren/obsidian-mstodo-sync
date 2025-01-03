import _ from 'obsidian';

declare module 'obsidian' {
    interface MetadataCache {
        metadataCache: Record<string, CachedMetadata>;
    }

    interface App {
        appId: string;
        plugins: {
            enabledPlugins: Set<string>;
            plugins: {
                [pluginId: string]: Plugin | PeriodicNotes;
            }
        };
    }

    // Extending for known plugin integration so there is type safety.
    interface PeriodicNotes {
        settings: {
            daily: {
                enabled: boolean;
                folder: string;
                format: string;
                template: string;
            };
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

