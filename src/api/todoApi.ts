import {type Client} from '@microsoft/microsoft-graph-client';
import {type TodoTask, type TodoTaskList} from '@microsoft/microsoft-graph-types';
import {type App, Notice} from 'obsidian';
import {t} from '../lib/lang.js';
import {log, logging} from '../lib/logging.js';
import {MicrosoftClientProvider} from './microsoftClientProvider.js';

export class TodoApi {
  private readonly logger = logging.getLogger('mstodo-sync.TodoApi');

  private client: Client;

  constructor(app: App) {
    new MicrosoftClientProvider(app).getClient().then(client => {
      this.client = client;
    }).catch(() => {
      const notice = new Notice(t('Notice_UnableToAcquireClient'));
    });
  }

  // List operation
  async getLists(searchPattern?: string): Promise<TodoTaskList[] | undefined> {
    const endpoint = '/me/todo/lists';
    const todoLists = (await this.client.api(endpoint).get()).value as TodoTaskList[];
    return Promise.all(
      todoLists.map(async taskList => {
        const containedTasks = await this.getListTasks(taskList.id, searchPattern);
        return {
          ...taskList,
          tasks: containedTasks,
        };
      }),
    );
  }

  async getListIdByName(listName: string | undefined): Promise<string | undefined> {
    if (!listName) {
      return;
    }

    const endpoint = '/me/todo/lists';
    const response = await this.client.api(endpoint).filter(`contains(displayName,'${listName}')`).get(); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
    const resource: TodoTaskList[] = response.value as TodoTaskList[];
    if (!resource || resource.length === 0) {
      return;
    }

    const target = resource[0];
    return target.id;
  }

  async getList(listId: string | undefined): Promise<TodoTaskList | undefined> {
    if (!listId) {
      return;
    }

    const endpoint = `/me/todo/lists/${listId}`;
    return (await this.client.api(endpoint).get()) as TodoTaskList;
  }

  async createTaskList(displayName: string | undefined): Promise<TodoTaskList | undefined> {
    if (!displayName) {
      return;
    }

    return this.client.api('/me/todo/lists').post({
      displayName,
    });
  }

  // Task operation
  async getListTasks(listId: string | undefined, searchText?: string): Promise<TodoTask[] | undefined> {
    if (!listId) {
      return;
    }

    const endpoint = `/me/todo/lists/${listId}/tasks`;
    if (!searchText) {
      return;
    }

    const res = await this.client
      .api(endpoint)
      .filter(searchText)
      .get()
      .catch(error => {
        new Notice(t('Notice_UnableToAcquireTaskFromConfiguredList'));
      });
    if (!res) {
      return;
    }

    return res.value as TodoTask[];
  }

  async getTask(listId: string, taskId: string): Promise<TodoTask | undefined> {
    const endpoint = `/me/todo/lists/${listId}/tasks/${taskId}`;
    return (await this.client.api(endpoint).get()) as TodoTask;
  }

  async createTaskFromToDo(listId: string | undefined, toDo: TodoTask): Promise<TodoTask> {
    const endpoint = `/me/todo/lists/${listId}/tasks`;
    this.logger.debug('Creating task from endpoint', endpoint);
    return this.client.api(endpoint).post(toDo);
  }

  async updateTaskFromToDo(listId: string | undefined, taskId: string, toDo: TodoTask): Promise<TodoTask> {
    const endpoint = `/me/todo/lists/${listId}/tasks/${taskId}`;
    return this.client.api(endpoint).patch(toDo);
  }
}
