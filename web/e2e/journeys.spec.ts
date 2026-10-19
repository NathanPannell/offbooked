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

test("a director uploads a script and shares the cast link, and a cast member opens it", async ({ page, browser }, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsDirector(page);

  await page.goto("/app/new");
  await page.getByLabel("Title").fill("Hamlet (e2e)");
  await page.getByRole("button", { name: "Next: add the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+/);

  await page.locator('input[type="file"]').setInputFiles({ name: "hamlet.txt", mimeType: "text/plain", buffer: Buffer.from(SCRIPT) });
  // Once the script is read, the next step is sharing it: the cast page opens with the parts found.
  await expect(page.getByRole("heading", { name: "Send this to your cast" })).toBeVisible({ timeout: 30_000 });
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
