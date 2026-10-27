import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// Four speeches for two parts, as a Word file: scripts are PDF or .docx only.
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hamlet.docx");

/** YYYY-MM-DD, `days` from today. */
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Signs in as a new director, who lands on setting up their first play. */
async function signInAsDirector(page: Page): Promise<void> {
  await page.goto("/signin");
  await signInHere(page);
}

/** Signs in from the sign-in page with a new email, through the dev sign-in link. */
async function signInHere(page: Page): Promise<void> {
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

test("the marketing pages are real HTML before any script runs, and the app's pages aren't indexed", async ({ browser, request }, testInfo) => {
  const home = await (await request.get("/")).text();
  expect(home).toContain("Run lines with <span");
  expect(home).toContain('<link rel="canonical" href="https://offbooked.com/">');
  expect(home).toContain('<meta property="og:image" content="https://offbooked.com/og.png">');
  expect(home).toContain('"@type":"FAQPage"');
  expect(home).toContain("Do my actors need an account?");
  const pricing = await (await request.get("/pricing")).text();
  expect(pricing).toContain('<link rel="canonical" href="https://offbooked.com/pricing">');
  expect(pricing).toContain("Free tier details coming after beta.");
  expect(await (await request.get("/join/abc")).text()).toContain('<meta name="robots" content="noindex">');
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://offbooked.com/sitemap.xml");
  expect((await request.get("/og.png")).headers()["content-type"]).toBe("image/png");

  const noScript = await browser.newContext({ ...testInfo.project.use, javaScriptEnabled: false });
  const page = await noScript.newPage();
  for (const [path, heading] of [
    ["/", "Run lines with your cast, not a robot."],
    ["/pricing", "Free during public beta."],
    ["/privacy", "Your script, your voices, your cast"],
    ["/terms", "The house rules"],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading!);
  }
  await expect(page.getByText(/We never use them to train AI/)).toBeVisible();
  await noScript.close();
});

test("the landing page's one call to action leads to signing up for the beta", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Run lines with your cast, not a robot.");
  await expect(page.getByText("Share your script with one link. Everyone records their own lines, no account needed.")).toBeVisible();
  await page.getByRole("link", { name: "Try free in public beta" }).first().click();
  await expect(page).toHaveURL(/\/signin$/);
  expect(errors).toEqual([]);
});

test("the landing page's scene demo plays the whole scene, and can pause for your lines", async ({ page }) => {
  await page.goto("/");
  // No synthesized voices in the demo: until the real cast's recording is in, it says so.
  await expect(page.getByText("Real-cast recording coming soon.")).toBeVisible();
  // It opens on "Just listen": one pass through the scene, every line in a castmate's voice.
  await expect(page.getByRole("button", { name: "Just listen" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Play the demo" }).click();
  await expect(page.getByRole("button", { name: "Pause the demo" })).toBeVisible();
  await expect(page.locator(".mk-demo-line.is-current")).toContainText("I have done the deed.");
  await expect(page.locator(".mk-demo-line.is-current")).toContainText("I heard the owl scream", { timeout: 10_000 });
  await expect(page.getByText("Your line · say it now")).toHaveCount(0);

  // "Pause, then read" waits for your own line before it plays.
  await page.getByRole("button", { name: "Pause the demo" }).click();
  await page.getByRole("button", { name: "Pause, then read" }).click();
  await page.getByRole("button", { name: /^Play from LADY MACBETH: I heard/ }).click();
  await expect(page.getByText("Your line · say it now")).toBeVisible();
});

test("the landing page's recording demo records line after line by itself", async ({ page }) => {
  await page.goto("/");
  const recorder = page.locator(".mk-rec");
  await expect(recorder.getByText("0 of 5 recorded")).toBeVisible();
  // It starts by itself once it scrolls into view, and moves from line to line with no taps.
  await page.getByRole("heading", { name: "Hands-free recording." }).scrollIntoViewIfNeeded();
  await recorder.scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Pause the recording demo" })).toBeVisible();
  await expect(recorder.getByText("Recording · hands-free")).toBeVisible();
  await expect(recorder.locator(".mk-rec-line .is-heard").first()).toBeVisible();
  await expect(recorder.getByText("1 of 5 recorded")).toBeVisible({ timeout: 10_000 });
  await expect(recorder.locator(".mk-rec-card.is-current")).toContainText("Now.");
  await expect(recorder.getByText("You're wrapped")).toBeVisible({ timeout: 25_000 });
  await expect(recorder.getByText("5 of 5 recorded")).toBeVisible();
  await page.getByRole("button", { name: "Play the recording demo again" }).click();
  await expect(recorder.getByText("0 of 5 recorded")).toBeVisible();
});

test("the pricing page is free in the beta and shows the founder prices", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveURL(/\/pricing$/);
  await expect(page).toHaveTitle("Pricing · Offbooked");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Free during public beta.");
  const showPass = page.locator(".mk-plan", { has: page.getByRole("heading", { name: "Show Pass" }) });
  await expect(showPass.locator("s")).toHaveText("was C$79");
  await expect(showPass.getByText("C$39")).toBeVisible();
  await expect(page.locator(".mk-plan", { has: page.getByRole("heading", { name: "Season" }) }).locator("s")).toHaveText("was C$249");
  // Nothing can be bought yet: every plan signs up for the beta.
  await showPass.getByRole("link", { name: "Start free in the beta" }).click();
  await expect(page).toHaveURL(/\/signin$/);
  await page.goto("/pricing");
  await page.getByRole("link", { name: "Privacy policy", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page).toHaveTitle("Privacy policy · Offbooked");
});

test("a new director signs up from the homepage's button and sets up a play straight away", async ({ page }) => {
  // Offbooked is in public beta: no access code, nothing between signing in and setting up a play.
  await page.goto("/");
  await page.getByRole("link", { name: "Try free in public beta" }).first().click();
  await signInHere(page);
  await expect(page.getByRole("heading", { name: "What are you putting on?" })).toBeVisible();
  await expect(page.getByLabel("Access code")).toHaveCount(0);
  await createProduction(page, "Macbeth (e2e)");
});

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

test("the run-through plays at the chosen speed, remembered on this device", async ({ page }) => {
  await signInAsDirector(page);
  await createProduction(page, "Hamlet (speed)");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  const controls = page.getByRole("group", { name: "Playback" });
  const speed = controls.getByRole("button", { name: /^Speed: / });
  await expect(speed).toHaveText("1×");
  // A tap steps up; the keyboard works too.
  await speed.click();
  await expect(speed).toHaveText("1.25×");
  await speed.focus();
  await page.keyboard.press("Enter");
  await expect(speed).toHaveText("1.5×");

  const play = controls.getByRole("button", { name: "Play", exact: true });
  await expect(play).toBeEnabled();
  await play.click();
  const rate = () => page.locator("audio").evaluate((a: HTMLAudioElement) => ({ rate: a.playbackRate, pitch: a.preservesPitch }));
  await expect.poll(rate).toEqual({ rate: 1.5, pitch: true });

  // Remembered on this device; a new choice plays from the first line.
  await page.reload();
  await expect(speed).toHaveText("1.5×");
  await speed.click();
  await expect(speed).toHaveText("2×");
  await play.click();
  await expect.poll(rate).toEqual({ rate: 2, pitch: true });
});

test("a take the server won't store stays on the phone through a reload, then goes up by itself", async ({ page, browser }, testInfo) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signInAsDirector(page);
  await createProduction(page, "Hamlet (outage)");
  await page.getByRole("button", { name: "Cast, next step" }).click();
  await page.getByRole("button", { name: "Copy the cast link" }).click();
  const joinUrl = await page.evaluate(() => navigator.clipboard.readText());

  const actor = await browser.newContext({ ...testInfo.project.use, permissions: ["microphone"] });
  // What the cast saw on 2026-10-21: every take upload refused by the server.
  let refusing = true;
  let refused = 0;
  await actor.route("**/api/invite/lines/*/take", async (route) => {
    if (!refusing) return route.fallback();
    refused++;
    await route.fulfill({
      status: 503,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Retry-After": "1" },
      body: JSON.stringify({ error: { code: "storage_unavailable", message: "Offbooked can't store recordings right now." } }),
    });
  });
  const phone = await actor.newPage();
  await phone.goto(joinUrl);
  await phone.getByRole("button", { name: "Skip intro" }).click();
  await phone.getByRole("checkbox", { name: /^HORATIO, 2 lines/i }).check({ force: true });
  await phone.getByLabel("Your name").fill("Riz");
  await phone.getByRole("button", { name: /Start recording/ }).click();
  await expect(phone.getByText("Friends to this ground.").first()).toBeVisible();
  await phone.getByRole("button", { name: "Skip", exact: true }).click();

  // The fake mic plays a steady tone, so the take runs until it's stopped.
  await phone.getByRole("button", { name: "Record line 1" }).click();
  await expect(phone.getByRole("button", { name: "Stop recording" })).toBeVisible();
  await phone.waitForTimeout(1500);
  await phone.getByRole("button", { name: "Stop recording" }).click();

  // Not "Saving…" for ever: the take says where it is and why.
  const kept = phone.getByRole("button", { name: /Not sent yet · on this phone/ });
  await expect(kept).toBeVisible();
  expect(refused).toBeGreaterThan(0);

  // The page crashes or is closed: the take is still on the phone, and can be played back there.
  await phone.reload();
  await expect(kept).toBeVisible();
  await expect(phone.getByRole("button", { name: "Play your take, kept on this device" })).toBeVisible();
  // Listen back has the playback speed beside it.
  const speed = phone.getByRole("button", { name: /^Playback speed: 1×/ });
  await speed.click();
  await expect(phone.getByRole("button", { name: /^Playback speed: 1.25×/ })).toBeVisible();

  // The server is back: the take goes up without the actor doing anything.
  refusing = false;
  await expect(kept).toHaveCount(0, { timeout: 30_000 });
  const token = new URL(phone.url()).pathname.split("/")[2]!;
  const lines = await phone.request.get("http://localhost:8080/api/invite/lines", { headers: { Authorization: `Invite ${token}` } });
  const takes = ((await lines.json()) as { lines: { take: unknown }[] }).lines.filter((l) => l.take);
  expect(takes).toHaveLength(1);
  await actor.close();
});
