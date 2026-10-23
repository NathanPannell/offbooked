import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { TakeFiles } from "./fileTakeStore";

const FOLDER = "offbooked-takes";
const where = (path: string) => ({ path: `${FOLDER}/${path}`, directory: Directory.Library });
const text = (data: string | Blob) => (typeof data === "string" ? data : null);

/** The take store's files in Library/offbooked-takes: kept until the app removes them, never shown in Files. */
export const capacitorTakeFiles: TakeFiles = {
  readText: (path) =>
    Filesystem.readFile({ ...where(path), encoding: Encoding.UTF8 })
      .then((r) => text(r.data))
      .catch(() => null),
  writeText: (path, data) => Filesystem.writeFile({ ...where(path), data, encoding: Encoding.UTF8, recursive: true }).then(() => {}),
  readBase64: (path) =>
    Filesystem.readFile(where(path))
      .then((r) => text(r.data))
      .catch(() => null),
  writeBase64: (path, data) => Filesystem.writeFile({ ...where(path), data, recursive: true }).then(() => {}),
  list: () =>
    Filesystem.readdir({ path: FOLDER, directory: Directory.Library })
      .then((r) => r.files.map((f) => f.name))
      .catch(() => []),
  remove: (path) => Filesystem.deleteFile(where(path)).catch(() => {}),
};
