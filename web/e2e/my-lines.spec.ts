import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Three scenes as a Word file. HAMLET speaks first and last in scene 1 (three lines of others
// between), not at all in scene 2, and once in scene 3, straight after his cue.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gaps.docx");

const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test("following one part, a tap goes to my next line's cue, past others' lines and scenes I'm not in", async ({ page }) => {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  await expect(page).toHaveURL(/\/app\/new$/);

  await page.getByLabel("Title").fill("Hamlet (gaps)");
  await page.getByLabel("First performance").fill(dayFromNow(30));
  await page.getByLabel("Final performance").fill(dayFromNow(33));
  await page.locator('input[type="file"]').setInputFiles(SCRIPT);
  await page.getByRole("button", { name: "Read the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+\?tab=script$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Listen", exact: true }).click();

  const controls = page.getByRole("group", { name: "Playback" });
  const next = controls.getByRole("button", { name: "My next line" });
  const previous = controls.getByRole("button", { name: "My previous line" });
  const current = page.locator('.lyric[aria-current="true"]');
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

  // Just listening: nothing is mine, so there is nothing to jump between.
  await expect(next).toHaveCount(0);

  await page.getByLabel("Your part").selectOption({ label: "HAMLET" });
  await expect(controls.getByText("3 lines of mine")).toBeVisible();
  await expect(previous).toBeDisabled();
  // The scene list keeps only the scenes the part is in.
  await expect(page.getByLabel("Jump to scene").locator("option")).toHaveCount(3);

  // His first line opens the play: no cue before it.
  await next.click();
  await expect(current).toContainText("Who's there?");
  await expect(controls.getByText("Mine 1 of 3")).toBeVisible();

  // Past three of other people's lines, onto the cue for his next one.
  await next.click();
  await expect(current).toContainText("Say, what, is Horatio there?");
  await expect(controls.getByText("Mine 2 of 3")).toBeVisible();

  // Past scene 2, which he isn't in, to his cue in scene 3.
  await next.click();
  await expect(current).toContainText("Long live the king!");
  await expect(controls.getByText("Mine 3 of 3")).toBeVisible();
  await expect(next).toBeDisabled();

  await previous.click();
  await expect(current).toContainText("Say, what, is Horatio there?");

  // While it plays, a jump keeps playing from the cue.
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await next.click();
  await expect(current).toContainText(/Long live the king!|The air bites shrewdly/);
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});
