import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonFile<T extends object> {
  read(): Promise<T>;
  /** Edits the whole file in order with every other change, then replaces it atomically. */
  change(edit: (value: T) => void): Promise<void>;
}

export function jsonFile<T extends object>(file: string): JsonFile<T> {
  let writing: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<T> => {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
      throw error;
    }
  };
  return {
    read,
    change(edit) {
      const next = writing.then(async () => {
        const value = await read();
        edit(value);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const staged = `${file}.${process.pid}.tmp`;
        await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await chmod(staged, 0o600);
        await rename(staged, file);
      });
      writing = next.catch(() => undefined);
      return next;
    },
  };
}
