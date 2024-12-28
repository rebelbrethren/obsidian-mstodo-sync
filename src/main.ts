import {
    type CachedMetadata, type Editor, EditorPosition, type MarkdownView, Platform, Plugin,
} from 'obsidian';
import {TodoApi} from './api/todoApi.js';
import {DEFAULT_SETTINGS, MsTodoSyncSettingTab, type IMsTodoSyncSettings} from './gui/msTodoSyncSettingTab.js';
import {
    createTodayTasks, getTaskIdFromLine, postTask, postTaskAndChildren,
} from './command/msTodoCommand.js';
import {t} from './lib/lang.js';
import {log, logging} from './lib/logging.js';
import {SettingsManager} from './utils/settingsManager.js';

export default class MsTodoSync extends Plugin {
    settings: IMsTodoSyncSettings;
    public todoApi: TodoApi;
    public settingsManager: SettingsManager;

    // Pulls the meta data for the a page to help with list processing.
    getPageMetadata(path: string): CachedMetadata | undefined {
        return this.app.metadataCache.getCache(path) ?? undefined;
    }

    async onload() {
        logging.registerConsoleLogger();

        log('info', `loading plugin "${this.manifest.name}" v${this.manifest.version}`);

        await this.loadSettings();

        this.registerMenuEditorOptions();

        this.registerCommands();

        this.addSettingTab(new MsTodoSyncSettingTab(this.app, this));

        this.todoApi = new TodoApi(this.app);
        this.settingsManager = new SettingsManager(this);
    }

    async onunload() {
        log('info', `unloading plugin "${this.manifest.name}" v${this.manifest.version}`);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    /**
     * Registers commands for the plugin.
     *
     * This method adds the following commands:
     *
     * - `only-create-task`: Posts the selected text as tasks to Microsoft To-Do.
     * - `create-task-replace`: Posts the selected text as tasks to Microsoft To-Do and replaces the selected text.
     * - `open-task-link`: Opens the link to the task in Microsoft To-Do.
     * - `add-microsoft-todo`: Inserts a summary of today's tasks from Microsoft To-Do.
     *
     * Each command is associated with an `editorCallback` that defines the action to be performed when the command is executed.
     *
     * @private
     */
    private registerCommands() {
        this.addCommand({
            id: 'only-create-task',
            name: 'Post the selection as todos to MsTodo.',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await postTask(
                    this.todoApi,
                    this.settings.todoListSync?.listId,
                    editor,
                    this.app.workspace.getActiveFile()?.path,
                    this,
                );
            },
        });

        // 注册命令：将选中的文字创建微软待办并替换
        // Register command: Create and replace the selected text to Microsoft To-Do
        this.addCommand({
            id: 'create-task-replace',
            name: 'Post the selection as todos to MsTodo and Replace.',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await postTask(
                    this.todoApi,
                    this.settings.todoListSync?.listId,
                    editor,
                    this.app.workspace.getActiveFile()?.path,
                    this,
                    true,
                );
            },
        });

        // Register command: Open link to ToDo
        this.addCommand({
            id: 'open-task-link',
            name: 'Open To Do',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const cursorLocation = editor.getCursor();
                const line = editor.getLine(cursorLocation.line);
                const taskId = getTaskIdFromLine(line, this);
                if (taskId !== '') {
                    if (!Platform.isMobile && this.settings.todo_OpenUsingApplicationProtocol) {
                        window.open(`ms-todo://tasks/id/${taskId}/details`, '_blank');
                    } else {
                        window.open(`https://to-do.live.com/tasks/id/${taskId}/details`, '_blank');
                    }
                }
            },
        });

        this.addCommand({
            id: 'add-microsoft-todo',
            name: 'Insert the MsTodo summary.',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await createTodayTasks(this.todoApi, this.settings, editor);
            },
        });
    }

    /**
     * Registers various options in the editor's context menu.
     *
     * This method adds multiple items to the editor's right-click context menu, each performing different actions related to Microsoft To-Do integration:
     *
     * - Sync selected text to Microsoft To-Do.
     * - Sync and replace selected text with a Microsoft To-Do task.
     * - Sync task with details (Push).
     * - Sync task with details (Pull).
     * - Open Microsoft To-Do task details.
     *
     * Each menu item triggers an asynchronous function to handle the respective action.
     *
     * @private
     */
    private registerMenuEditorOptions() {
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle(t('EditorMenu_SyncToTodo')).onClick(
                        async e => {
                            await postTask(
                                this.todoApi,
                                this.settings.todoListSync?.listId,
                                editor,
                                this.app.workspace.getActiveFile()?.path,
                                this,
                            );
                        },
                    );
                });
            }),
        );

        // 在右键菜单中注册命令：将选中的文字创建微软待办并替换
        // Register command in the context menu: Create and replace the selected text to Microsoft To-Do
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle(t('EditorMenu_SyncToTodoAndReplace')).onClick(
                        async e => {
                            await postTask(
                                this.todoApi,
                                this.settings.todoListSync?.listId,
                                editor,
                                this.app.workspace.getActiveFile()?.path,
                                this,
                                true,
                            );
                        },
                    );
                });
            }),
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle('Sync Task with details (Push)').onClick(async () => {
                        await postTaskAndChildren(
                            this.todoApi,
                            this.settings.todoListSync?.listId,
                            editor,
                            this.app.workspace.getActiveFile()?.path,
                            this,
                            true,
                        );
                    });
                });
            }),
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle('Sync Task with details (Pull)').onClick(
                        async () => {
                            await postTaskAndChildren(
                                this.todoApi,
                                this.settings.todoListSync?.listId,
                                editor,
                                this.app.workspace.getActiveFile()?.path,
                                this,
                                false,
                            );
                        },
                    );
                });
            }),
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle(t('EditorMenu_OpenToDo')).onClick(async () => {
                        const cursorLocation = editor.getCursor();
                        const line = editor.getLine(cursorLocation.line);
                        const taskId = getTaskIdFromLine(line, this);
                        if (taskId !== '') {
                            if (!Platform.isMobile && this.settings.todo_OpenUsingApplicationProtocol) {
                                window.open(`ms-todo://tasks/id/${taskId}/details`, '_blank');
                            } else {
                                window.open(`https://to-do.live.com/tasks/id/${taskId}/details`, '_blank');
                            }
                        }
                    });
                });
            }),
        );
    }
}
