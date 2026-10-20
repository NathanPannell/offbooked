import { useEffect, useState } from "react";
import { readStorage, writeStorage } from "./storage";

// Whether the director has copied or shared a production's cast link on this device. Once they
// have, the Cast step stops being marked as the next step: the job it points at is done.

const key = (productionId: string) => `offbooked.linkShared.${productionId}`;
const EVENT = "offbooked:link-shared";

export function linkShared(productionId: string): boolean {
  return readStorage(key(productionId)) === "1";
}

export function markLinkShared(productionId: string): void {
  if (linkShared(productionId)) return;
  writeStorage(key(productionId), "1");
  window.dispatchEvent(new CustomEvent(EVENT, { detail: productionId }));
}

/** `linkShared`, kept current when the link is shared on this page. */
export function useLinkShared(productionId: string): boolean {
  const [shared, setShared] = useState(() => linkShared(productionId));
  useEffect(() => {
    setShared(linkShared(productionId));
    const onShared = (e: Event) => {
      if ((e as CustomEvent<string>).detail === productionId) setShared(true);
    };
    window.addEventListener(EVENT, onShared);
    return () => window.removeEventListener(EVENT, onShared);
  }, [productionId]);
  return shared;
}
