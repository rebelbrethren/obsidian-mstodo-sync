import {
    type CachedMetadata, type Editor, EditorPosition, type MarkdownView, Notice, Platform, Plugin,
} from 'obsidian';
import { TodoApi } from './api/todoApi.js';
import { DEFAULT_SETTINGS, MsTodoSyncSettingTab, type IMsTodoSyncSettings } from './gui/msTodoSyncSettingTab.js';
import {
    cleanupCachedTaskIds,
    createTodayTasks, getAllTasksInList, getTask, getTaskDelta, getTaskIdFromLine, postTask, postTaskAndChildren,
} from './command/msTodoCommand.js';
import { t } from './lib/lang.js';
import { log, logging } from './lib/logging.js';
import { SettingsManager } from './utils/settingsManager.js';
import { MicrosoftClientProvider } from './api/microsoftClientProvider.js';

export default class MsTodoSync extends Plugin {
    settings: IMsTodoSyncSettings;
    public todoApi: TodoApi;
    public settingsManager: SettingsManager;
    public microsoftClientProvider: MicrosoftClientProvider;

    // Pulls the meta data for the a page to help with list processing.
    getPageMetadata (path: string): CachedMetadata | undefined {
        return this.app.metadataCache.getCache(path) ?? undefined;
    }

    async onload () {
        logging.registerConsoleLogger();

        log('info', `loading plugin "${this.manifest.name}" v${this.manifest.version}`);

        await this.loadSettings();

        this.registerMenuEditorOptions();

        this.registerCommands();

        this.addSettingTab(new MsTodoSyncSettingTab(this.app, this));

        try {
            this.microsoftClientProvider = new MicrosoftClientProvider(this.app);
            if (this.settings.microsoft_AuthenticationClientId !== '') {
                this.microsoftClientProvider.clientId = this.settings.microsoft_AuthenticationClientId;
            }

            if (this.settings.microsoft_AuthenticationAuthority !== '') {
                this.microsoftClientProvider.authority = this.settings.microsoft_AuthenticationAuthority;
            }

            this.microsoftClientProvider.createPublicClientApplication();
        } catch (error) {
            if (error instanceof Error) {
                const notice = new Notice(error.message);
                log('error', error.message);
                log('error', error.stack ?? 'No stack trace available');
                return;
            }
        }

        this.todoApi = new TodoApi(this.microsoftClientProvider);
        this.settingsManager = new SettingsManager(this);
    }

    async onunload () {
        log('info', `unloading plugin "${this.manifest.name}" v${this.manifest.version}`);
    }

    async loadSettings () {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
    }

    async saveSettings () {
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
    private registerCommands () {
        this.addCommand({
            id: 'only-create-task',
            name: t('CommandName_PushToMsTodo'),
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.pushTaskToMsTodo(editor);
            },
        });

        // 注册命令：将选中的文字创建微软待办并替换
        // Register command: Create and replace the selected text to Microsoft To-Do
        this.addCommand({
            id: 'create-task-replace',
            name: t('CommandName_PushToMsTodoAndReplace'),
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                await this.pushTaskToMsTodoAndUpdatePage(editor);
            },
        });

        // Register command: Open link to ToDo
        this.addCommand({
            id: 'open-task-link',
            name: t('CommandName_OpenToDo'),
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                this.viewTaskInTodo(editor);
            },
        });

        this.addCommand({
            id: 'add-microsoft-todo',
            name: t('CommandName_InsertSummary'),
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
    private registerMenuEditorOptions () {
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle(t('EditorMenu_SyncToTodo')).onClick(
                        async () => {
                            await this.pushTaskToMsTodo(editor);
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
                        async () => {
                            await this.pushTaskToMsTodoAndUpdatePage(editor);
                        },
                    );
                });
            }),
        );

        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                menu.addItem(item => {
                    item.setTitle(t('EditorMenu_FetchFromRemote')).onClick(
                        async () => {
                            await getTask(
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

        if (this.settings.hackingEnabled) {
            this.registerEvent(
                this.app.workspace.on('editor-menu', (menu, editor, view) => {
                    menu.addItem(item => {
                        item.setTitle('hacking').onClick(
                            async () => {
                                await getTaskDelta(
                                    this.todoApi,
                                    this.settings.todoListSync?.listId,
                                    this,
                                );
                            },
                        );
                    });
                }),
            );

            this.registerEvent(
                this.app.workspace.on('editor-menu', (menu, editor, view) => {
                    menu.addItem(item => {
                        item.setTitle('Reset Task Cache').onClick(
                            async () => {
                                await getTaskDelta(
                                    this.todoApi,
                                    this.settings.todoListSync?.listId,
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
                        item.setTitle('Cleanup Local Task Lookup Table').onClick(
                            async () => {
                                await cleanupCachedTaskIds(
                                    this,
                                );
                            },
                        );
                    });
                }),
            );

            this.registerEvent(
                this.app.workspace.on('editor-menu', (menu, editor, view) => {
                    menu.addItem(item => {
                        item.setTitle('Insert all tasks with body').onClick(
                            async () => {
                                await getAllTasksInList(
                                    this.todoApi,
                                    this.settings.todoListSync?.listId,
                                    editor,
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
                        item.setTitle('Insert all tasks').onClick(
                            async () => {
                                await getAllTasksInList(
                                    this.todoApi,
                                    this.settings.todoListSync?.listId,
                                    editor,
                                    this,
                                    false,
                                );
                            },
                        );
                    });
                }),
            );
        }

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
                        this.viewTaskInTodo(editor);
                    });
                });
            }),
        );
    }

    /**
     * Opens the task in Microsoft To Do based on the cursor location in the editor.
     * If the task ID is found in the current line, it will open the task details either
     * using the application protocol (if not on mobile and the setting is enabled) or
     * via the web URL.
     *
     * @param editor - The editor instance where the cursor is located.
     */
    private viewTaskInTodo (editor: Editor) {
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
    }

    /**
     * Pushes a task to Microsoft To-Do and updates the page.
     *
     * This method posts a task to the Microsoft To-Do API using the provided editor instance,
     * the active file's path, and the current settings. After posting the task, it updates
     * the page accordingly.
     *
     * @param editor - The editor instance containing the task to be posted.
     * @returns A promise that resolves when the task has been posted and the page updated.
     */
    private async pushTaskToMsTodoAndUpdatePage (editor: Editor) {
        await postTask(
            this.todoApi,
            this.settings.todoListSync?.listId,
            editor,
            this.app.workspace.getActiveFile()?.path,
            this,
            true,
        );
    }

    /**
     * Pushes a task to Microsoft To-Do.
     *
     * @param editor - The editor instance containing the task to be pushed.
     * @returns A promise that resolves when the task has been successfully pushed.
     */
    private async pushTaskToMsTodo (editor: Editor) {
        await postTask(
            this.todoApi,
            this.settings.todoListSync?.listId,
            editor,
            this.app.workspace.getActiveFile()?.path,
            this,
            false,
        );
    }
}

