import type { Ctx } from "./context.ts";
import { scheduleRender } from "./render/queue.ts";
import { renderView } from "./render/view.ts";
import { charactersOf, characterView, linesOf, lineView, sectionsOf, sectionView } from "./views.ts";

// The whole script plus the current render. Shared by the director and actor endpoints.
// Opening it builds the first run-through (TTS for every line until people record) and rebuilds a
// finished one that went stale without a take landing, e.g. after a line edit or a TTS change.
export async function runThrough(ctx: Ctx, production: { id: string; title: string }, myCharacterIds: string[]) {
  const [sections, characters, lines, current] = await Promise.all([
    sectionsOf(ctx.sql, production.id),
    charactersOf(ctx.sql, production.id),
    linesOf(ctx.sql, production.id),
    renderView(ctx, production.id),
  ]);
  let render = current;
  const hasDialogue = lines.some((l) => l.kind === "dialogue");
  if (hasDialogue && (render.status === "none" || (render.status === "ready" && render.stale))) {
    await scheduleRender(ctx, production.id, { force: render.status === "none" });
    if (render.status === "none") ctx.renderWorker.kick();
    render = { ...render, status: "queued" };
  }
  return {
    production: { id: production.id, title: production.title },
    sections: sections.map(sectionView),
    characters: characters.map(characterView),
    lines: lines.map(lineView),
    render,
    myCharacterIds,
  };
}
