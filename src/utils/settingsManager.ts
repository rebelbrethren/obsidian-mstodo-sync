// Src/utils/settingsManager.ts

import {type IMsTodoSyncSettings} from 'src/gui/msTodoSyncSettingTab';
import type MsTodoSync from 'src/main';

interface ISettingsManager {
    settings: IMsTodoSyncSettings;
    saveSettings(): void;
}

class SettingsManager implements ISettingsManager {
    constructor(private readonly plugin: MsTodoSync) {}

    public get settings() {
        return this.plugin.settings;
    }

    async saveSettings(): Promise<void> {
        // Implementation to save settings
        await this.plugin.saveData(this.plugin.settings);
    }
}

export {type ISettingsManager, SettingsManager};
