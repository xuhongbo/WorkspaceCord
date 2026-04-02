import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

let dataDirOverride: string | null = null;

export function getDataDir(): string {
  return dataDirOverride ?? join(homedir(), '.workspacecord');
}

/** 仅测试时使用，覆盖数据目录 */
export function _setDataDirForTest(dir: string | null): void {
  dataDirOverride = dir;
}

export class Store<T> {
  private readonly filename: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    this.filename = filename;
  }

  private get filePath(): string {
    return join(getDataDir(), this.filename);
  }

  async read(): Promise<T | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  async write(data: T): Promise<void> {
    const nextWrite = this.writeQueue.catch(() => {}).then(async () => {
      const filePath = this.filePath;
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const tmpPath = filePath + '.tmp';
      await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await rename(tmpPath, filePath);
    });
    this.writeQueue = nextWrite;
    await nextWrite;
  }
}
