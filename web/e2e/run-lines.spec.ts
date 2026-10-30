import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import postgres from "../../backend/node_modules/postgres/src/index.js";

// Two people running lines in a one-act with no scene breaks, MARA speaking at either end: 2 + 2
// lines, 22 lines of others, then 2 more. On a bus with the phone locked, and in bed reading along.
// Picking the part is the only decision: the same plan plays with the screen on and off.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "one-act.docx");

const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const OPENING = ["Who is out there at this hour?", "Only me. Is anyone awake?", "Only the old clock.", "Then I will wait by the door."];
const CLOSING = ["Look, she has come back.", "I never really left.", "Then stay a while.", "Goodnight, all of you.", "Goodnight."];
const MIDDLE = "The snow has not stopped since morning, not once, and this is hour 3.";

/** A director sets up the play, then a cast member claims MARA on this page. Returns their listen link. */
async function castMara(page: Page, title: string): Promise<string> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
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
  await page.getByRole("button", { name: "Cast, next step" }).click();
  await page.getByRole("button", { name: "Copy the cast link" }).click();
  const joinUrl = await page.evaluate(() => navigator.clipboard.readText());

  await page.goto(joinUrl);
  await page.getByRole("button", { name: "Skip intro" }).click();
  await page.getByRole("checkbox", { name: /^MARA,/i }).check({ force: true });
  await page.getByLabel("Your name").fill("Robin");
  await page.getByRole("button", { name: /Start recording/ }).click();
  await expect(page).toHaveURL(/\/i\/[^/]+/);
  return `${new URL(page.url()).pathname.replace(/\/$/, "")}/play`;
}

/** Until the server has built this play's usual tracks: the full read and MARA's default. */
async function prebuilt(title: string): Promise<{ hash: string; storageKey: string }[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, transform: postgres.camel });
  try {
    for (let i = 0; i < 120; i++) {
      const rows = await sql<{ hash: string; storageKey: string }[]>`
        select t.hash, t.storage_key from listen_tracks t join productions p on p.id = t.production_id
        where p.title = ${title} and t.status = 'ready' and t.prebuilt`;
      if (rows.length >= 2) return [...rows];
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("The tracks weren't built ahead");
  } finally {
    await sql.end();
  }
}

interface Probe {
  sources: string[];
  taps: number;
  seen: string[];
  media: Record<string, () => void>;
  hide: () => void;
}

// In every page: counts new sources on the <audio> element and taps, lists each line as it becomes
// current, keeps the lock screen's handlers so a test can press them, and can put the page in the
// state a locked phone leaves it in (hidden, no animation frames).
const instrument = () => {
  const probe: Probe = {
    sources: [],
    taps: 0,
    seen: [],
    media: {},
    hide() {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      window.requestAnimationFrame = () => 0;
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
  (window as unknown as { probe: Probe }).probe = probe;
  const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    ...src,
    set(value: string) {
      // The wake lock's fallback <video> doesn't count.
      if (this instanceof HTMLAudioElement) probe.sources.push(value);
      src.set!.call(this, value);
    },
  });
  addEventListener("pointerdown", () => probe.taps++, true);
  const set = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (action, handler) => {
    if (handler) probe.media[action] = handler as () => void;
    else delete probe.media[action];
    set(action, handler);
  };
  addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      const text = document.querySelector('.lyric[aria-current="true"] .lyric-text')?.textContent ?? "";
      if (text && probe.seen[probe.seen.length - 1] !== text) probe.seen.push(text);
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-current"], childList: true });
  });
};

const fromProbe = (page: Page) =>
  page.evaluate(() => {
    const { sources, taps, seen } = (window as unknown as { probe: Probe }).probe;
    return { sources, taps, seen };
  });

test("on the bus: one tap, the phone locked, and the part plays through from one prebuilt file", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(instrument);
  const title = `One act (bus ${Date.now()})`;
  const play = await castMara(page, title);
  const built = await prebuilt(title);

  const tracks: { status: string; url?: string; items?: { lineId: string }[] }[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/listen-track") && res.request().method() === "POST")
      void res.json().then((body: { track: (typeof tracks)[number] }) => tracks.push(body.track));
  });
  await page.goto(play);
  const controls = page.getByRole("group", { name: "Playback" });
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

  // The first ask finds the track built ahead: the plan here is the plan the server built.
  await expect.poll(() => tracks.length).toBeGreaterThan(0);
  expect(tracks[0]!.status).toBe("ready");
  expect(built.map((b) => b.storageKey.split("/").pop())).toContain(new URL(tracks[0]!.url!).pathname.split("/").pop());
  expect(new Set(tracks[0]!.items!.map((i) => i.lineId)).size).toBe(OPENING.length + CLOSING.length);

  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByText("Ready to play with the screen locked.")).toBeVisible();
  await page.evaluate(() => (window as unknown as { probe: Probe }).probe.hide());

  // Nobody touches the phone again, and it plays to MARA's end of the play.
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeVisible({ timeout: 90_000 });
  const { sources, taps, seen } = await fromProbe(page);
  expect(seen).toEqual([...OPENING, ...CLOSING]);
  expect(taps).toBe(1);
  expect(sources).toEqual([tracks[0]!.url]);
  await expect(page.getByText(/phone stopped the play/)).toHaveCount(0);
});

test("on the bus: the headphones' next and previous are seeks in the one file", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(instrument);
  const title = `One act (headphones ${Date.now()})`;
  const play = await castMara(page, title);
  await prebuilt(title);
  const asked = page.waitForResponse((res) => res.url().endsWith("/listen-track") && res.request().method() === "POST");
  await page.goto(play);
  await asked;
  const controls = page.getByRole("group", { name: "Playback" });
  await expect(page.getByText(/^\d+ lines · /)).toBeVisible();
  await expect(controls.getByRole("button", { name: "Next cue" })).toBeVisible();
  await controls.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByText("Ready to play with the screen locked.")).toBeVisible();
  await page.evaluate(() => (window as unknown as { probe: Probe }).probe.hide());

  const press = (action: string) => page.evaluate((a) => (window as unknown as { probe: Probe }).probe.media[a]!(), action);
  const current = () => page.evaluate(() => document.querySelector('.lyric[aria-current="true"] .lyric-text')?.textContent);

  // The play starts on her first cue, so these are the next three.
  await press("nexttrack");
  await expect.poll(current).toBe(OPENING[2]);
  await press("nexttrack");
  await expect.poll(current).toBe(CLOSING[0]);
  await press("nexttrack");
  await expect.poll(current).toBe(CLOSING[2]);
  // A fluffed line: back to the cue, then within 3 s to the one before.
  await press("previoustrack");
  await expect.poll(current).toBe(CLOSING[2]);
  await press("previoustrack");
  await expect.poll(current).toBe(CLOSING[0]);

  const { sources, taps } = await fromProbe(page);
  expect(taps).toBe(1);
  expect(sources).toHaveLength(1);
});

test("in bed: the script glides from one of my lines to the next, and a stretch left out opens with a tap", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(instrument);
  const title = `One act (bed ${Date.now()})`;
  const play = await castMara(page, title);
  await page.goto(play);
  const controls = page.getByRole("group", { name: "Playback" });
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();

  // No toggle and no extra row of buttons: the part is the only decision.
  const row = page.getByRole("button", { name: "22 lines · Elsa, Doctor" });
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText(MIDDLE)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /skip to/i })).toHaveCount(0);

  await controls.getByRole("button", { name: "Play", exact: true }).click();
  // The page follows across the row: the line playing stays between the pinned row and the bar.
  const inBand = () =>
    page.evaluate(() => {
      const line = document.querySelector('.lyric[aria-current="true"] .lyric-text')?.getBoundingClientRect();
      const top = document.querySelector(".runthrough-bar")!.getBoundingClientRect().bottom;
      const bottom = document.querySelector(".player-controls")!.getBoundingClientRect().top;
      return line ? line.top >= top - 1 && line.bottom <= bottom + 1 : true;
    });
  await expect(page.locator('.lyric[aria-current="true"]')).toContainText(CLOSING[1]!, { timeout: 60_000 });
  await expect.poll(inBand).toBe(true);
  const seen = (await fromProbe(page)).seen;
  expect(seen.slice(0, OPENING.length + 1)).toEqual([...OPENING, CLOSING[0]]);
  expect((await fromProbe(page)).taps).toBe(1);

  // Tap the row to read the stretch; tapping a line in it plays from there.
  await row.click();
  await expect(row).toHaveAttribute("aria-expanded", "true");
  await page.getByText(MIDDLE).click();
  await expect(page.locator('.lyric[aria-current="true"]')).toContainText(MIDDLE);
  await expect(controls.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.getByText(/can't play with the screen locked/)).toHaveCount(0);
  await expect(inBand()).resolves.toBe(true);

  // Paused and reloaded, it picks up there.
  await controls.getByRole("button", { name: "Pause", exact: true }).click();
  await page.reload();
  await expect(page.locator('.lyric[aria-current="true"]')).toContainText(MIDDLE);
  await expect(controls.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
});

test("everything is one option in the mode picker, and just listening stays line by line", async ({ page }) => {
  test.setTimeout(120_000);
  const title = `One act (everything ${Date.now()})`;
  const play = await castMara(page, title);
  await page.goto(play);
  const controls = page.getByRole("group", { name: "Playback" });
  await expect(page.getByRole("button", { name: "22 lines · Elsa, Doctor" })).toBeVisible();

  await page.getByLabel("Your lines").selectOption("all");
  await expect(page.getByRole("button", { name: "22 lines · Elsa, Doctor" })).toHaveCount(0);
  await expect(page.getByText(MIDDLE)).toBeVisible();
  await expect(controls.getByRole("button", { name: "Next cue" })).toBeVisible();

  await page.getByLabel("Your part").selectOption({ label: "Just listening" });
  await expect(controls.getByRole("button", { name: "Next line" })).toBeVisible();
  await expect(page.getByText(MIDDLE)).toBeVisible();
});
