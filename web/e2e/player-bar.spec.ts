import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// The player bar's note ("Getting ready to play with the screen locked…") is part of the bar, so the
// line just above the bar, often the listener's own, is never under it: at 375 px and on desktop.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hamlet.docx");

const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Signs in as a new director, sets up the play from hamlet.docx and opens Listen. */
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

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Scrolls each script line that can get there to just above the player bar, and reports what lies
 * on that line's last row (hit-tested across its width) and where the note and the bar are. The
 * page is left on the last of them.
 */
function linesAboveTheBar(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const bar = document.querySelector(".player-controls")!;
    const note = document.querySelector('.player [role="status"]')!;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const out: { text: string; line: Box; bar: Box; note: Box; covered: string[] }[] = [];
    for (const text of document.querySelectorAll(".lyric-text")) {
      const want = window.scrollY + text.getBoundingClientRect().bottom - (bar.getBoundingClientRect().top - 4);
      if (want < 0 || want > maxScroll) continue;
      window.scrollTo(0, want);
      const line = box(text);
      const y = line.bottom - 6;
      const covered: string[] = [];
      for (const x of [line.left + 8, (line.left + line.right) / 2, line.right - 8]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && !text.closest(".lyric")!.contains(hit)) covered.push(hit.className || hit.tagName);
      }
      out.push({ text: text.textContent ?? "", line, bar: box(bar), note: box(note), covered });
    }
    return out;
  });
}

for (const part of ["Just listening", "HORATIO"]) {
  test(`the screen-lock note sits in the player bar and never covers the line above it (${part})`, async ({ page }, testInfo) => {
    // The phone run checks the narrowest common width.
    if (testInfo.project.name === "phone") await page.setViewportSize({ width: 375, height: 667 });
    // Held on its way, the listen track keeps the longest note up: "Getting ready… Keep the screen on until then."
    await page.route("**/listen-track", () => {});

    await openListen(page, `Hamlet (lock note, ${part})`);
    await page.getByLabel("Your part").selectOption({ label: part });
    const controls = page.getByRole("group", { name: "Playback" });
    // At half speed the short scene plays long enough to look at.
    await controls.getByRole("button", { name: /^Speed / }).click();
    await page.getByRole("dialog", { name: "Playback speed" }).getByRole("button", { name: /^0.5×/ }).click();
    await controls.getByRole("button", { name: "Play", exact: true }).click();

    const note = page.getByText(/^Getting ready to play with the screen locked… Keep the screen on until then\.$/);
    await expect(note).toBeVisible();
    const checked = await linesAboveTheBar(page);
    await page.screenshot({ path: testInfo.outputPath("player-bar.png") });
    await testInfo.attach("player-bar", { path: testInfo.outputPath("player-bar.png"), contentType: "image/png" });

    expect(checked.length, "some line can be scrolled to just above the bar").toBeGreaterThan(0);
    for (const c of checked) {
      // The note is inside the bar, so the band above the bar is all script.
      expect(c.note.top, `note inside the bar while "${c.text}" is above it`).toBeGreaterThanOrEqual(c.bar.top);
      expect(c.note.bottom).toBeLessThanOrEqual(c.bar.bottom);
      expect(c.note.top).toBeGreaterThanOrEqual(c.line.bottom);
      expect(c.covered, `nothing over "${c.text}"`).toEqual([]);
    }

    // Scrolled away by hand: "Back to current line" floats above the taller bar, not over its note.
    await page.evaluate(() => window.dispatchEvent(new WheelEvent("wheel")));
    const back = page.getByRole("button", { name: "Back to current line" });
    await expect(back).toBeVisible();
    const backBox = (await back.boundingBox())!;
    const barBox = (await page.locator(".player-controls").boundingBox())!;
    expect(backBox.y + backBox.height).toBeLessThanOrEqual(barBox.y);
  });
}
