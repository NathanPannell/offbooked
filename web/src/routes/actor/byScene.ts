/** A scene's heading and its lines, in script order. */
export interface SceneGroup<T> {
  sectionId: string;
  title: string;
  items: T[];
}

/**
 * Groups lines under their scenes, like the recorder: scenes in the order they first appear, each
 * line kept in the order it was given (script order).
 */
export function byScene<T extends { line: { sectionId: string }; sectionTitle: string }>(items: readonly T[]): SceneGroup<T>[] {
  const groups = new Map<string, SceneGroup<T>>();
  for (const item of items) {
    const id = item.line.sectionId;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = { sectionId: id, title: item.sectionTitle, items: [] }));
    group.items.push(item);
  }
  return [...groups.values()];
}
