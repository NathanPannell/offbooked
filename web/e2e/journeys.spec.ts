import { expect, test, type Page } from "@playwright/test";

const SCRIPT = `HAMLET
Who's there?

HORATIO
Friends to this ground.

HAMLET
Stand, and unfold yourself.

HORATIO
Long live the king!
`;

async function signInAsDirector(page: Page): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(`director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  // The backend runs with EMAIL_DRIVER=log, so the sign-in link comes back on the page.
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  await expect(page).toHaveURL(/\/app$/);
}

async function createProduction(page: Page, title: string): Promise<void> {
  await page.goto("/app/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Next: add the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+/);
  await page.locator('input[type="file"]').setInputFiles({ name: "hamlet.txt", mimeType: "text/plain", buffer: Buffer.from(SCRIPT) });
  await expect(page.getByRole("heading", { name: "Send this to your cast" })).toBeVisible({ timeout: 30_000 });
}

test("a director uploads a script and shares the cast link, and a cast member opens it", async ({ page, browser }, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsDirector(page);

  // Once the script is read, the next step is sharing it: the cast page opens with the parts found.
  await createProduction(page, "Hamlet (e2e)");
  await expect(page.getByText("0 of 2 parts taken")).toBeVisible();
  await page.getByRole("button", { name: "Script", exact: true }).click();
  await expect(page.getByText("Stand, and unfold yourself.")).toBeVisible();
  await page.getByRole("button", { name: "Cast", exact: true }).click();
  await page.getByRole("button", { name: "Copy the cast link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const joinUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(joinUrl).toMatch(/^http:\/\/localhost:4173\/join\/[^/]+$/);

  // The cast member opens the link on their own device, with no account.
  const actor = await browser.newContext({ ...testInfo.project.use });
  const phone = await actor.newPage();
  await phone.goto(joinUrl);
  await phone.getByRole("button", { name: "Skip intro" }).click();
  await expect(phone.getByRole("heading", { name: "Hamlet (e2e)" })).toBeVisible();
  await phone.getByRole("checkbox", { name: /^HORATIO, 2 lines$/i }).check({ force: true });
  await phone.getByLabel("Your first name").fill("Riz");
  await phone.getByRole("button", { name: /Start recording/ }).click();
  await expect(phone).toHaveURL(/\/i\/[^/]+/);
  await expect(phone.getByText("Friends to this ground.").first()).toBeVisible();

  // The director sees the part taken.
  await page.reload();
  await expect(page.getByText("1 of 2 parts taken")).toBeVisible();
  await actor.close();
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
  await page.getByRole("button", { name: "Run-through", exact: true }).click();
  const play = page.getByRole("group", { name: "Playback" }).getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeEnabled();
  expect(await wakeLock()).toEqual({ requested: 0, released: 0 });

  await play.click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect.poll(wakeLock).toEqual({ requested: 1, released: 0 });

  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(wakeLock).toEqual({ requested: 1, released: 1 });
});
