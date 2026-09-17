import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createDisposableUser } from "./helpers/fixtures";

test("anonymous API access and forged origins are denied independently of pages", async ({
  request,
  baseURL,
}) => {
  const state = await request.get("/api/lifeor/state");
  expect(state.status()).toBe(401);
  const send = await request.post("/api/lifeor/runs/start", {
    headers: { origin: "https://untrusted.example" },
    data: { prompt: "Hi" },
  });
  expect(send.status()).toBe(403);
  const signedOut = await request.post("/api/lifeor/runs/confirm", {
    headers: { origin: baseURL! },
    data: { id: "other", action: "accept" },
  });
  expect(signedOut.status()).toBe(401);
});

test("authenticated workspace supports desktop, mobile, theme and connection states", async ({
  page,
  baseURL,
}) => {
  const hydrationErrors: string[] = [];
  page.on("pageerror", (error) => {
    if (/hydration|server rendered HTML/i.test(error.message))
      hydrationErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|server rendered HTML/i.test(message.text())
    )
      hydrationErrors.push(message.text());
  });
  await page.emulateMedia({ colorScheme: "light" });
  const user = await createDisposableUser();
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: baseURL! },
    data: { email: user.email, password: user.password },
  });
  expect(login.ok()).toBe(true);
  await page.goto("/en/dashboard");
  await expect(
    page.getByRole("heading", { name: "Your life, in context." }),
  ).toBeVisible();
  const state = await page.request.get("/api/lifeor/state");
  expect(state.status()).toBe(200);
  expect((await state.json()).connection).toBeNull();
  await expect(
    page.getByRole("textbox", { name: "Message LifeOR2" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: "qa/test-results/lifeor-desktop.png",
    fullPage: true,
  });
  const desktop = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    desktop.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Toggle light and dark theme" })
    .click();
  await expect(page.locator(".lifeor-workspace").first()).toHaveCSS(
    "background-color",
    "rgb(25, 30, 27)",
  );
  const dark = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    dark.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: "qa/test-results/lifeor-dark.png",
    fullPage: true,
  });
  // A full document navigation must hydrate with the saved dark preference.
  await page.goto("/hu/dashboard");
  const themeToggle = page.getByRole("button", {
    name: "Toggle light and dark theme",
  });
  await expect(themeToggle.locator(".lucide-sun")).toBeVisible();
  await expect(themeToggle.locator(".lucide-moon")).toBeHidden();
  await themeToggle.click();
  await expect(themeToggle.locator(".lucide-moon")).toBeVisible();
  await expect(themeToggle.locator(".lucide-sun")).toBeHidden();
  await page.reload();
  await expect(themeToggle.locator(".lucide-moon")).toBeVisible();
  expect(hydrationErrors).toEqual([]);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole("button", { name: "Open conversation history" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page
    .getByRole("button", { name: "Connect LifeOR2", exact: true })
    .last()
    .click();
  await expect(
    page.getByRole("heading", { name: "Your LifeOR2 connection" }),
  ).toBeVisible();
  await page.getByLabel("Permanently delete records").check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.screenshot({
    path: "qa/test-results/lifeor-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const mobile = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    mobile.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
});

test("chat renders safe content, confirms exact operations and preserves failed drafts", async ({
  page,
  baseURL,
}) => {
  const user = await createDisposableUser();
  expect(
    (
      await page.request.post("/api/auth/sign-in/email", {
        headers: { origin: baseURL! },
        data: { email: user.email, password: user.password },
      })
    ).ok(),
  ).toBe(true);
  const conversation = {
    _id: "conversation-fixture",
    connection: "grant",
    datasetId: "dataset-a",
    datasetName: "Personal",
    title: "Review my records",
    updatedAt: Date.now(),
  };
  const run = {
    _id: "run-fixture",
    conversationId: conversation._id,
    requestId: "send-fixture",
    status: "waiting",
    prompt: "Delete the archived example",
    answer: "",
    events: [
      {
        id: "compact",
        type: "compaction",
        text: "Context compacted from 82% to 55%. Original history is saved.",
      },
    ],
    context: {
      tokens: 9011,
      window: 16384,
      percent: 55,
      outputReserve: 2048,
      estimated: true,
    },
    createdAt: Date.now(),
    confirmation: {
      id: "confirmation-exact",
      message: "Permanently delete Example? This cannot be undone.",
      operation: "trash.permanentlyDelete",
      arguments: JSON.stringify({
        datasetId: "dataset-a",
        target: { id: "example" },
        requestKey: "fixed-request-key",
      }),
      schema: JSON.stringify({
        type: "object",
        properties: { confirmation: { type: "string", title: "Type DELETE" } },
        required: ["confirmation"],
      }),
      expiresAt: Date.now() + 120000,
    },
  };
  const state = {
    connection: {
      identity: "grant",
      status: "connected",
      scopes: ["data:read", "data:write", "data:delete"],
      datasets: [
        { id: "dataset-a", name: "Personal" },
        { id: "dataset-b", name: "Work" },
      ],
    },
    conversations: [conversation],
    runs: [run],
    configured: true,
    server: "lifeor.test",
  };
  await page.route("**/api/lifeor/state*", (route) =>
    route.fulfill({
      json: {
        ...state,
        runs: route.request().url().includes("conversation=") ? state.runs : [],
      },
    }),
  );
  await page.route("**/api/lifeor/stream*", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ run, answer: "", stage: "Waiting for your confirmation" })}\n\n`,
    }),
  );
  await page.route("**/api/lifeor/traffic*", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            id: "sent",
            exchange: "exchange-1",
            channel: "model",
            direction: "request",
            label: "fixture · generate",
            body: JSON.stringify({
              model: "fixture",
              messages: [{ role: "user", content: "Review records" }],
            }),
            at: Date.now(),
            truncated: false,
          },
          {
            id: "received",
            exchange: "exchange-1",
            channel: "model",
            direction: "response",
            label: "Generation · assembled response",
            body: JSON.stringify({ content: "Record reviewed" }),
            at: Date.now(),
            truncated: false,
          },
          {
            id: "summary",
            exchange: "exchange-2",
            channel: "compaction",
            direction: "response",
            label: "Summary · assembled response",
            body: JSON.stringify({ content: "Older records summarized" }),
            at: Date.now(),
            truncated: true,
          },
        ],
        limited: false,
      },
    }),
  );
  let approved = false;
  await page.route("**/api/lifeor/runs/confirm", async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload).toEqual({
      id: "run-fixture",
      confirmationId: "confirmation-exact",
      action: "accept",
      content: { confirmation: "DELETE" },
    });
    approved = true;
    Object.assign(run, {
      status: "completed",
      answer:
        "Removed **Example**.\n\n<script>window.compromised=true</script>\n\n![external](https://invalid.example/track)",
      confirmation: undefined,
    });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/en/dashboard");
  await page
    .getByRole("button", { name: "Review my records Personal" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your confirmation is needed" }),
  ).toBeVisible();
  expect(approved).toBe(false);
  await page.screenshot({
    path: "qa/test-results/lifeor-confirmation.png",
    fullPage: true,
  });
  const confirmationA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    confirmationA11y.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.getByLabel("Type DELETE").fill("DELETE");
  await page.getByRole("button", { name: "Confirm operation" }).click();
  await expect(page.getByText("Removed Example.")).toBeVisible();
  expect(approved).toBe(true);
  await expect(page.getByText("Context ~55%", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Context used" }),
  ).toHaveAttribute("aria-valuenow", "55");
  await expect(page.locator(".compaction-notice")).toContainText(
    "Original history is saved",
  );
  await page.locator(".traffic-inspector > summary").click();
  await page.getByText("fixture · generate", { exact: true }).click();
  await expect(page.getByLabel("request payload")).toContainText(
    "Review records",
  );
  await page.getByLabel("Filter traffic").selectOption("compaction");
  await expect(
    page.getByText("fixture · generate", { exact: true }),
  ).toHaveCount(0);
  await page.getByText("Summary · assembled response", { exact: true }).click();
  await expect(
    page.getByText("Preview truncated at 48,000 bytes."),
  ).toBeVisible();
  await page.getByLabel("response payload").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "qa/test-results/lifeor-context-inspector-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.screenshot({
    path: "qa/test-results/lifeor-context-inspector-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const inspectorA11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    inspectorA11y.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => Object.hasOwn(window, "compromised"))).toBe(
    false,
  );
  await expect(page.locator(".message-markdown img")).toHaveCount(0);
  let compactRequested = false;
  await page.route("**/api/lifeor/runs/compact", (route) => {
    const payload = route.request().postDataJSON();
    expect(payload.conversationId).toBe(conversation._id);
    expect(payload.requestId).toBeTruthy();
    expect(payload.prompt).toBeUndefined();
    compactRequested = true;
    return route.fulfill({ json: { id: "compact-run" } });
  });
  await page.getByRole("button", { name: "Compact now" }).click();
  await expect.poll(() => compactRequested).toBe(true);
  await page
    .getByRole("textbox", { name: "Message LifeOR2" })
    .fill("A draft worth keeping");
  await page.route("**/api/lifeor/runs/start", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "The model service is unavailable." },
    }),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "model service" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message LifeOR2" }),
  ).toHaveValue("A draft worth keeping");
  await page
    .getByLabel("Dataset — changing starts a new conversation")
    .selectOption("dataset-b");
  await expect(
    page.getByRole("heading", { name: "Your life, in context." }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Dataset — changing starts a new conversation"),
  ).toHaveValue("dataset-b");
});
