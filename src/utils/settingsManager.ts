import { type IMsTodoSyncSettings } from 'src/gui/msTodoSyncSettingTab';
import type MsTodoSync from 'src/main';

interface ISettingsManager {
    settings: IMsTodoSyncSettings;
    vaultName: string;
    saveSettings (): void;
}

class SettingsManager implements ISettingsManager {
    constructor (private readonly plugin: MsTodoSync) { }

    public get settings () {
        return this.plugin.settings;
    }

    public get vaultName () {
        return this.plugin.app.vault.getName();
    }

    async saveSettings (): Promise<void> {
        // Implementation to save settings
        await this.plugin.saveData(this.plugin.settings);
    }
}

export { type ISettingsManager, SettingsManager };
