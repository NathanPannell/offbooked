import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (update: T | ((current: T | undefined) => T)) => void;
}

/** Loads data on mount and when `key` changes. `reload` refetches without clearing what's shown. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const result = await loadRef.current();
      if (mine === generation.current) {
        setDataState(result);
        setError(null);
      }
    } catch (err) {
      if (mine === generation.current) setError(err);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setDataState(undefined);
    void reload();
  }, [key, reload]);

  const setData = useCallback((update: T | ((current: T | undefined) => T)) => {
    setDataState((current) => (typeof update === "function" ? (update as (c: T | undefined) => T)(current) : update));
  }, []);

  return { data, error, loading, reload, setData };
}

/** Calls `fn` every `ms` while `enabled`, pausing while the tab is hidden. */
export function useInterval(fn: () => void, ms: number, enabled: boolean) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") fnRef.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}
