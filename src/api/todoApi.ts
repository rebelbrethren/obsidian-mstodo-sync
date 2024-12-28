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

    /**
     * Retrieves the lists of tasks from the Todo API.
     *
     * @param searchPattern - An optional search pattern to filter tasks within the lists.
     * @returns A promise that resolves to an array of `TodoTaskList` objects, each containing their respective tasks, or `undefined` if no lists are found.
     */
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

    /**
     * Retrieves the ID of a to-do list by its name.
     *
     * @param listName - The name of the to-do list to search for. If undefined, the function returns immediately.
     * @returns A promise that resolves to the ID of the to-do list if found, otherwise undefined.
     *
     * @throws Will throw an error if the API request fails.
     */
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

    /**
     * Retrieves a TodoTaskList by its ID.
     *
     * @param listId - The ID of the TodoTaskList to retrieve. If undefined, the function returns undefined.
     * @returns A promise that resolves to the TodoTaskList if found, or undefined if the listId is not provided.
     */
    async getList(listId: string | undefined): Promise<TodoTaskList | undefined> {
        if (!listId) {
            return;
        }

        const endpoint = `/me/todo/lists/${listId}`;
        return (await this.client.api(endpoint).get()) as TodoTaskList;
    }

    /**
     * Creates a new task list with the given display name.
     *
     * @param displayName - The name to be displayed for the new task list. If undefined, the task list will not be created.
     * @returns A promise that resolves to the created TodoTaskList object, or undefined if the display name is not provided.
     */
    async createTaskList(displayName: string | undefined): Promise<TodoTaskList | undefined> {
        if (!displayName) {
            return;
        }

        return this.client.api('/me/todo/lists').post({
            displayName,
        });
    }

    /**
     * Retrieves a list of tasks from a specified to-do list.
     *
     * @param listId - The ID of the to-do list. If undefined, the function will return immediately.
     * @param searchText - Optional search text to filter the tasks. If not provided, the function will return immediately.
     * @returns A promise that resolves to an array of `TodoTask` objects, or undefined if the listId or searchText is not provided, or if an error occurs.
     */
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

    /**
     * Retrieves a specific task from a to-do list.
     *
     * @param listId - The ID of the to-do list containing the task.
     * @param taskId - The ID of the task to retrieve.
     * @returns A promise that resolves to the `TodoTask` object if found, or `undefined` if not found.
     */
    async getTask(listId: string, taskId: string): Promise<TodoTask | undefined> {
        const endpoint = `/me/todo/lists/${listId}/tasks/${taskId}`;
        return (await this.client.api(endpoint).get()) as TodoTask;
    }

    /**
     * Creates a new task in the specified To-Do list.
     *
     * @param listId - The ID of the To-Do list where the task will be created. If undefined, the task will not be created.
     * @param toDo - The task details to be created.
     * @returns A promise that resolves to the created TodoTask.
     */
    async createTaskFromToDo(listId: string | undefined, toDo: TodoTask): Promise<TodoTask> {
        const endpoint = `/me/todo/lists/${listId}/tasks`;
        this.logger.debug('Creating task from endpoint', endpoint);
        return this.client.api(endpoint).post(toDo);
    }

    /**
     * Updates a task in the specified To-Do list.
     *
     * @param listId - The ID of the To-Do list. Can be undefined.
     * @param taskId - The ID of the task to update.
     * @param toDo - The updated task details.
     * @returns A promise that resolves to the updated task.
     */
    async updateTaskFromToDo(listId: string | undefined, taskId: string, toDo: TodoTask): Promise<TodoTask> {
        const endpoint = `/me/todo/lists/${listId}/tasks/${taskId}`;
        toDo.linkedResources = undefined;
        return this.client.api(endpoint).patch(toDo);
    }
}
