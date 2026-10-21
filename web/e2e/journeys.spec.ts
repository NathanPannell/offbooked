import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Four speeches for two parts, as a Word file: scripts are PDF or .docx only.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hamlet.docx");

/** YYYY-MM-DD, `days` from today. */
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function signInAsDirector(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  // The backend runs with EMAIL_DRIVER=log, so the sign-in link comes back on the page.
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  // A new director has no productions yet, so signing in goes straight to setting one up.
  await expect(page).toHaveURL(/\/app\/new$/);
}

/** Sets up a play on one screen (title, dates, script) and waits on it until the script is read. */
async function createProduction(page: Page, title: string): Promise<void> {
  await page.goto("/app/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("First performance").fill(dayFromNow(30));
  await page.getByLabel("Final performance").fill(dayFromNow(33));
  await page.locator('input[type="file"]').setInputFiles(SCRIPT);
  await expect(page.getByText("hamlet.docx")).toBeVisible();
  await page.getByRole("button", { name: "Read the script" }).click();
  // Reading happens right here; once it's done the director lands on their script.
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+\?tab=script$/, { timeout: 30_000 });
  await expect(page.getByText("Stand, and unfold yourself.")).toBeVisible();
}

test("a director uploads a script and shares the cast link, and a cast member opens it", async ({ page, browser }, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsDirector(page);

  // A first production can't be cancelled back to an empty list, and the form checks its fields.
  await page.goto("/app/new");
  await expect(page.getByRole("link", { name: "Cancel" })).toHaveCount(0);
  await page.getByRole("button", { name: "Read the script" }).click();
  await expect(page.getByText("Give the production a title.")).toBeVisible();
  await expect(page.getByText("Add the script as a PDF or Word file.")).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "hamlet.txt", mimeType: "text/plain", buffer: Buffer.from("HAMLET\nWho's there?\n") });
  await expect(page.getByText("That file won't work. Use a PDF or a Word .docx file.")).toBeVisible();
  await page.getByRole("button", { name: "About performance dates" }).click();
  await expect(page.getByRole("tooltip")).toHaveText("We delete the script and every recording 7 days after the final performance.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();

  // Once the script is read, the director lands on it, with the cast marked as the next step.
  await createProduction(page, "Hamlet (e2e)");
  await expect(page.getByText("Read 4 lines across 2 parts")).toBeVisible();
  await expect(page.getByRole("button", { name: "Share with the cast" })).toHaveCount(0);
  // With a production to go back to, setting up another one can be cancelled.
  await page.goto("/app/new");
  await expect(page.getByRole("link", { name: "Cancel" })).toBeVisible();
  await page.goBack();
  await page.getByRole("button", { name: "Cast, next step" }).click();
  await expect(page.getByRole("heading", { name: "Invite your cast" })).toBeVisible();
  await expect(page.getByText("0 of 2 parts started")).toBeVisible();

  // With no name set, the cast would see the start of the director's email: offer to change it.
  // (Words with digits in the email's start are left out, so it reads "Director", not "Director 1729…".)
  await expect(page.getByText(/^Your cast will see “Director/)).toBeVisible();
  await page.getByRole("button", { name: "Change it" }).click();
  await page.getByPlaceholder("Your name").fill("Sam");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Your cast will see “Director/)).toHaveCount(0);

  // The dates reached the server: archiving says the day everything is deleted.
  await page.getByRole("button", { name: "Archive production" }).click();
  const archive = page.getByRole("dialog", { name: "Archive Hamlet (e2e)?" });
  await expect(archive.getByText(/The script and every recording are deleted on .+, 7 days after the final performance\./)).toBeVisible();
  await archive.getByRole("button", { name: "Keep it" }).click();
  await expect(archive).toBeHidden();

  await page.getByRole("button", { name: "Copy the cast link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const joinUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(joinUrl).toMatch(/^http:\/\/localhost:4173\/join\/[^/]+$/);
  // Sharing the link was the Cast step's job, so it's no longer marked as next.
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await expect(page.getByRole("button", { name: "Cast, next step" })).toHaveCount(0);

  // The cast member opens the link on their own device, with no account.
  const actor = await browser.newContext({ ...testInfo.project.use });
  const phone = await actor.newPage();
  await phone.goto(joinUrl);
  await phone.getByRole("button", { name: "Skip intro" }).click();
  await expect(phone.getByText("Sam invited you to “Hamlet (e2e)”")).toBeVisible();
  await expect(phone.getByRole("heading", { name: "Who are you playing?" })).toBeVisible();
  await phone.getByRole("checkbox", { name: /^HORATIO, 2 lines, 0 recorded/i }).check({ force: true });
  await expect(phone.getByText(/^You'll be reading for HORATIO/i)).toBeVisible();
  await phone.getByLabel("Your name").fill("Riz");
  await phone.getByRole("button", { name: /Start recording/ }).click();
  await expect(phone).toHaveURL(/\/i\/[^/]+/);
  await expect(phone.getByText("Friends to this ground.").first()).toBeVisible();
  // Their name lives behind their initials at the top right, like the director's.
  await expect(phone.getByRole("button", { name: "You: Riz" })).toBeVisible();

  // Parts aren't owned: someone on another phone can pick HORATIO too.
  const other = await browser.newContext({ ...testInfo.project.use });
  const second = await other.newPage();
  await second.goto(joinUrl);
  await second.getByRole("button", { name: "Skip intro" }).click();
  await second.getByRole("checkbox", { name: /^HORATIO, 2 lines/i }).check({ force: true });
  await second.getByLabel("Your name").fill("Jo");
  await second.getByRole("button", { name: /Start recording/ }).click();
  await expect(second).toHaveURL(/\/i\/[^/]+/);

  // Listening through is practising: a cast member opens on their own part, every one of their
  // lines highlighted and their cues underlined, with a pause to say each line before it plays.
  const invitePath = new URL(second.url()).pathname.match(/^\/i\/[^/]+/)![0];
  await second.goto(`${invitePath}/play`);
  await expect(second.getByLabel("Your part")).toHaveValue("mine");
  await expect(second.getByLabel("Your lines")).toHaveValue("pause");
  await expect(second.locator(".lyric.is-mine")).toHaveCount(2);
  await expect(second.locator(".lyric-cue").first()).toBeVisible();
  await expect(second.getByRole("button", { name: /Score me/ })).toHaveCount(0);

  // Someone who isn't reading skips straight to the listen-through, with no part and no name.
  const listener = await browser.newContext({ ...testInfo.project.use });
  const ears = await listener.newPage();
  await ears.goto(joinUrl);
  await ears.getByRole("button", { name: "Skip intro" }).click();
  await ears.getByRole("button", { name: /Skip to the listen-through/ }).click();
  await expect(ears).toHaveURL(/\/i\/[^/]+\/play$/);
  await expect(ears.getByLabel("Your part")).toHaveValue("");
  await expect(ears.getByLabel("Your lines")).toHaveCount(0);
  await listener.close();

  // Picking a part isn't recording it: the call sheet counts parts started by their recordings.
  await page.reload();
  await page.getByRole("button", { name: "Cast", exact: true }).click();
  await expect(page.getByText("0 of 2 parts started")).toBeVisible();
  await actor.close();
  await other.close();
});

test("the screen stays on while the run-through plays", async ({ page }) => {
  // Stand in for the Screen Wake Lock API and count what the page asks for and gives back.
  await page.addInitScript(() => {
    const log = { requested: 0, released: 0 };
    (window as unknown as { wakeLockLog: typeof log }).wakeLockLog = log;
    Object.defineProperty(Navigator.prototype, "wakeLock", {
      configurable: true,
      get: () => ({
        request: (type: string) => {
          if (type !== "screen") return Promise.reject(new TypeError(type));
          log.requested++;
          const sentinel = new EventTarget() as EventTarget & { released: boolean; type: string; release: () => Promise<void> };
          sentinel.released = false;
          sentinel.type = "screen";
          sentinel.release = () => {
            if (!sentinel.released) {
              sentinel.released = true;
              log.released++;
              sentinel.dispatchEvent(new Event("release"));
            }
            return Promise.resolve();
          };
          return Promise.resolve(sentinel);
        },
      }),
    });
  });
  const wakeLock = () => page.evaluate(() => (window as unknown as { wakeLockLog: { requested: number; released: number } }).wakeLockLog);

  await signInAsDirector(page);
  await createProduction(page, "Hamlet (run-through)");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  const play = page.getByRole("group", { name: "Playback" }).getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeEnabled();
  expect(await wakeLock()).toEqual({ requested: 0, released: 0 });

  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(wakeLock).toEqual({ requested: 1, released: 0 });

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(wakeLock).toEqual({ requested: 1, released: 1 });
});
