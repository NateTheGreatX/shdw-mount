/*
    Description: A simple semaphore implementation to limit the number of concurrent tasks.
 */
export class Semaphore {
    private tasks: (() => Promise<void>)[] = [];
    private _activeCount = 0;
    private readonly maxConcurrency: number;

    constructor(maxConcurrency: number) {
        this.maxConcurrency = maxConcurrency;
    }

    async acquire() {
        if (this._activeCount >= this.maxConcurrency) {
            await new Promise<void>(resolve => this.tasks.push(() => Promise.resolve(resolve())));
        }
        this._activeCount++;
    }

    release() {
        this._activeCount--;
        if (this.tasks.length > 0) {
            const nextTask = this.tasks.shift();
            if (nextTask) nextTask();
        }
    }
}

