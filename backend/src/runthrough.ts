import type { Ctx } from "./context.ts";
import { renderView } from "./render/view.ts";
import { charactersOf, characterView, linesOf, lineView, sectionsOf, sectionView } from "./views.ts";

// The whole script plus the current render. Shared by the director and actor endpoints.
export async function runThrough(ctx: Ctx, production: { id: string; title: string }, myCharacterIds: string[]) {
  const [sections, characters, lines, render] = await Promise.all([
    sectionsOf(ctx.sql, production.id),
    charactersOf(ctx.sql, production.id),
    linesOf(ctx.sql, production.id),
    renderView(ctx, production.id),
  ]);
  return {
    production: { id: production.id, title: production.title },
    sections: sections.map(sectionView),
    characters: characters.map(characterView),
    lines: lines.map(lineView),
    render,
    myCharacterIds,
  };
}
