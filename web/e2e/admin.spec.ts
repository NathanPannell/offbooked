import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// The admin area. The backend runs with ADMIN_EMAILS=admin-e2e@example.test (playwright.config.ts).
const ADMIN_EMAIL = "admin-e2e@example.test";
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hamlet.docx");
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByRole("link", { name: "Use dev sign-in link" }).click();
  await expect(page).toHaveURL(/\/app(\/new)?$/);
}

test("an admin finds any production, opens it read only, and traces its director", async ({ page, browser }, testInfo) => {
  // A director sets up a play. They aren't an admin: the admin area doesn't exist for them.
  const directorEmail = `director-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const title = `Admin check ${Math.random().toString(36).slice(2, 8)}`;
  await signIn(page, directorEmail);
  await page.getByLabel("Access code").fill("break a leg");
  await page.getByRole("button", { name: "Unlock Offbooked" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("First performance").fill(dayFromNow(30));
  await page.getByLabel("Final performance").fill(dayFromNow(33));
  await page.locator('input[type="file"]').setInputFiles(SCRIPT);
  await page.getByRole("button", { name: "Read the script" }).click();
  await expect(page).toHaveURL(/\/app\/p\/[^/?]+\?tab=script$/, { timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  await page.goto("/app/admin");
  await expect(page.getByRole("heading", { name: "Wrong theatre." })).toBeVisible();

  // The admin signs in on their own device.
  const context = await browser.newContext({ ...testInfo.project.use });
  const admin = await context.newPage();
  await signIn(admin, ADMIN_EMAIL);
  await admin.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(admin).toHaveURL(/\/app\/admin\/productions$/);
  await expect(admin.getByRole("heading", { name: "Productions", level: 2 })).toBeVisible();

  await admin.getByRole("searchbox", { name: "Search productions" }).fill(title.toUpperCase());
  await admin.getByRole("button", { name: "Search" }).click();
  await expect(admin).toHaveURL(/\?q=/);
  const table = admin.getByRole("table", { name: "Productions" });
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("link", { name: directorEmail })).toBeVisible();

  // Opening it is the director's own page, with a banner, and nothing to rename or archive.
  await table.getByRole("link", { name: title }).click();
  await expect(admin.getByText("Admin view.")).toBeVisible();
  await expect(admin.getByRole("heading", { name: title })).toBeVisible();
  await admin.getByRole("button", { name: "Script", exact: true }).click();
  await expect(admin.getByText("Stand, and unfold yourself.")).toBeVisible();
  await expect(admin.getByRole("button", { name: "Archive production" })).toHaveCount(0);
  await admin.getByRole("button", { name: "Cast", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "Invite your cast" })).toBeVisible();
  // What only the director can do isn't offered: recording, renaming themselves, a new link.
  await expect(admin.getByRole("button", { name: "Record some lines yourself" })).toHaveCount(0);
  await expect(admin.getByText(/^Your cast will see/)).toHaveCount(0);
  await expect(admin.getByRole("button", { name: /Make a new one/ })).toHaveCount(0);
  await admin.getByRole("link", { name: "Back to admin" }).click();

  // The director is among the creators, with their figures, and their trace tells the story.
  await admin.getByRole("link", { name: "Creators", exact: true }).click();
  const creators = admin.getByRole("table", { name: "Creators" });
  const row = creators.getByRole("row").filter({ hasText: directorEmail });
  await expect(row).toContainText("Free beta");
  await row.getByRole("link", { name: directorEmail }).click();
  await expect(admin.getByRole("heading", { name: directorEmail })).toBeVisible();
  const timeline = admin.getByRole("list", { name: "Timeline" });
  await expect(timeline.getByText("Created a director account")).toBeVisible();
  await expect(timeline.getByText("Signed in").first()).toBeVisible();
  await expect(timeline.getByText("Created a production")).toBeVisible();
  await expect(timeline.getByText("The script was read")).toBeVisible();

  await admin.getByRole("link", { name: "Recorders", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "Recorders", level: 2 })).toBeVisible();

  // Both looks are in the audit log.
  await admin.getByRole("link", { name: "Audit log", exact: true }).click();
  const audit = admin.getByRole("table", { name: "Audit log" });
  await expect(audit.getByRole("link", { name: title })).toBeVisible();
  await expect(audit.getByRole("link", { name: directorEmail })).toBeVisible();
  await context.close();
});
