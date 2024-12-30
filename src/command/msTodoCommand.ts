/* eslint-disable max-params */
import {type Editor, type EditorPosition, Notice} from 'obsidian';
import {ObsidianTodoTask} from 'src/model/ObsidianTodoTask.js';
import type MsTodoSync from '../main.js';
import {type TodoApi} from '../api/todoApi.js';
import {type IMsTodoSyncSettings} from '../gui/msTodoSyncSettingTab.js';
import {t} from '../lib/lang.js';
import {log, logging} from '../lib/logging.js';

export function getTaskIdFromLine(line: string, plugin: MsTodoSync): string {
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

interface ISelection {
    start: EditorPosition;
    end?: EditorPosition;
    lines: number[];
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
export async function getCurrentLinesFromEditor(editor: Editor): Promise<ISelection> {
    log(
        'info',
        'Getting current lines from editor',
        {
            from: editor.getCursor('from'), to: editor.getCursor('to'), anchor: editor.getCursor('anchor'), head: editor.getCursor('head'), general: editor.getCursor(),
        },
    );

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
        lines = Array.from({length: end.line + 1 - start.line}, (v, k) => k + start.line);
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
export async function postTask(
    todoApi: TodoApi,
    listId: string | undefined,
    editor: Editor,
    fileName: string | undefined,
    plugin: MsTodoSync,
    replace?: boolean,
) {
    const logger = logging.getLogger('mstodo-sync.command.post');

    if (!listId) {
        const notice = new Notice(t('CommandNotice_SetListName'));
        return;
    }

    const activeFile = plugin.app.workspace.getActiveFile();
    if (activeFile === null) {
        return;
    }

    const notice = new Notice(t('CommandNotice_UpdatingToDo'), 3000);

    const source = await plugin.app.vault.read(activeFile);
    const {lines} = await getCurrentLinesFromEditor(editor);

    const split = source.split('\n');
    const modifiedPage = await Promise.all(
        split.map(async (line: string, index: number) => {
            // If the line is not in the selection, return the line as is.
            if (!lines.includes(index)) {
                return line;
            }

            // Create the to do task from the line that is in the selection.
            const todo = new ObsidianTodoTask(plugin.settingsManager, line, fileName ?? '');

            // If there is a block link in the line, we will try to find
            // the task id from the block link and update the task instead.
            // As a user can add a block link, not all tasks will be able to
            // lookup a id from the internal cache.
            if (todo.hasBlockLink && todo.hasId) {
                logger.debug(`Updating Task: ${todo.title}`);

                const returnedTask = await todoApi.updateTaskFromToDo(listId, todo.id, todo.getTodoTask());
                logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`);
                logger.debug(`updated: ${returnedTask.id}`);
            } else {
                logger.debug(`Creating Task: ${todo.title}`);
                logger.debug(`Creating Task: ${listId}`);

                const returnedTask = await todoApi.createTaskFromToDo(listId, todo.getTodoTask());

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

    await plugin.app.vault.modify(activeFile, modifiedPage.join('\n'));
}

// Experimental
// Should handle the following cases:
// - [ ] Task
// - [ ] Task with indented note
//   note
// - [ ] Task with subtasks
//   - [ ] Task One
//   - [ ] Task Two
// - [ ] Task with subtasks and notes
//   Need to think about this one. Perhaps a task 3?
//   - [ ] Task One
//   - [ ] Task Two
// Lines are processed until the next line is blank or not indented by two spaces.
// Also EOF will stop processing.
// Allow variable depth or match column of first [
export async function postTaskAndChildren(
    todoApi: TodoApi,
    listId: string | undefined,
    editor: Editor,
    fileName: string | undefined,
    plugin: MsTodoSync,
    push = true,
) {
    const logger = logging.getLogger('mstodo-sync.command.post');

    if (!listId) {
        const notice = new Notice(t('CommandNotice_SetListName'));
        return;
    }

    const notice = new Notice(t('CommandNotice_CreatingToDo'), 3000);

    const cursorLocation = editor.getCursor();
    const topLevelTask = editor.getLine(cursorLocation.line);
    logger.debug(`topLevelTask: ${topLevelTask}`);
    // Logger.debug(`cursorLocation: ${cursorLocation.line}`, cursorLocation);

    let body = '';
    const childTasks: string[] = [];

    // Get all lines including the line the cursor is on.
    const lines = editor.getValue().split('\n').slice(cursorLocation.line);
    // Logger.debug(`editor: ${cursorLocation}`, lines);

    // Find the end of section which a blank line or a line that is not indented by two spaces.
    const endLine = lines.findIndex(
    // (line, index) => !/[ ]{2,}- \[(.)\]/.test(line) && !line.startsWith('  ') && index > 0,
        (line, index) => line.length === 0 && index > 0,
    );
    logger.debug(`endLine: ${endLine}`);

    // Scan lines below task for sub tasks and body.
    for (const [index, line] of lines.slice(1, endLine).entries()) {
    // Logger.debug(`processing line: ${index} -- ${line}`);

        if (line.startsWith('  - [')) {
            childTasks.push(line.trim());
        } else {
            // Remove the two spaces at the beginning of the line, will be added back on sync.
            // on sync the body will be indented by two spaces and the tasks will be appended at this point.
            body += line.trim() + '\n';
        }
    }

    logger.debug(`body: ${body}`);
    logger.debug(`childTasks: ${childTasks}`, childTasks);

    const todo = new ObsidianTodoTask(plugin.settingsManager, topLevelTask, fileName ?? '');
    todo.setBody(body);
    for (const childTask of childTasks) {
        todo.addChecklistItem(childTask);
    }

    logger.debug(`updated: ${todo.title}`, todo);

    if (todo.hasBlockLink && todo.id) {
        logger.debug(`Updating Task: ${todo.title}`, todo.getTodoTask());

        // Const currentTaskState = await todoApi.getTask(listId, todo.id);
        let returnedTask;
        if (push) {
            returnedTask = await todoApi.updateTaskFromToDo(listId, todo.id, todo.getTodoTask());
            // Push the checklist items...
            todo.checklistItems = returnedTask.checklistItems;
            todo.status = returnedTask.status;
            todo.body = returnedTask.body;
        } else {
            returnedTask = await todoApi.getTask(listId, todo.id);
            if (returnedTask) {
                todo.checklistItems = returnedTask.checklistItems;
                todo.status = returnedTask.status;
                todo.body = returnedTask.body;
            }
        }

        logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`);
        logger.debug(`updated: ${returnedTask?.id}`, returnedTask);
    } else {
        logger.debug(`Creating Task: ${todo.title}`);

        const returnedTask = await todoApi.createTaskFromToDo(listId, todo.getTodoTask(true));

        todo.status = returnedTask.status;
        await todo.cacheTaskId(returnedTask.id ?? '');
        logger.debug(`blockLink: ${todo.blockLink}, taskId: ${todo.id}`, todo);
    }

    // Update the task on the page.
    const start = getLineStartPos(cursorLocation.line);
    const end = getLineEndPos(cursorLocation.line + endLine, editor);

    editor.replaceRange(todo.getMarkdownTask(false), start, end);
}

function getLineStartPos(line: number): EditorPosition {
    return {
        line,
        ch: 0,
    };
}

function getLineEndPos(line: number, editor: Editor): EditorPosition {
    return {
        line,
        ch: editor.getLine(line).length,
    };
}

export async function createTodayTasks(todoApi: TodoApi, settings: IMsTodoSyncSettings, editor?: Editor) {
    const notice = new Notice('获取微软待办中', 3000);
    const now = globalThis.moment();
    const pattern = `status ne 'completed' or completedDateTime/dateTime ge '${now.format('yyyy-MM-DD')}'`;
    const taskLists = await todoApi.getLists(pattern);
    if (!taskLists || taskLists.length === 0) {
        const notice = new Notice('任务列表为空');
        return;
    }

    const segments = taskLists
        .map(taskList => {
            if (!taskList.tasks || taskList.tasks.length === 0) {
                return;
            }

            taskList.tasks.sort((a, b) => (a.status == 'completed' ? 1 : -1));
            const lines = taskList.tasks?.map(task => {
                const formattedCreateDate = globalThis
                    .moment(task.createdDateTime)
                    .format(settings.displayOptions_DateFormat);
                const done = task.status == 'completed' ? 'x' : ' ';
                const createDate
                    = formattedCreateDate == now.format(settings.displayOptions_DateFormat)
                        ? ''
                        : `${settings.displayOptions_TaskCreatedPrefix}[[${formattedCreateDate}]]`;
                const body = task.body?.content ? `${settings.displayOptions_TaskBodyPrefix}${task.body.content}` : '';

                return `- [${done}] ${task.title}  ${createDate}  ${body}`;
            });
            return `**${taskList.displayName}**
${lines?.join('\n')}
`;
        })
        .filter(s => s != undefined)
        .join('\n\n');

    if (editor) {
        editor.replaceSelection(segments);
    } else {
        return segments;
    }
}
