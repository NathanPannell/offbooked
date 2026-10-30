import type { Ctx } from "./context.ts";
import { renderView } from "./render/view.ts";
import { lineSources, takeDurations } from "./linestream.ts";
import { charactersOf, characterView, linesOf, lineView, sectionsOf, sectionView } from "./views.ts";

// The whole script, where each line's audio comes from, and the stitched render's state. Shared by
// the director and actor endpoints. The player plays line by line (see linestream.ts), warming the
// lines ahead itself; the stitched render is built only when asked for (POST /render).
export async function runThrough(ctx: Ctx, production: { id: string; title: string }, myCharacterIds: string[]) {
  const [sections, characters, lines, current, sources, durations] = await Promise.all([
    sectionsOf(ctx.sql, production.id),
    charactersOf(ctx.sql, production.id),
    linesOf(ctx.sql, production.id),
    renderView(ctx, production.id),
    lineSources(ctx, production.id),
    takeDurations(ctx, production.id),
  ]);
  const render = current;
  return {
    production: { id: production.id, title: production.title },
    sections: sections.map(sectionView),
    characters: characters.map(characterView),
    lines: lines.map(lineView),
    render,
    sources,
    durations,
    myCharacterIds,
  };
}
