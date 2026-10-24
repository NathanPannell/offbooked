import { App } from "@capacitor/app";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { appPathFromUrl } from "./links";
import { isNativeApp } from "./platform";

/**
 * In the app, a cast or sign-in link opened from Messages, Mail or Safari (a universal link) or an
 * offbooked:// link lands on its page. One opened before the app had started is held by Capacitor
 * until this listens, so a cold start lands there too.
 */
export function NativeLinks() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!isNativeApp()) return;
    const handle = App.addListener("appUrlOpen", ({ url }) => {
      const path = appPathFromUrl(url);
      if (path) void navigate(path);
    });
    return () => void handle.then((h) => h.remove());
  }, [navigate]);
  return null;
}
