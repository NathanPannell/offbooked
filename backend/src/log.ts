export interface Log {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const consoleLog: Log = {
  info: (obj, msg) => console.log(msg ?? "", JSON.stringify(obj)),
  warn: (obj, msg) => console.warn(msg ?? "", JSON.stringify(obj)),
  error: (obj, msg) => console.error(msg ?? "", JSON.stringify(obj, errorReplacer)),
};

export const silentLog: Log = { info() {}, warn() {}, error() {} };

function errorReplacer(_key: string, value: unknown) {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}
