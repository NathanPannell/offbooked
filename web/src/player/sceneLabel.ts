// A scene in the run-through's scene picker, with who speaks in it: "Act 1, Scene 2 · Duncan,
// Malcolm, Captain, Lennox +1". Names are in order of first line; after `max` the rest are counted.

const titleCase = (name: string): string =>
  name === name.toUpperCase() ? name.toLowerCase().replace(/(^|[\s\-'’.(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase()) : name;

export function sceneLabel(title: string, speakerIds: string[], names: Map<string, string>, max = 4): string {
  const who = speakerIds.map((id) => names.get(id)).filter((n): n is string => Boolean(n)).map(titleCase);
  if (who.length === 0) return title;
  const shown = who.slice(0, max).join(", ");
  return `${title} · ${who.length > max ? `${shown} +${who.length - max}` : shown}`;
}
