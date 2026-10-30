import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Three scenes as a Word file. HAMLET speaks first and last in scene 1 (three lines of others
// between), not at all in scene 2, and once in scene 3, straight after his cue.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "gaps.docx");

const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Signs in as a new director, sets up the play from gaps.docx and opens Listen. */
async function openListen(page: Page, title: string): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  await expect(page).toHaveURL(/\/app\/new$/);

  await page.getByLabel("Title").fill(title);
  await page.getByLabel("First performance").fill(dayFromNow(30));
  await page.getByLabel("Final performance").fill(dayFromNow(33));
  await page.locator('input[type="file"]').setInputFiles(SCRIPT);
  await page.getByRole("button", { name: "Read the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+\?tab=script$/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Listen", exact: true }).click();
}

test("following one part, a tap goes to my next line's cue, past others' lines and scenes I'm not in", async ({ page }) => {
  await openListen(page, "Hamlet (gaps)");

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

test("with Skip to my cues on, the play skips to my cue and stops before a scene I'm not in", async ({ page }) => {
  await openListen(page, "Hamlet (skip to my cues)");
  const controls = page.getByRole("group", { name: "Playback" });
  const current = page.locator('.lyric[aria-current="true"]');
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.getByLabel("Your part").selectOption({ label: "HAMLET" });

  const toggle = page.getByRole("button", { name: /Skip to (my )?cues/ });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Every line that is current, in order.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seen: string[] }).seen = seen;
    new MutationObserver(() => {
      const text = document.querySelector('.lyric[aria-current="true"] .lyric-text')?.textContent ?? "";
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-current"], childList: true });
  });
  const seen = () => page.evaluate(() => (window as unknown as { seen: string[] }).seen);

  await controls.getByRole("button", { name: "Play", exact: true }).click();
  // After his first line, past three of others' lines to his cue, then his line, then a stop: his
  // next line is past scene 2, which he isn't in.
  const prompt = page.getByRole("group", { name: "Long stretch ahead" });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toContainText(/Your next line is in .*Scene 3/i);
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(current).toContainText("Stand, and unfold yourself.");
  expect(await seen()).toEqual(["Who's there?", "Say, what, is Horatio there?", "Stand, and unfold yourself."]);

  await prompt.getByRole("button", { name: "Jump to my next cue" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(current).toContainText(/Long live the king!|The air bites shrewdly/);
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  expect((await seen()).some((t) => t.includes("Last night of all"))).toBe(false);

  // Remembered for this production on this device.
  await page.reload();
  await expect(page.getByRole("button", { name: /Skip to (my )?cues/ })).toHaveAttribute("aria-pressed", "true");
});

test("with Skip to my cues on, Keep listening plays the scene I'm not in", async ({ page }) => {
  await openListen(page, "Hamlet (keep listening)");
  const controls = page.getByRole("group", { name: "Playback" });
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.getByLabel("Your part").selectOption({ label: "HAMLET" });
  await page.getByRole("button", { name: /Skip to (my )?cues/ }).click();
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  const prompt = page.getByRole("group", { name: "Long stretch ahead" });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole("button", { name: "Keep listening" }).click();
  await expect(page.locator('.lyric[aria-current="true"]')).toContainText("Last night of all");
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});
