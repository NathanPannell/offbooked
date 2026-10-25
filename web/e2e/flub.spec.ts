import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// The wrong-line check, end to end: the fake mic plays a recording of someone saying something
// else ("Sorry, hang on. Where are we? I lost my place.", 1 s in, then quiet, looping every 10 s)
// while HORATIO's "Friends to this ground." records, and the real speech model listens.
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "fixtures", "hamlet.docx");
const WRONG_LINE = path.join(here, "fixtures", "wrong-line.wav");

test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${WRONG_LINE}`],
  },
});

/** YYYY-MM-DD, `days` from today. */
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function directorWithPlay(page: Page, title: string): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  await expect(page).toHaveURL(/\/app\/new$/);
  // Offbooked is in private beta: a new account enters the access code before setting up a play.
  await page.getByLabel("Access code").fill("Break a leg!");
  await page.getByRole("button", { name: "Unlock Offbooked" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("First performance").fill(dayFromNow(30));
  await page.getByLabel("Final performance").fill(dayFromNow(33));
  await page.locator('input[type="file"]').setInputFiles(SCRIPT);
  await page.getByRole("button", { name: "Read the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+\?tab=script$/, { timeout: 30_000 });
}

/**
 * Records the line hands-free and checks the prompt: the first flag counts down to reading the
 * line again by itself (a tap on ← does it now); the same line flagged again waits for a tap, and ✓
 * keeps the take.
 */
async function flubTwiceThenKeep(page: Page, recordLabel: string | RegExp): Promise<void> {
  // The check needs the speech model; it loads while the page opens.
  await expect(page.locator('[data-stt="ready"]')).toBeVisible({ timeout: 60_000 });
  const card = page.locator(".line-card", { hasText: "Friends to this ground." });
  await page.getByRole("button", { name: recordLabel }).click();
  await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();

  // It wasn't the line: the take stops without moving on, the card turns amber and asks.
  const ask = card.getByText("Did you mean to say something else?");
  await expect(ask).toBeVisible({ timeout: 20_000 });
  await expect(card).toHaveClass(/is-flub/);
  await expect(page.getByRole("button", { name: "Stop recording" })).toHaveCount(0);
  await expect(card.getByText(/Starting in [1-3]/)).toBeVisible();
  await card.getByRole("button", { name: /No, I'll read it again/ }).click();
  await expect(page.getByRole("button", { name: "Stop recording" })).toBeVisible();

  // Flagged twice in a row: no countdown this time, it waits.
  await expect(ask).toBeVisible({ timeout: 25_000 });
  await expect(card.getByText(/Starting/)).toHaveCount(0);
  await page.waitForTimeout(3500);
  await expect(page.getByRole("button", { name: "Stop recording" })).toHaveCount(0);
  await expect(ask).toBeVisible();

  // "Yep, that's what I said": the take is kept.
  await card.getByRole("button", { name: /Yep, that's what I said/ }).click();
  await expect(ask).toHaveCount(0);
  await expect(card.getByText(/Recorded by you/)).toBeVisible();
}

test("a cast member who says something else is asked before the recorder moves on", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await directorWithPlay(page, "Hamlet (wrong line)");
  await page.getByRole("button", { name: "Cast, next step" }).click();
  await page.getByRole("button", { name: "Copy the cast link" }).click();
  const joinUrl = await page.evaluate(() => navigator.clipboard.readText());

  const actor = await browser.newContext({ ...testInfo.project.use, permissions: ["microphone"] });
  const phone = await actor.newPage();
  await phone.goto(joinUrl);
  await phone.getByRole("button", { name: "Skip intro" }).click();
  await phone.getByRole("checkbox", { name: /^HORATIO, 2 lines/i }).check({ force: true });
  await phone.getByLabel("Your name").fill("Riz");
  await phone.getByRole("button", { name: /Start recording/ }).click();
  await expect(phone.getByText("Friends to this ground.").first()).toBeVisible();
  await phone.getByRole("button", { name: "Skip", exact: true }).click();
  await flubTwiceThenKeep(phone, "Record line 1");
  await actor.close();
});

test("the director's studio asks the same way", async ({ page }) => {
  test.setTimeout(150_000);
  await page.context().grantPermissions(["microphone"]);
  await directorWithPlay(page, "Hamlet (studio wrong line)");
  await page.getByRole("button", { name: "Cast, next step" }).click();
  await page.getByRole("button", { name: /Record some lines yourself/ }).click();
  await page.getByRole("link", { name: /HORATIO/ }).click();
  await expect(page.getByText("Friends to this ground.").first()).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await flubTwiceThenKeep(page, /^Record HORATIO's line/);
});
