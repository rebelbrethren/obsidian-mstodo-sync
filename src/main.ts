import {
  type CachedMetadata, type Editor, EditorPosition, type MarkdownView, Plugin,
} from 'obsidian';
import {TodoApi} from './api/todoApi.js';
import {DEFAULT_SETTINGS, MsTodoSyncSettingTab, type MsTodoSyncSettings} from './gui/msTodoSyncSettingTab.js';
import {
  createTodayTasks, getTaskIdFromLine, postTask, postTaskAndChildren,
} from './command/msTodoCommand.js';
import {t} from './lib/lang.js';
import {log, logging} from './lib/logging.js';

export default class MsTodoSync extends Plugin {
  settings: MsTodoSyncSettings;
  public todoApi: TodoApi;

  // Pulls the meta data for the a page to help with list processing.
  getPageMetadata(path: string): CachedMetadata | undefined {
    return this.app.metadataCache.getCache(path);
  }

  async onload() {
    logging.registerConsoleLogger();

    log('info', `loading plugin "${this.manifest.name}" v${this.manifest.version}`);

    await this.loadSettings();
    // 在右键菜单中注册命令：将选中的文字创建微软待办
    // Register command in the context menu: Create to Do with the selected text
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
              // @ts-ignore Not available in mobile app
              if (!this.app.isMobile && this.settings.todo_OpenUsingApplicationProtocol) {
                window.open(`ms-todo://tasks/id/${taskId}/details`, '_blank');
              } else {
                window.open(`https://to-do.live.com/tasks/id/${taskId}/details`, '_blank');
              }
            }
          });
        });
      }),
    );

    // 注册命令：将选中的文字创建微软待办
    // Register command: Create to Do with the selected text
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
          // @ts-ignore Not available in mobile app
          if (!this.app.isMobile && this.settings.todo_OpenUsingApplicationProtocol) {
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
        // TODO 模板化日期
        await createTodayTasks(this.todoApi, this.settings, editor);
      },
    });

    this.addSettingTab(new MsTodoSyncSettingTab(this));
    this.todoApi = new TodoApi(this.app);

    // Const a = this.app.vault.getAbstractFileByPath('0进行中/00Today/未命名 2.md')
    // if(a) await this.app.vault.append(a,"hello")
    // this.registerInterval(window.setTimeout(() => this.uptimerApi.getTodayActivities(),(window.moment("18:21", "HH:mm") as unknown as number) - (window.moment() as unknown as number)));
    // This creates an icon in the left ribbon.
    // const ribbonIconEl = this.addRibbonIcon('dice', 'Sample Plugin', (evt: MouseEvent) => {
    // });
    // Perform additional things with the ribbon
    // ribbonIconEl.addClass('my-plugin-ribbon-class');

    // console.log(await this.todoApi.getListIdByName("obsidian"))
  }

  async onunload() {
    log('info', `unloading plugin "${this.manifest.name}" v${this.manifest.version}`);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // GetCurrentLinesFromEditor(editor: Editor): Selection {
  // 	log(
  // 		'info',
  // 		`from: ${editor.getCursor('from')}, to: ${editor.getCursor('to')}, anchor: ${editor.getCursor(
  // 			'anchor',
  // 		)}, head: ${editor.getCursor('head')}, general: ${editor.getCursor()}`,
  // 	);

  // 	let start: EditorPosition;
  // 	let end: EditorPosition;
  // 	let lines: number[] = [];
  // 	if (editor.somethingSelected()) {
  // 		start = editor.getCursor('from');
  // 		end = editor.getCursor('to');
  // 		lines = Array.from({ length: end.line + 1 - start.line }, (v, k) => k + start.line);
  // 	} else {
  // 		start = editor.getCursor();
  // 		end = editor.getCursor();
  // 		lines.push(start.line);
  // 	}
  // 	return {
  // 		start,
  // 		end,
  // 		lines,
  // 	};
  // }
}
