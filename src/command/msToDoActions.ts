import { type BlockCache, type DataAdapter, type Editor, type EditorPosition, Platform } from 'obsidian';
import { type SettingsManager } from '../utils/settingsManager.js';
import type MsTodoSync from '../main.js';
import { type IMsTodoSyncSettings } from '../gui/msTodoSyncSettingTab.js';
import { UserNotice } from '../lib/userNotice.js';
import { logging } from '../lib/logging.js';
import { TodoTask } from '@microsoft/microsoft-graph-types';
import { TasksDeltaCollection, TodoApi } from '../api/todoApi.js';
import { t } from '../lib/lang.js';
import { ObsidianTodoTask } from '../model/obsidianTodoTask.js';
import { DateTime } from 'luxon';

interface ISelection {
    start: EditorPosition;
    end?: EditorPosition;
    lines: number[];
}

export class MsTodoActions {
    private userNotice = new UserNotice();
    private readonly logger = logging.getLogger('mstodo-sync.MsTodoActions');
    private settings: IMsTodoSyncSettings;
    private todoApi: TodoApi;
    private plugin: MsTodoSync;

    constructor(
        plugin: MsTodoSync,
        private settingsManager: SettingsManager,
        todoApi: TodoApi,
    ) {
        this.settings = settingsManager.settings;
        this.plugin = plugin;
        this.todoApi = todoApi;
    }

    /**
     * This will get all the task updates from Microsoft To Do, then get all the block references
     * that exist in the vault. It will then use the cache to update all the block references.
     * To ensure that the sync does not over write the following logic will be used.
     * If the modified time on the page is more recent than the remote task then the remote task will be updated.
     * If the remote task is more recent than the page then the local task will be updated.
     * If the remote task properties and the local task properties are the same then no update will occur.
     * If a local task is on one ore more pages then the most recently modified page will be
     * classed as the source of truth.
     */
    public async syncVault(listId: string | undefined) {
        // Get all the blocks in the vault.
        const blockCache = this.getAllVaultBlocks();

        this.logger.info(`Blocks found in vault: ${Object.keys(blockCache).length}`);

        // Get the local task that is most recent in the case there are duplicate IDs in the vault.
        // The key is in the format of cacheKey-blockId. So need to pull the blockId from the key.
        const localTasks: Record<string, { mtime: number; pageHash: string; pagePath: string; block: BlockCache }> = {};
        for (const key in blockCache) {
            if (Object.hasOwn(blockCache, key)) {
                const internalPageHash = key.split('-')[0];
                const blockId = key.split('-')[1];
                // Get the mtime.
                const mtime = blockCache[key].mtime;
                // If the localTasks contains the block id as key, check the value
                // and update if the mtime is more recent.
                if (localTasks[blockId] && localTasks[blockId].mtime < mtime) {
                    localTasks[blockId] = {
                        mtime,
                        pageHash: internalPageHash,
                        pagePath: blockCache[key].pagePath,
                        block: blockCache[key].block,
                    };
                } else {
                    localTasks[blockId] = {
                        mtime,
                        pageHash: internalPageHash,
                        pagePath: blockCache[key].pagePath,
                        block: blockCache[key].block,
                    };
                }
            }
        }

        this.logger.info(`Local Tasks: ${Object.keys(localTasks).length}`);

        // Get all the tasks from the cache.
        await this.getTaskDelta(listId, false);
        const cachedTasksDelta = await this.getDeltaCache();

        // If there are no tasks in the cache then return.
        if (!cachedTasksDelta) {
            return;
        }

        this.logger.info(`Remote Tasks: ${cachedTasksDelta.allTasks.length}`);
        this.logger.info(`Lookups in settings: ${Object.keys(this.plugin.settings.taskIdLookup).length}`);

        // Iterate over all the tasks in internal cache and update the block references.
        let updatedTasks = 0;
        for (const blockId in this.plugin.settings.taskIdLookup) {
            const taskId = this.settingsManager.getTaskIdFromBlockId(blockId);
            const cachedTask = cachedTasksDelta.allTasks.find((task) => task.id === taskId);
            const localTask = localTasks[blockId.toLowerCase()];
            if (cachedTask && localTask && cachedTask.lastModifiedDateTime) {
                // If the local task is more recent than the remote task then update the remote task.
                if (new Date(cachedTask.lastModifiedDateTime) < new Date(localTask.mtime)) {
                    // Update the remote task with the local task.
                    // Get the string from the page using the start and end provided by the block.
                    const block = blockCache[`${localTasks[blockId.toLowerCase()].pageHash}-${blockId.toLowerCase()}`];
                    if (block) {
                        const adapter: DataAdapter = this.plugin.app.vault.adapter;
                        const pageContent = await adapter.read(localTask.pagePath);
                        const taskContent = pageContent.slice(
                            localTask.block.position.start.offset,
                            localTask.block.position.end.offset,
                        );

                        const internalTask = new ObsidianTodoTask(this.settingsManager, taskContent);

                        const titleMatch = internalTask.title === cachedTask.title;
                        const statusMatch = internalTask.status === cachedTask.status;
                        const localDueDate =
                            internalTask.dueDateTime === undefined
                                ? undefined
                                : DateTime.fromISO(internalTask.dueDateTime?.dateTime ?? '', {
                                      zone: internalTask.dueDateTime?.timeZone ?? 'utc',
                                  });
                        const remoteDueDate =
                            cachedTask.dueDateTime === undefined
                                ? undefined
                                : DateTime.fromISO(cachedTask.dueDateTime?.dateTime ?? '', {
                                      zone: cachedTask.dueDateTime?.timeZone ?? 'utc',
                                  });
                        const dueDateTimeMatch = localDueDate?.toISODate() === remoteDueDate?.toISODate();
                        const importanceMatch = internalTask.importance === cachedTask.importance;

                        if (!titleMatch || !statusMatch || !dueDateTimeMatch || !importanceMatch) {
                            this.logger.info(`Local Newer: ${blockId}`, { cachedTask, localTask, taskContent });
                            this.logger.info(`Updating Task: ${blockId}`, {
                                titleMatch,
                                statusMatch,
                                dueDateTimeMatch,
                                importanceMatch,
                            });
                            if (!dueDateTimeMatch) {
                                this.logger.info(`Local Due Date: ${localDueDate?.toISODate()}`);
                                this.logger.info(`Remote Due Date: ${remoteDueDate?.toISODate()}`);
                            }

                            const returnedTask = await this.todoApi.updateTaskFromToDo(
                                listId,
                                internalTask.id,
                                internalTask.getTodoTask(),
                            );
                            this.logger.info(`Updated Task last mod: ${returnedTask.lastModifiedDateTime}`);

                            updatedTasks++;
                        }
                    } else {
                        this.logger.info(`Block not found in vault: ${blockId}`);
                    }
                } else {
                    const block = blockCache[`${localTasks[blockId.toLowerCase()].pageHash}-${blockId.toLowerCase()}`];
                    if (block) {
                        const vaultFileReference = this.plugin.app.vault.getFileByPath(localTask.pagePath);
                        if (vaultFileReference) {
                            this.plugin.app.vault.read(vaultFileReference);
                            const pageContent = await this.plugin.app.vault.read(vaultFileReference);
                            const taskContent = pageContent.slice(
                                localTask.block.position.start.offset,
                                localTask.block.position.end.offset,
                            );

                            const internalTask = new ObsidianTodoTask(this.settingsManager, taskContent);

                            const titleMatch = internalTask.title === cachedTask.title;
                            const statusMatch = internalTask.status === cachedTask.status;
                            const localDueDate =
                                internalTask.dueDateTime === undefined
                                    ? undefined
                                    : DateTime.fromISO(internalTask.dueDateTime?.dateTime ?? '', {
                                          zone: internalTask.dueDateTime?.timeZone ?? 'utc',
                                      });
                            const remoteDueDate =
                                cachedTask.dueDateTime === undefined
                                    ? undefined
                                    : DateTime.fromISO(cachedTask.dueDateTime?.dateTime ?? '', {
                                          zone: cachedTask.dueDateTime?.timeZone ?? 'utc',
                                      });
                            const dueDateTimeMatch = localDueDate?.toISODate() === remoteDueDate?.toISODate();
                            const importanceMatch = internalTask.importance === cachedTask.importance;

                            if (!titleMatch || !statusMatch || !dueDateTimeMatch || !importanceMatch) {
                                this.logger.info(`Remote Newer: ${blockId}`, { cachedTask, localTask, taskContent });
                                this.logger.info(`Updating Task: ${blockId}`, {
                                    titleMatch,
                                    statusMatch,
                                    dueDateTimeMatch,
                                    importanceMatch,
                                });
                                if (!dueDateTimeMatch) {
                                    this.logger.info(`Local Due Date: ${localDueDate?.toISODate()}`);
                                    this.logger.info(`Remote Due Date: ${remoteDueDate?.toISODate()}`);
                                }

                                internalTask.updateFromTodoTask(cachedTask);
                                const updatedTask = internalTask.getMarkdownTask(true);

                                await this.plugin.app.vault.process(vaultFileReference, (data) => {
                                    const newPageContent =
                                        data.substring(0, localTask.block.position.start.offset) +
                                        updatedTask +
                                        data.substring(localTask.block.position.end.offset);
                                    this.logger.info(`Updating Task ID: ${blockId}`, newPageContent);
                                    return newPageContent;
                                });
                                updatedTasks++;
                            }
                        }
                    } else {
                        this.logger.info(`Block not found in vault: ${blockId}`);
                    }
                }
            } else {
                this.logger.info(`Task not found in remote cache: ${blockId}`);
            }

            // if (Object.hasOwn(this.plugin.settings.taskIdLookup, blockId)) {
            //     const taskId = this.plugin.settings.taskIdLookup[blockId];
            //     const cachedTask = cachedTasksDelta.allTasks.find(task => task.id === taskId);
            //     const localTask = localTasks[blockId.toLowerCase()];
            //     if (cachedTask && localTask && cachedTask.lastModifiedDateTime) {
            //         // If the local task is more recent than the remote task then update the remote task.
            //         if (new Date(cachedTask.lastModifiedDateTime) < new Date(localTask.mtime)) {
            //             // Update the remote task with the local task.
            //             // Get the string from the page using the start and end provided by the block.
            //             const block = blockCache[`${localTasks[blockId.toLowerCase()].pageHash}-${blockId.toLowerCase()}`];
            //             if (block) {
            //                 const adapter: DataAdapter = this.plugin.app.vault.adapter;
            //                 const pageContent = await adapter.read(localTask.pagePath)
            //                 const taskContent = pageContent.slice(localTask.block.position.start.offset, localTask.block.position.end.offset)

            //                 this.logger.info(`Updating Task ID: ${cachedTask.id}`);
            //                 this.logger.info(`Updating Task Path: ${localTask.pagePath}`);
            //                 this.logger.info(`Updating Task Local Task On Page: ${taskContent}`);
            //                 this.logger.info(`Updating Task Remote Task: ${cachedTask.title}`);
            //                 this.logger.info(`Updating Task Remote mtime: ${new Date(cachedTask.lastModifiedDateTime)}`);
            //                 this.logger.info(`Updating Task Local mtime: ${new Date(localTask.mtime)}`);
            //                 updatedTasks++;

            //             } else {
            //                 this.logger.info(`Block not found in vault: ${blockId}`);
            //             }
            //         } else {
            //             this.logger.info(`Local task is more recent than remote task: ${blockId}`);
            //         }
            //     } else {
            //         this.logger.info(`Task not found in remote cache: ${blockId}`);
            //     }
            // }
        }

        this.logger.info(`Updated Tasks: ${updatedTasks}`);
    }

    /**
     * Opens the task in Microsoft To Do based on the cursor location in the editor.
     * If the task ID is found in the current line, it will open the task details either
     * using the application protocol (if not on mobile and the setting is enabled) or
     * via the web URL.
     *
     * @param editor - The editor instance where the cursor is located.
     */
    public viewTaskInTodo(editor: Editor) {
        const cursorLocation = editor.getCursor();
        const line = editor.getLine(cursorLocation.line);
        const taskId = this.getTaskIdFromLine(line, this.plugin);
        if (taskId !== '') {
            if (!Platform.isMobile && this.settings.todo_OpenUsingApplicationProtocol) {
                window.open(`ms-todo://tasks/id/${taskId}/details`, '_blank');
            } else {
                window.open(`https://to-do.live.com/tasks/id/${taskId}/details`, '_blank');
            }
        }
    }

    public async cleanupCachedTaskIds() {
        // Collect all the blocks and ids from the metadata cache under the app.
        const blockCache: Record<string, BlockCache> = this.populateBlockCache();

        // Iterate over all the internal cached task ids in settings. If the block is not found in the metadata cache
        // we will log it. The cache is a metadata hash and block id as block ids can be reused across pages.
        for (const blockId in this.settings.taskIdLookup) {
            if (Object.hasOwn(this.settings.taskIdLookup, blockId)) {
                // Check if the block is in the metadata cache.
                let found = false;
                let block;
                for (const key in blockCache) {
                    if (key.includes(blockId.toLowerCase())) {
                        found = true;
                        block = blockCache[key];
                    }
                }

                if (found) {
                    this.logger.info(`Block found in metadata cache: ${blockId}`, block);
                } else {
                    this.logger.info(`Block not found in metadata cache: ${blockId}`);
                    // Clean up the block id from the settings.
                    delete this.settings.taskIdLookup[blockId];
                    await this.settingsManager.saveSettings();
                }
            }
        }

        this.logger.info('blockCache', blockCache);
    }

    /**
     * This will find all block references across all files.
     *
     * @param {MsTodoSync} plugin
     * @return {*}  {Record<string, BlockCache>}
     */
    private populateBlockCache(): Record<string, BlockCache> {
        const blockCache: Record<string, BlockCache> = {};
        const internalMetadataCache = this.plugin.app.metadataCache.metadataCache;
        for (const cacheKey in internalMetadataCache) {
            if (Object.hasOwn(internalMetadataCache, cacheKey) && internalMetadataCache[cacheKey].blocks) {
                const blocksCache = internalMetadataCache[cacheKey].blocks;
                for (const blockKey in blocksCache) {
                    if (Object.hasOwn(internalMetadataCache, cacheKey)) {
                        const block = blocksCache[blockKey];
                        blockCache[`${cacheKey}-${blockKey}`] = block;
                    }
                }
            }
        }

        return blockCache;
    }

    private getAllVaultBlocks(): Record<
        string,
        { mtime: number; pageHash: string; pagePath: string; block: BlockCache }
    > {
        const blockCache: Record<string, { mtime: number; pageHash: string; pagePath: string; block: BlockCache }> = {};
        const internalMetadataCache = this.plugin.app.metadataCache.metadataCache;
        for (const cacheKey in internalMetadataCache) {
            if (Object.hasOwn(internalMetadataCache, cacheKey) && internalMetadataCache[cacheKey].blocks) {
                const blocksCache = internalMetadataCache[cacheKey].blocks;
                const file = this.findBySubProperty(this.plugin.app.metadataCache.fileCache, 'hash', cacheKey);
                for (const blockKey in blocksCache) {
                    if (Object.hasOwn(internalMetadataCache, cacheKey)) {
                        const block = blocksCache[blockKey.toLowerCase()];
                        blockCache[`${cacheKey}-${blockKey.toLowerCase()}`] = {
                            mtime: file?.value.mtime ?? 0,
                            pageHash: cacheKey,
                            pagePath: file?.key ?? '',
                            block,
                        };
                    }
                }
            }
        }

        return blockCache;
    }

    // Function to find the key and value by a sub-property of the value
    private findBySubProperty<T extends Record<string, any>, K extends keyof T[keyof T]>(
        record: T,
        subProperty: K,
        value: T[keyof T][K],
    ): { key: string; value: T[keyof T] } | undefined {
        const entry = Object.entries(record).find(([_, v]) => v[subProperty] === value);
        return entry ? { key: entry[0], value: entry[1] } : undefined;
    }

    /**
     * Posts tasks to Microsoft To Do from the selected lines in the editor.
     *
     * @param todoApi - The TodoApi instance used to interact with Microsoft To Do.
     * @param listId - The ID of the list where the tasks will be posted. If undefined, a notice will be shown to set the list name.
     * @param editor - The editor instance from which the tasks will be extracted.
     * @param fileName - The name of the file being edited. If undefined, an empty string will be used.
     * @param plugin - The MsTodoSync plugin instance.
     * @param replace - Optional. If true, the original tasks in the editor will be replaced with the new tasks. Defaults to false.
     *
     * @returns A promise that resolves when the tasks have been posted and the file has been modified.
     */
    public async postTask(listId: string | undefined, editor: Editor, fileName: string | undefined, replace?: boolean) {
        const logger = logging.getLogger('mstodo-sync.command.post');

        if (!listId) {
            this.userNotice.showMessage(t('CommandNotice_SetListName'));
            return;
        }

        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile === null) {
            return;
        }

        this.userNotice.showMessage(t('CommandNotice_CreatingToDo'), 3000);

        const source = await this.plugin.app.vault.read(activeFile);
        const { lines } = await this.getCurrentLinesFromEditor(editor);

        // Single call to update the cache using the delta link.
        await this.getTaskDelta(listId);

        const split = source.split('\n');
        const modifiedPage = await Promise.all(
            split.map(async (line: string, index: number) => {
                // If the line is not in the selection, return the line as is.
                if (!lines.includes(index)) {
                    return line;
                }

                // Create the to do task from the line that is in the selection.
                const todo = new ObsidianTodoTask(this.settingsManager, line);

                // If there is a block link in the line, we will try to find
                // the task id from the block link and update the task instead.
                // As a user can add a block link, not all tasks will be able to
                // lookup a id from the internal cache.
                if (todo.hasBlockLink && todo.hasId) {
                    logger.debug(`Updating Task: ${todo.title}`);

                    // Check for linked resource and update if there otherwise create.
                    const cachedTasksDelta = await this.getDeltaCache();
                    const cachedTask = cachedTasksDelta?.allTasks.find((task) => task.id === todo.id);

                    const titleMatch = todo.title === cachedTask?.title;
                    const statusMatch = todo.status === cachedTask?.status;
                    const localDueDate =
                        todo.dueDateTime === undefined
                            ? undefined
                            : DateTime.fromISO(todo.dueDateTime?.dateTime ?? '', {
                                  zone: todo.dueDateTime?.timeZone ?? 'utc',
                              });
                    const remoteDueDate =
                        cachedTask?.dueDateTime === undefined
                            ? undefined
                            : DateTime.fromISO(cachedTask?.dueDateTime?.dateTime ?? '', {
                                  zone: cachedTask.dueDateTime?.timeZone ?? 'utc',
                              });
                    const dueDateTimeMatch = localDueDate?.toISODate() === remoteDueDate?.toISODate();
                    const importanceMatch = todo.importance === cachedTask?.importance;

                    if (cachedTask && (!titleMatch || !statusMatch || !dueDateTimeMatch || !importanceMatch)) {
                        const linkedResource = cachedTask.linkedResources?.first();
                        if (linkedResource && linkedResource.id) {
                            await this.todoApi.updateLinkedResource(
                                listId,
                                todo.id,
                                linkedResource.id,
                                todo.blockLink ?? '',
                                todo.getRedirectUrl(),
                            );
                        } else {
                            await this.todoApi.createLinkedResource(
                                listId,
                                todo.id,
                                todo.blockLink ?? '',
                                todo.getRedirectUrl(),
                            );
                        }
                    }

                    todo.linkedResources = cachedTask?.linkedResources;

                    // Only update if there is a need.
                    if (!titleMatch || !statusMatch || !dueDateTimeMatch || !importanceMatch) {
                        const returnedTask = await this.todoApi.updateTaskFromToDo(listId, todo.id, todo.getTodoTask());
                        logger.debug(`updated: ${returnedTask.id}`);
                    }
                    logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`);
                } else {
                    logger.debug(`Creating Task: ${todo.title}`);
                    logger.debug(`Creating Task: ${listId}`);

                    const returnedTask = await this.todoApi.createTaskFromToDo(listId, todo.getTodoTask());

                    todo.status = returnedTask.status;
                    await todo.cacheTaskId(returnedTask.id ?? '');
                    logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`, todo);
                }

                // If false there will be a orphaned block id for this task.
                if (replace) {
                    return todo.getMarkdownTask(true);
                }

                return line;
            }),
        );

        await this.plugin.app.vault.modify(activeFile, modifiedPage.join('\n'));
    }

    public async getTask(listId: string | undefined, editor: Editor) {
        const logger = logging.getLogger('mstodo-sync.command.get');

        if (!listId) {
            this.userNotice.showMessage(t('CommandNotice_SetListName'));
            return;
        }

        const activeFile = this.plugin.app.workspace.getActiveFile();
        if (activeFile === null) {
            return;
        }

        this.userNotice.showMessage(t('CommandNotice_GettingToDo'), 3000);

        const source = await this.plugin.app.vault.read(activeFile);
        const { lines } = await this.getCurrentLinesFromEditor(editor);

        // Single call to update the cache using the delta link.
        await this.getTaskDelta(listId);

        const split = source.split('\n');
        const modifiedPage = await Promise.all(
            split.map(async (line: string, index: number) => {
                // If the line is not in the selection, return the line as is.
                if (!lines.includes(index)) {
                    return line;
                }

                // Create the to do task from the line that is in the selection.
                const todo = new ObsidianTodoTask(this.plugin.settingsManager, line);

                // If there is a block link in the line, we will try to find
                // the task id from the block link and update the task instead.
                // As a user can add a block link, not all tasks will be able to
                // lookup a id from the internal cache.
                if (todo.hasBlockLink && todo.hasId) {
                    logger.debug(`Updating Task: ${todo.title}`);

                    // Load from the delta cache file and pull the task from the cache.
                    const cachedTasksDelta = await this.getDeltaCache();
                    const returnedTask = cachedTasksDelta?.allTasks.find((task) => task.id === todo.id);

                    if (returnedTask) {
                        todo.updateFromTodoTask(returnedTask);
                        logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`);
                        logger.debug(`updated: ${returnedTask.id}`);
                    }

                    return todo.getMarkdownTask(true);
                }

                return line;
            }),
        );

        await this.plugin.app.vault.modify(activeFile, modifiedPage.join('\n'));
    }

    private async getDeltaCache() {
        const cachePath = `${this.plugin.app.vault.configDir}/mstd-tasks-delta.json`;
        const adapter: DataAdapter = this.plugin.app.vault.adapter;
        let cachedTasksDelta: TasksDeltaCollection | undefined;

        if (await adapter.exists(cachePath)) {
            cachedTasksDelta = JSON.parse(await adapter.read(cachePath)) as TasksDeltaCollection;
        }

        return cachedTasksDelta;
    }

    private async getTaskDelta(listId: string | undefined, reset = false) {
        const logger = logging.getLogger('mstodo-sync.command.delta');

        if (!listId) {
            this.userNotice.showMessage(t('CommandNotice_SetListName'));
            return;
        }

        const cachePath = `${this.plugin.app.vault.configDir}/mstd-tasks-delta.json`;
        const adapter: DataAdapter = this.plugin.app.vault.adapter;
        if (reset) {
            await adapter.remove(cachePath);
        }

        let deltaLink = '';
        let cachedTasksDelta = await this.getDeltaCache();

        if (cachedTasksDelta) {
            deltaLink = cachedTasksDelta.deltaLink;
        } else {
            cachedTasksDelta = new TasksDeltaCollection([], '');
        }

        const returnedTask = await this.todoApi.getTasksDelta(listId, deltaLink);
        logger.info('deltaLink', deltaLink);
        logger.info('ReturnedDelta', returnedTask);

        if (cachedTasksDelta) {
            logger.info('cachedTasksDelta.allTasks', cachedTasksDelta.allTasks.length);
            logger.info('returnedTask.allTasks', returnedTask.allTasks.length);

            cachedTasksDelta.allTasks = this.mergeCollections(cachedTasksDelta.allTasks, returnedTask.allTasks);
            logger.info('cachedTasksDelta.allTasks', cachedTasksDelta.allTasks.length);

            cachedTasksDelta.deltaLink = returnedTask.deltaLink;
        } else {
            logger.info('First run, loading delta cache');

            cachedTasksDelta = returnedTask;
        }

        await adapter.write(cachePath, JSON.stringify(cachedTasksDelta));
    }

    // Function to merge collections
    private mergeCollections(col1: TodoTask[], col2: TodoTask[]): TodoTask[] {
        const map = new Map<string, TodoTask>();

        // Helper function to add items to the map
        function addToMap(item: TodoTask) {
            if (item.id && item.lastModifiedDateTime) {
                const existingItem = map.get(item.id);
                // If there is no last modified then just use the current item.
                if (
                    !existingItem ||
                    new Date(item.lastModifiedDateTime) > new Date(existingItem.lastModifiedDateTime ?? 0)
                ) {
                    map.set(item.id, item);
                }
            }
        }

        // Add items from both collections to the map
        for (const item of col1) {
            addToMap(item);
        }

        for (const item of col2) {
            addToMap(item);
        }

        // Convert map values back to an array
        return Array.from(map.values());
    }

    /**
     * Retrieves the current lines from the editor based on the cursor position or selection.
     *
     * @param editor - The editor instance from which to get the current lines.
     * @returns A promise that resolves to a Selection object containing:
     * - `start`: The starting position of the cursor or selection.
     * - `end`: The ending position of the cursor or selection.
     * - `lines`: An array of line numbers that are currently selected or where the cursor is located.
     */
    private async getCurrentLinesFromEditor(editor: Editor): Promise<ISelection> {
        this.logger.info('Getting current lines from editor', {
            from: editor.getCursor('from'),
            to: editor.getCursor('to'),
            anchor: editor.getCursor('anchor'),
            head: editor.getCursor('head'),
            general: editor.getCursor(),
        });

        // Const activeFile = this.app.workspace.getActiveFile();
        // const source = await this.app.vault.read(activeFile);

        let start: EditorPosition;
        let end: EditorPosition;
        // Let lines: string[] = [];
        let lines: number[] = [];
        if (editor.somethingSelected()) {
            start = editor.getCursor('from');
            end = editor.getCursor('to');
            // Lines = source.split('\n').slice(start.line, end.line + 1);
            lines = Array.from({ length: end.line + 1 - start.line }, (v, k) => k + start.line);
        } else {
            start = editor.getCursor();
            end = editor.getCursor();
            // Lines = source.split('\n').slice(start.line, end.line + 1);
            lines.push(start.line);
        }

        return {
            start,
            end,
            lines,
        };
    }

    private getTaskIdFromLine(line: string, plugin: MsTodoSync): string {
        const regex = /\^(?!.*\^)([A-Za-z\d]+)/gm;
        const blocklistMatch = regex.exec(line.trim());
        if (blocklistMatch) {
            const blockLink = blocklistMatch[1];
            const taskId = plugin.settings.taskIdLookup[blockLink];
            console.log(taskId);
            return taskId;
        }

        return '';
    }
}
