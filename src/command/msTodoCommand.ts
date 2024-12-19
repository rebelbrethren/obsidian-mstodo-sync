import {type Editor, type EditorPosition, Notice} from 'obsidian';
import {ObsidianTodoTask} from 'src/model/ObsidianTodoTask';
import type MsTodoSync from '../main.js';
import {type TodoApi} from '../api/todoApi.js';
import {type MsTodoSyncSettings} from '../gui/msTodoSyncSettingTab.js';
import {t} from '../lib/lang.js';
import {log, logging} from '../lib/logging.js';

export function getTaskIdFromLine(line: string, plugin: MsTodoSync): string {
  const regex = /\^(?!.*\^)([A-Za-z\d]+)/gm;
  const blocklistMatch = regex.exec(line.trim());
  if (blocklistMatch) {
    const blocklink = blocklistMatch[1];
    const taskId = plugin.settings.taskIdLookup[blocklink];
    console.log(taskId);
    return taskId;
  }

  return '';
}

type Selection = {
  start: EditorPosition;
  end?: EditorPosition;
  lines: number[];
};

export async function getCurrentLinesFromEditor(editor: Editor): Promise<Selection> {
  log(
    'info',
    `from: ${editor.getCursor('from')}, to: ${editor.getCursor('to')}, anchor: ${editor.getCursor(
      'anchor',
    )}, head: ${editor.getCursor('head')}, general: ${editor.getCursor()}`,
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

export async function postTask(
  todoApi: TodoApi,
  listId: string | undefined,
  editor: Editor,
  fileName: string | undefined,
  plugin: MsTodoSync,
  replace?: boolean,
) {
  const logger = logging.getLogger('mstodo-sync.command.post');

  // If (!editor.somethingSelected()) {
  // 	new Notice(t('CommandNotice_NothingSelected'));
  // 	return;
  // }
  if (!listId) {
    new Notice(t('CommandNotice_SetListName'));
    return;
  }

  new Notice(t('CommandNotice_CreatingToDo'), 3000);
  // Const formatted = editor
  // 	.getSelection()
  // 	.replace(/\*|^> |^#* |- /gm, '')
  // 	// .replace(/(- \[( |x|\/)\] )|\*|^> |^#* |- /gm, '')
  // 	.split('\n')
  // 	.filter((s) => s != '');
  const activeFile = this.app.workspace.getActiveFile();
  const source = await this.app.vault.read(activeFile);
  const {lines} = await getCurrentLinesFromEditor(editor);

  const split = source.split('\n');
  const modifiedPage = await Promise.all(
    split.map(async (line: string, index: number) => {
      if (!lines.includes(index)) {
        return line;
      }

      const todo = new ObsidianTodoTask(plugin, line, fileName ?? '');

      // If there is a block link in the line, we will try to find
      // the task id from the block link and update the task instead.
      if (todo.hasBlockLink && todo.id) {
        logger.debug(`Updating Task: ${todo.title}`);

        const returnedTask = await todoApi.updateTaskFromToDo(listId, todo.id, todo.getTodoTask());
        logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`);
        logger.debug(`updated: ${returnedTask.id}`);
      } else {
        logger.debug(`Creating Task: ${todo.title}`);
        logger.debug(`Creating Task: ${listId}`);

        const returnedTask = await todoApi.createTaskFromToDo(listId, todo.getTodoTask());

        todo.status = returnedTask.status;
        todo.cacheTaskId(returnedTask.id ?? '');
        logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`, todo);
      }

      if (replace) {
        return todo.getMarkdownTask(true);
      }

      return line;
    }),
  );

  await this.app.vault.modify(activeFile, modifiedPage.join('\n'));

  // Return split.join('\n');

  // log('debug', formatted.join(' :: '));
  // Promise.all(
  // 	formatted.map(async (s) => {
  // 		const todo = new ObsidianTodoTask(plugin, s, fileName ?? '');

  // 		// If there is a block link in the line, we will try to find
  // 		// the task id from the block link and update the task instead.
  // 		if (todo.hasBlockLink && todo.id) {
  // 			logger.debug(`Updating Task: ${todo.title}`);

  // 			const returnedTask = await todoApi.updateTaskFromToDo(listId, todo.id, todo.getTodoTask());
  // 			logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`);
  // 			logger.debug(`updated: ${returnedTask.id}`);
  // 		} else {
  // 			logger.debug(`Creating Task: ${todo.title}`);

  // 			const returnedTask = await todoApi.createTaskFromToDo(listId, todo.getTodoTask());

  // 			todo.status = returnedTask.status;
  // 			todo.cacheTaskId(returnedTask.id ?? '');
  // 			logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`, todo);
  // 		}

  // 		return todo;
  // 	}),
  // ).then((res) => {
  // 	new Notice('创建待办成功√');
  // 	if (replace) {
  // 		editor.replaceSelection(
  // 			res
  // 				.map((i) => {
  // 					logger.debug('Processed blockLink', i.blockLink);
  // 					return i.getMarkdownTask();
  // 				})
  // 				.join('\n'),
  // 		);
  // 	}
  // });
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
// TODO:
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
    new Notice(t('CommandNotice_SetListName'));
    return;
  }

  new Notice(t('CommandNotice_CreatingToDo'), 3000);

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

  const todo = new ObsidianTodoTask(plugin, topLevelTask, fileName ?? '');
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
      // TODO Push the checklist items...
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

    logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`);
    logger.debug(`updated: ${returnedTask?.id}`, returnedTask);
  } else {
    logger.debug(`Creating Task: ${todo.title}`);

    const returnedTask = await todoApi.createTaskFromToDo(listId, todo.getTodoTask(true));

    todo.status = returnedTask.status;
    todo.cacheTaskId(returnedTask.id ?? '');
    logger.debug(`blocklink: ${todo.blockLink}, taskId: ${todo.id}`, todo);
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

export async function createTodayTasks(todoApi: TodoApi, settings: MsTodoSyncSettings, editor?: Editor) {
  new Notice('获取微软待办中', 3000);
  const now = globalThis.moment();
  const pattern = `status ne 'completed' or completedDateTime/dateTime ge '${now.format('yyyy-MM-DD')}'`;
  const taskLists = await todoApi.getLists(pattern);
  if (!taskLists || taskLists.length === 0) {
    new Notice('任务列表为空');
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

  new Notice('待办列表已获取');
  if (editor) {
    editor.replaceSelection(segments);
  } else {
    return segments;
  }
}
