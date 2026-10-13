/** Keeps the screen on while held. Re-acquires after the tab becomes visible again. No-op where unsupported. */
export function holdWakeLock(): () => void {
  type Sentinel = { release(): Promise<void> };
  const wakeLock = (navigator as { wakeLock?: { request(type: "screen"): Promise<Sentinel> } }).wakeLock;
  if (!wakeLock) return () => {};
  let sentinel: Sentinel | null = null;
  let released = false;
  const acquire = () => {
    wakeLock.request("screen").then(
      (s) => {
        if (released) void s.release();
        else sentinel = s;
      },
      () => {},
    );
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && !released) acquire();
  };
  acquire();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    released = true;
    document.removeEventListener("visibilitychange", onVisible);
    void sentinel?.release().catch(() => {});
  };
}
