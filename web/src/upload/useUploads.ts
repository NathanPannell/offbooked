import { useSyncExternalStore } from "react";
import { getUploader } from "./uploader";

export function useUploads() {
  const uploader = getUploader();
  const items = useSyncExternalStore(uploader.subscribe, uploader.getItems);
  return { uploader, items };
}
