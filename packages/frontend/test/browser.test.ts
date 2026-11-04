import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const browserExecutable = await findBrowser();

test("the application shell keeps agent instructions in visible body text", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  assert.match(html, /\[data-agent-handoff\][^{]*\{[^}]*font-size:\s*0/su);
  assert.match(html, /href="\/theme\.css"/u);
  assert.doesNotMatch(html, /href="\/fonts\.css"/u);
  const body = /<body[^>]*>([\s\S]*?)<\/body>/u.exec(html)?.[1];
  assert.ok(body);
  const visibleText = body
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ");

  assert.match(visibleText, /INKLING AGENT HANDOFF/u);
  assert.match(visibleText, /do not summarize this application shell/u);
  assert.match(visibleText, /\/mcp/u);
  assert.match(visibleText, /Agent access/u);
  assert.doesNotMatch(html, /AGENTS\.md/u);
  assert.match(visibleText, /read_document/u);
});

test(
  "browser pages read, collaborate, comment, preview, and honor share revocation",
  // One long end-to-end session: about 25 seconds locally, but GitHub runners take twice that.
  { skip: browserExecutable === undefined, timeout: 180_000 },
  async () => {
    assert.ok(browserExecutable);
    const directory = await mkdtemp(path.join(tmpdir(), "inkling-browser-"));
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const google = await startGoogleOAuthMock();
    const server = spawn("node", ["../runtime-node/src/main.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        GOOGLE_ADMIN_EMAILS: "browser@example.com",
        GOOGLE_ALLOWED_DOMAINS: "example.com",
        GOOGLE_CLIENT_ID: "inkling-browser-client",
        GOOGLE_CLIENT_SECRET: "inkling-browser-secret",
        GOOGLE_REDIRECT_URI: `${baseUrl}/api/auth/google/callback`,
        INKLING_DATA_DIR: directory,
        INKLING_GOOGLE_AUTHORIZATION_ENDPOINT: `${google.origin}/authorize`,
        INKLING_GOOGLE_CERTIFICATES_ENDPOINT: `${google.origin}/certificates`,
        INKLING_GOOGLE_TOKEN_ENDPOINT: `${google.origin}/token`,
        INKLING_OAUTH_STATE_SECRET: "inkling-browser-state-secret",
        PORT: String(port),
      },
      stdio: "ignore",
    });
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    try {
      await waitForServer(baseUrl);
      const context = await browser.newContext();
      const first = await context.newPage();
      await first.goto(baseUrl);
      await first.waitForSelector("[data-public-catalog]");
      assert.equal(
        await first.locator("[data-workspace-heading] p").textContent(),
        "Public archive / published revisions",
      );
      assert.match(
        (await first.locator("[data-empty-state]").textContent()) ?? "",
        /No public revisions have been published yet/u,
      );
      await first.getByRole("link", { name: "Sign in" }).click();
      await first.waitForSelector("[data-new-document]");
      await first.waitForSelector("main[data-workspace-layout]:not([data-public-catalog])");
      assert.equal(await first.title(), "Inkling");
      assert.equal(await first.locator("[data-workspace-heading] > div > p").count(), 0);
      assert.equal(await first.locator("[data-workspace-heading] h1").textContent(), "Inkling");
      assert.equal(
        await first.getByRole("link", { name: "Inkling home" }).textContent(),
        "Inkling",
      );
      assert.equal(await first.locator("[data-account-name]").textContent(), "Browser Admin");
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      assert.equal(await first.locator("[data-catalog-tools] [data-logout]").count(), 0);
      assert.deepEqual(await first.locator("[data-catalog-tool-links] a").allTextContents(), [
        "Browse labels",
        "Trash",
      ]);
      assert.equal(await first.locator("[data-account-menu]").isVisible(), false);
      await first.locator("[data-account-trigger]").click();
      await first.locator("[data-account-menu]").waitFor();
      assert.deepEqual(
        await first.locator('[data-account-menu] [role="menuitem"]').allTextContents(),
        ["Agent access", "API keys", "Sign out"],
      );
      await first.locator("[data-open-agent-access]").click();
      assert.equal(
        await first.locator("[data-agent-access-dialog] h2").textContent(),
        "Agent access",
      );
      assert.deepEqual(await first.getByRole("tab").allTextContents(), [
        "Pi",
        "Claude Code",
        "Codex",
      ]);
      assert.deepEqual(
        await first.locator("[data-agent-setup='pi'] [data-agent-command]").allTextContents(),
        [`pi mcp add inkling --url ${baseUrl}/mcp`, "pi mcp login inkling"],
      );
      await first.getByRole("tab", { name: "Codex" }).click();
      assert.deepEqual(
        await first.locator("[data-agent-setup='codex'] [data-agent-command]").allTextContents(),
        [`codex mcp add inkling --url ${baseUrl}/mcp`, "codex mcp login inkling"],
      );
      await first.locator("[data-agent-access-api-keys]").click();
      assert.equal(await first.locator("[data-agent-access-dialog]").count(), 0);
      assert.equal(await first.locator("[data-settings-dialog] [data-dialog-eyebrow]").count(), 0);
      assert.equal(await first.locator("[data-settings-dialog] h2").textContent(), "API keys");
      assert.match(
        (await first.locator("[data-settings-note]").textContent()) ?? "",
        /act with your permissions/u,
      );
      await first.getByLabel("Key name").fill("Browser agent");
      await first.getByRole("button", { name: "Create API key" }).click();
      const revealedKey = (await first.locator("[data-api-key-secret]").textContent()) ?? "";
      assert.match(revealedKey, /^key_[0-9A-Za-z]+\./u);
      assert.equal(await first.locator("[data-copy-api-key]").textContent(), "Copy API key");
      assert.equal(await first.getByRole("button", { name: "Create another key" }).count(), 1);
      await first.getByLabel("Close API keys").click();

      await first.locator("[data-account-trigger]").click();
      await first.locator("[data-open-api-keys]").click();
      assert.equal(await first.locator("[data-api-key-secret]").count(), 0);
      await first.locator("[data-show-api-key]").click();
      assert.equal((await first.locator("[data-api-key-secret]").textContent()) ?? "", revealedKey);
      await first.getByLabel("Close API keys").click();

      // MCP OAuth in a real browser: the person arrives from another site, so
      // the Strict session cookie is withheld until Inkling's own bounce, and
      // the approval POST carries a browser-generated Origin header.
      const clientRedirect = "http://127.0.0.1:9/callback";
      const registration = await fetch(`${baseUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Browser MCP client",
          redirect_uris: [clientRedirect],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registration.status, 201);
      const { client_id: clientId } = (await registration.json()) as { client_id: string };
      const codeVerifier = "browser-oauth-verifier-0123456789-abcdefghijklmnop";
      const authorizeUrl = `${baseUrl}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
        code_challenge_method: "S256",
        redirect_uri: clientRedirect,
        response_type: "code",
        state: "browser-state",
      })}`;
      const consent = await context.newPage();
      const signInRequests: string[] = [];
      consent.on("request", (request) => {
        if (request.url().includes("/api/auth/google/start")) signInRequests.push(request.url());
      });
      let clientCallback: URL | undefined;
      await consent.route("http://127.0.0.1:9/**", (route) => {
        clientCallback = new URL(route.request().url());
        return route.fulfill({ body: "connected", contentType: "text/plain" });
      });
      await consent.route("https://client.example/**", (route) =>
        route.fulfill({ body: "<!doctype html><title>Client</title>", contentType: "text/html" }),
      );
      await consent.goto("https://client.example/connect");
      await consent.evaluate((href) => {
        location.href = href;
      }, authorizeUrl);
      await consent.getByRole("button", { name: "Allow access" }).waitFor();
      assert.match(
        (await consent.locator("h1").textContent()) ?? "",
        /Connect Browser MCP client to Inkling\?/u,
      );
      await consent.getByRole("button", { name: "Allow access" }).click();
      await consent.waitForURL(/^http:\/\/127\.0\.0\.1:9\/callback/u);
      assert.deepEqual(signInRequests, []);
      assert.ok(clientCallback);
      assert.equal(clientCallback.searchParams.get("state"), "browser-state");
      const issuedToken = await fetch(`${baseUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: clientId,
          code: clientCallback.searchParams.get("code") ?? "",
          code_verifier: codeVerifier,
          grant_type: "authorization_code",
          redirect_uri: clientRedirect,
        }),
        method: "POST",
      });
      assert.equal(issuedToken.status, 200);
      await consent.close();
      await first.locator("[data-account-trigger]").click();
      await first.locator("[data-open-api-keys]").click();
      assert.match(
        (await first.locator("[data-oauth-key]").textContent()) ?? "",
        /Connected by signing in from Browser MCP client/u,
      );
      await first.getByLabel("Close API keys").click();

      const initialScheme = await first.locator("html").getAttribute("data-color-scheme");
      await first.locator("[data-theme-toggle]").dblclick();
      assert.notEqual(await first.locator("html").getAttribute("data-color-scheme"), initialScheme);
      await first.locator("[data-new-document]").click();
      await first.locator('input[name="title"]').fill("Browser collaboration");
      assert.equal(await first.locator('textarea[name="body"]').count(), 0);
      assert.equal(await first.locator('input[name="rfc"]').isChecked(), false);
      await first
        .locator("[data-new-form]")
        .evaluate((form: HTMLFormElement) =>
          form.requestSubmit(form.querySelector('button[type="submit"]')),
        );
      await first.waitForURL(/\/documents\/[^/]+\/edit$/u);
      const documentId = first.url().split("/").at(-2);
      assert.ok(documentId);
      assert.match(documentId, /^doc_[0-9A-Za-z]+$/u);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      assert.equal(await first.title(), "Browser collaboration");
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "Notes",
        "Browser collaboration",
        "Edit",
      ]);
      const titleLine = first.locator(".cm-line").filter({ hasText: "# Browser collaboration" });
      await titleLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.press("Tab");
      assert.match((await titleLine.textContent()) ?? "", /^\s+# Browser collaboration$/u);
      await first.keyboard.press("Shift+Tab");
      assert.equal(await titleLine.textContent(), "# Browser collaboration");
      await first.keyboard.insertText("# Temporary browser title");
      await first.waitForFunction(() => document.title === "Temporary browser title");
      await first.waitForFunction(
        () =>
          document.querySelectorAll("[data-breadcrumb]")[2]?.textContent ===
          "Temporary browser title",
      );
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "Notes",
        "Temporary browser title",
        "Edit",
      ]);
      const temporaryTitleLine = first
        .locator(".cm-line")
        .filter({ hasText: "# Temporary browser title" });
      await temporaryTitleLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("# Browser collaboration");
      await first.waitForFunction(() => document.title === "Browser collaboration");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      assert.equal(await first.locator("[data-api-status]").textContent(), "Saved");
      await titleLine.click();
      await first.keyboard.press("End");
      await first.keyboard.insertText("\n\nb");
      await first.waitForFunction(
        () => document.querySelector("[data-preview]")?.textContent?.trim() === "b",
      );
      await first.keyboard.press("Backspace");
      await first.waitForFunction(
        () => document.querySelector("[data-preview]")?.textContent === "",
      );
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      assert.match(
        await first.locator(".cm-content").innerText(),
        /---\s+authors:\s+- browser@example\.com\s+state: draft\s+visibility: private\s+labels: \[\]\s+---/u,
      );

      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      await first.keyboard.insertText("\n\nHistory highlight target");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      const historyTargetLine = first.locator(".cm-line", {
        hasText: "History highlight target",
      });
      await historyTargetLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("History restore marker");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.locator("[data-history-toggle]").click();
      await first.waitForSelector("[data-history-dropdown]");
      const historySlider = first.locator("[data-history-slider]");
      const previousHistoryIndex = Number(await historySlider.getAttribute("max")) - 1;
      assert.ok(previousHistoryIndex > 0);
      await historySlider.fill(String(previousHistoryIndex));
      const selectedHistoryRevision = await first
        .locator("[data-history-revision]")
        .getAttribute("data-history-revision");
      assert.ok(selectedHistoryRevision !== null);
      await first.waitForFunction(
        (revision) =>
          document.querySelector("[data-preview-pane] [data-pane-label] span")?.textContent ===
          `Revision ${revision}`,
        selectedHistoryRevision,
      );
      await first.waitForFunction(
        () =>
          !document
            .querySelector("[data-preview]")
            ?.textContent?.includes("History restore marker"),
      );
      await first.waitForFunction(
        (revision) =>
          document.querySelector("[data-source-pane] [data-pane-label] span")?.textContent ===
          `Revision ${revision} · Markdown`,
        selectedHistoryRevision,
      );
      await Promise.all([
        first.locator("[data-history-editor] [data-history-change]").first().waitFor(),
        first.locator("[data-preview] [data-history-change]").first().waitFor(),
      ]);
      assert.match(await first.locator("[data-preview]").innerText(), /History highlight target/u);
      await first.waitForFunction(
        () => document.querySelectorAll("[data-history-change]").length === 0,
      );
      assert.doesNotMatch(
        await first.locator("[data-history-editor] .cm-content").innerText(),
        /History restore marker/u,
      );
      assert.match(
        await first.locator("[data-live-editor] .cm-content").innerText(),
        /History restore marker/u,
      );
      assert.equal(
        await first.locator("[data-preview]").evaluate((preview) => {
          return getComputedStyle(preview).paddingTop;
        }),
        "0px",
      );
      await first.locator("[data-restore-history]").click();
      await first
        .locator("[data-confirmation-dialog]")
        .getByRole("button", { name: "Restore version" })
        .click();
      await first.locator("[data-history-dropdown]").waitFor({ state: "hidden" });
      await first.waitForFunction(
        () =>
          !document
            .querySelector("[data-editor] .cm-content")
            ?.textContent?.includes("History restore marker"),
      );
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      const restoredHistoryTarget = first.locator(".cm-line", {
        hasText: "History highlight target",
      });
      await restoredHistoryTarget.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.press("Backspace");
      await first.waitForFunction(
        () =>
          !document
            .querySelector("[data-preview]")
            ?.textContent?.includes("History highlight target"),
      );
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );

      const draftStateChip = first.locator("[data-preview-scroller] [data-lifecycle-state]");
      await draftStateChip.waitFor();
      assert.equal(await draftStateChip.getAttribute("data-lifecycle-state"), "draft");
      const draftStateBackground = await draftStateChip.evaluate(
        (chip) => getComputedStyle(chip).backgroundColor,
      );
      const stateLine = first.locator(".cm-line").filter({ hasText: "state: draft" });
      await stateLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("state: a");
      await first.waitForSelector(".cm-tooltip-autocomplete");
      const stateCompletions = await first.locator(".cm-completionLabel").allTextContents();
      assert.ok(stateCompletions.includes("accepted"));
      assert.ok(stateCompletions.includes("abandoned"));
      await first.keyboard.press("Escape");
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("state: accepted");
      const acceptedStateChip = first.locator(
        '[data-preview-scroller] [data-lifecycle-state="accepted"]',
      );
      await acceptedStateChip.waitFor();
      assert.notEqual(
        await acceptedStateChip.evaluate((chip) => getComputedStyle(chip).backgroundColor),
        draftStateBackground,
      );
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("state: draft");
      assert.equal(await first.locator("[data-document-details]").count(), 0);
      await first.locator("[data-allocate-rfc]").click();
      await first.waitForURL(/\/rfc\/0001\/edit$/u);
      await first.waitForFunction(
        () =>
          document.querySelectorAll("[data-breadcrumb]")[2]?.textContent ===
          "0001 - Browser collaboration",
      );
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "RFCs",
        "0001 - Browser collaboration",
        "Edit",
      ]);
      assert.equal(await first.locator("[data-allocate-rfc]").count(), 0);
      const labelsLine = first.locator(".cm-line").filter({ hasText: "labels: []" });
      await labelsLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("labels: [] invalid");
      await first.waitForTimeout(100);
      assert.equal(await first.locator('[data-toasts] [data-toast="error"]').count(), 0);
      assert.equal(
        await first.locator("[data-preview-scroller] [data-document-page] h1").textContent(),
        "Browser collaboration",
      );
      const invalidLabelsLine = first.locator(".cm-line").filter({ hasText: "labels: [] invalid" });
      await invalidLabelsLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("labels:\n  - architecture\n  - platform");
      assert.equal(
        await first.locator("[data-preview-scroller] [data-document-page] h1").textContent(),
        "Browser collaboration",
      );
      assert.match(
        await first.locator("[data-preview-scroller] [data-document-metadata]").innerText(),
        /Authors:?\s+Browser Admin[\s\S]+Created[\s\S]+Updated/iu,
      );
      assert.equal(
        await first
          .locator('[data-preview-scroller] a[href="/labels?label=platform"]')
          .textContent(),
        "platform",
      );
      // Typed edits reach the catalog through a throttled projection.
      await waitUntil(() =>
        first.evaluate(async () => {
          const response = await fetch(`/api/documents?q=${encodeURIComponent("label:platform")}`);
          const catalog = (await response.json()) as {
            documents: readonly { metadata: { title: string } }[];
          };
          return catalog.documents.some(
            (document) => document.metadata.title === "Browser collaboration",
          );
        }),
      );
      await first.getByRole("link", { name: "Inkling home" }).click();
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.title(), "Inkling");
      await first.getByRole("link", { name: "Browse labels" }).click();
      await first.getByRole("link", { name: /platform/u }).click();
      const workingLabelRow = first.locator("[data-catalog-document-id]", {
        hasText: "Browser collaboration",
      });
      assert.equal(await workingLabelRow.locator("[data-catalog-folio]").textContent(), "RFC 0001");
      assert.equal(
        await workingLabelRow.locator("[data-catalog-visibility]").textContent(),
        "private",
      );
      assert.notEqual(
        await workingLabelRow.evaluate((row) => getComputedStyle(row).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      const visibilityBackgrounds = await first.evaluate(() =>
        ["public", "private", "confidential"].map((visibility) => {
          const source = document.querySelector<HTMLElement>("[data-catalog-document-id]");
          if (source === null) throw new Error("Missing catalog row");
          const row = document.createElement("a");
          row.className = source.className;
          row.dataset.documentVisibility = visibility;
          document.body.append(row);
          const background = getComputedStyle(row).backgroundColor;
          row.remove();
          return background;
        }),
      );
      assert.equal(new Set(visibilityBackgrounds).size, 3);
      assert.equal(
        await workingLabelRow.locator("[data-pending-edits]").textContent(),
        "Pending edits",
      );
      await workingLabelRow.click();
      await first.waitForSelector("[data-unpublished]");
      assert.equal(await first.title(), "Browser collaboration");
      assert.doesNotMatch(await first.locator("[data-reader]").innerText(), /architecture/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      await first.keyboard.insertText(
        "\nShared starting body\n\n## Architecture\n\nSecond line\n\n```ts\nconst answer: number = 42;\n```\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nnot a mermaid diagram\n```\n\nThird line\n\n## Delivery\n\nFourth line",
      );
      await first.waitForSelector(".cm-content .tok-keyword");
      await first.waitForSelector("[data-preview] .tok-keyword");
      await first.waitForSelector("[data-preview] [data-mermaid] .mermaid-viewport");
      await first.waitForSelector("[data-preview] [data-mermaid-error]");
      assert.match(
        await first.locator("[data-preview] [data-mermaid-error]").innerText(),
        /not a mermaid diagram/u,
      );
      assert.equal(await first.locator('body > div[id^="dinkling-mermaid-"]').count(), 0);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      const editorKeyword = first.locator(".cm-content .tok-keyword").last();
      assert.equal(await editorKeyword.textContent(), "const");
      const editorKeywordClass = await editorKeyword.getAttribute("class");
      const visibilityLine = first.locator(".cm-line", { hasText: "visibility: private" });
      await visibilityLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("visibility: publi");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Fix frontmatter",
      );
      assert.equal(await first.locator("[data-publish]").isDisabled(), true);
      await first.locator(".cm-line", { hasText: "visibility: publi" }).click();
      await first.keyboard.press("End");
      await first.keyboard.insertText("c");
      await first.waitForFunction(
        () =>
          document.querySelector('[data-document-visibility="public"]')?.textContent === "public",
      );
      assert.equal(await first.locator("[data-publish]").textContent(), "Publish");
      assert.equal(await first.locator("[data-publish]").isEnabled(), true);
      const publication = first.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/publish"),
      );
      await first.locator("[data-publish]").click();
      assert.equal((await publication).status(), 200);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Publish",
      );
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      await first.keyboard.insertText("\n\nPublished follow-up");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Publish Changes",
      );
      const documentActionLabels = await first
        .locator("[data-document-actions] > a, [data-document-actions] > button")
        .allTextContents();
      const shareActionIndex = documentActionLabels.indexOf("Share");
      assert.deepEqual(documentActionLabels.slice(shareActionIndex, shareActionIndex + 3), [
        "Share",
        "View",
        "Publish Changes",
      ]);
      await first.getByRole("link", { name: "View" }).click();
      await first.waitForSelector("[data-reader]");
      assert.doesNotMatch(await first.locator("[data-reader]").innerText(), /Published follow-up/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      const changedPublication = first.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/publish"),
      );
      await first.locator("[data-publish]").click();
      assert.equal((await changedPublication).status(), 200);
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Publish",
      );
      await first.evaluate(() => {
        document.documentElement.dataset["browserNavigation"] = "same-document";
      });
      await first.getByRole("link", { name: "View" }).click();
      await first.waitForURL(/\/rfc\/0001$/u);
      assert.equal(
        await first.locator("html").getAttribute("data-browser-navigation"),
        "same-document",
      );
      await first.waitForSelector("[data-reader]");
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "RFCs",
        "0001 - Browser collaboration",
      ]);
      await first.waitForSelector("[data-reader-toc]");
      assert.match(
        await first.locator("[data-reader] [data-document-metadata]").innerText(),
        /Authors:?\s+Browser Admin[\s\S]+Created[\s\S]+Updated/iu,
      );
      assert.equal(
        await first.getByRole("navigation", { name: "On this page" }).locator("p").textContent(),
        "On this page",
      );
      const readerToc = first.getByRole("navigation", { name: "On this page" });
      const architectureTocLink = readerToc.getByRole("link", { name: "Architecture" });
      const deliveryTocLink = readerToc.getByRole("link", { name: "Delivery" });
      assert.equal(await architectureTocLink.getAttribute("href"), "#architecture");
      assert.equal(await architectureTocLink.getAttribute("aria-current"), "location");
      assert.equal(await architectureTocLink.getAttribute("data-active"), "");
      await first.locator("#delivery").evaluate((heading) => heading.scrollIntoView());
      await first.waitForFunction(
        () =>
          document
            .querySelector('[data-reader-toc] a[href="#delivery"]')
            ?.getAttribute("aria-current") === "location",
      );
      assert.equal(await architectureTocLink.getAttribute("aria-current"), null);
      assert.equal(await deliveryTocLink.getAttribute("aria-current"), "location");
      // Jumping between sections only moves the fragment; it must not reload the route.
      const fragmentRequests: string[] = [];
      const recordFragmentRequest = (request: { url: () => string }): void => {
        if (new URL(request.url()).pathname.startsWith("/api/")) {
          fragmentRequests.push(request.url());
        }
      };
      first.on("request", recordFragmentRequest);
      await deliveryTocLink.click();
      await first.waitForURL(/#delivery$/u);
      await architectureTocLink.click();
      await first.waitForURL(/#architecture$/u);
      await first.waitForFunction(
        () =>
          document
            .querySelector('[data-reader-toc] a[href="#architecture"]')
            ?.getAttribute("aria-current") === "location",
      );
      await first.goBack();
      await first.waitForURL(/#delivery$/u);
      first.off("request", recordFragmentRequest);
      assert.deepEqual(fragmentRequests, []);
      // Narrow pages collapse the table of contents into a menu. Opening it while scrolled moves
      // focus into the list, which must not scroll the page and close the menu again.
      await first.setViewportSize({ height: 400, width: 800 });
      const readerMenuTrigger = first.locator("[data-reader-toc] button");
      await readerMenuTrigger.waitFor();
      const nextFrames = (): Promise<unknown> =>
        first.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      await first.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await nextFrames();
      const scrolledTo = await first.evaluate(() => window.scrollY);
      assert.ok(scrolledTo > 0);
      // Click where the stuck bar is; Playwright's own scrolling into view would close the menu.
      const triggerBox = await readerMenuTrigger.boundingBox();
      assert.ok(triggerBox);
      await first.mouse.click(triggerBox.x + 20, triggerBox.y + triggerBox.height / 2);
      await first.waitForFunction(
        () => document.activeElement?.closest('[role="dialog"]') instanceof HTMLElement,
      );
      await nextFrames();
      assert.equal(await first.evaluate(() => window.scrollY), scrolledTo);
      assert.equal(await readerMenuTrigger.getAttribute("aria-expanded"), "true");
      await first.getByRole("dialog").getByRole("link", { name: "Architecture" }).click();
      await first.waitForURL(/#architecture$/u);
      await first.setViewportSize({ height: 720, width: 1280 });
      await first.evaluate(() => window.scrollTo(0, 0));
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      assert.equal(await first.locator(".cm-editor").count(), 0);
      assert.match(await first.locator("[data-preview]").innerText(), /Shared starting body/u);
      await first.waitForSelector("[data-preview] .tok-keyword");
      await first.waitForSelector("[data-preview] [data-mermaid-error]");
      assert.equal(await first.locator('body > div[id^="dinkling-mermaid-"]').count(), 0);
      const renderedKeyword = first.locator("[data-preview] .tok-keyword");
      assert.equal(await renderedKeyword.textContent(), "const");
      assert.equal(await renderedKeyword.getAttribute("class"), editorKeywordClass);
      assert.equal(await first.getByRole("link", { name: "Back" }).count(), 0);
      const readerState = first.locator("[data-reader] [data-lifecycle-state]");
      assert.equal(await readerState.getAttribute("href"), "/?q=state%3Adraft");
      await readerState.click();
      await first.waitForURL(/\?q=state%3Adraft$/u);
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.locator("[data-search]").inputValue(), "state:draft");
      await first.getByRole("link", { name: "Browse labels" }).click();
      await first.waitForURL(/\/labels$/u);
      await first.waitForSelector("[data-label-index]");
      assert.equal(await first.locator("[data-workspace-heading] h1").textContent(), "Labels");
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "Labels",
      ]);
      assert.equal(await first.locator("[data-workspace-heading] p").count(), 0);
      await first.getByRole("link", { name: /platform/u }).click();
      assert.equal(new URL(first.url()).searchParams.get("label"), "platform");
      await first.waitForFunction(
        () => document.querySelectorAll("[data-breadcrumb]")[2]?.textContent === "platform",
      );
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "Labels",
        "platform",
      ]);
      assert.match(await first.locator("[data-catalog]").innerText(), /Browser collaboration/u);
      assert.equal(await first.locator("[data-pending-edits]").count(), 0);
      await first.getByRole("link", { name: "All documents" }).click();
      await first.waitForSelector("[data-document-search]");
      await first.locator("[data-new-document]").click();
      await first.locator('input[name="title"]').fill("Keyboard selection target");
      await first
        .locator("[data-new-form]")
        .evaluate((form: HTMLFormElement) =>
          form.requestSubmit(form.querySelector('button[type="submit"]')),
        );
      await first.waitForURL(/\/documents\/[^/]+\/edit$/u);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.getByRole("link", { name: "Inkling home" }).click();
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 2);
      await first.locator("[data-catalog-document-id]").first().hover();
      assert.equal(
        await first.locator("[data-catalog-document-id][data-catalog-selected]").count(),
        0,
      );
      await first.keyboard.press("j");
      const firstKeyboardSelection = await first
        .locator("[data-catalog-document-id][data-catalog-selected]")
        .innerText();
      await first.keyboard.press("j");
      const secondKeyboardSelection = await first
        .locator("[data-catalog-document-id][data-catalog-selected]")
        .innerText();
      assert.notEqual(secondKeyboardSelection, firstKeyboardSelection);
      await first.keyboard.press("k");
      assert.equal(
        await first.locator("[data-catalog-document-id][data-catalog-selected]").innerText(),
        firstKeyboardSelection,
      );
      await first.keyboard.press("/");
      const documentSearch = first.locator("[data-search]");
      assert.equal(
        await documentSearch.evaluate((input) => input === document.activeElement),
        true,
      );
      await documentSearch.fill("author:me");
      await first.waitForSelector("[data-search-completions]");
      const currentAuthorCompletion = first.locator("[data-search-completions] button").first();
      assert.equal(await currentAuthorCompletion.locator("code").textContent(), "author:me");
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 2);
      await documentSearch.press("Enter");
      assert.equal(await first.locator("[data-search-panel]").count(), 0);
      assert.equal(await documentSearch.inputValue(), "author:me");
      assert.deepEqual(
        await documentSearch.evaluate((input) => [input.selectionStart, input.selectionEnd]),
        [9, 9],
      );
      await first.getByRole("link", { name: "Inkling home" }).click();
      await first.waitForFunction(
        () =>
          new URL(location.href).searchParams.get("q") === null &&
          document.querySelector<HTMLInputElement>("[data-search]")?.value === "" &&
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 2);
      await documentSearch.fill("author:browser@");
      await documentSearch.press("Tab");
      assert.equal(await documentSearch.inputValue(), "author:browser@example.com ");
      assert.deepEqual(
        await documentSearch.evaluate((input) => [input.selectionStart, input.selectionEnd]),
        [27, 27],
      );
      await documentSearch.fill("lab");
      await first.waitForSelector("[data-search-completions]");
      assert.equal(
        await first.locator("[data-search-completions] code").first().textContent(),
        "label:",
      );
      await documentSearch.press("Enter");
      assert.equal(await first.locator("[data-search-panel]").count(), 0);
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.match(await first.locator("[data-catalog]").innerText(), /Browser collaboration/u);
      assert.equal(await first.locator("[data-search-result]").count(), 0);
      await documentSearch.fill("rfc:1 answer");
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 1);
      assert.match(
        await first.locator("[data-catalog-document-id]").innerText(),
        /Browser collaboration/u,
      );
      assert.match(await first.locator("[data-catalog-document-id]").innerText(), /answer/u);
      assert.equal(new URL(first.url()).searchParams.get("q"), "rfc:1 answer");
      await first.route("**/api/documents?q=*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("q") === 'rfc:1 "answer"') {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        await route.continue();
      });
      await documentSearch.fill('rfc:1 "answer"');
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "true",
      );
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 1);
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator("[data-catalog-document-id]").count(), 1);
      await documentSearch.press("ArrowDown");
      assert.equal(
        await first.locator("[data-catalog-document-id][data-catalog-selected]").count(),
        1,
      );
      await documentSearch.press("Enter");
      await first.waitForURL(/\/rfc\/0001$/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForURL(/\/rfc\/0001\/edit$/u);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      assert.equal(await first.locator("[data-api-status]").textContent(), "Saved");
      assert.equal(
        await first.locator("[data-source-pane] [data-pane-label] span").first().textContent(),
        "Markdown",
      );
      await first.waitForSelector(".cm-content .tok-keyword");
      const typography = await first.evaluate(() => {
        const editor = document.querySelector<HTMLElement>(".cm-scroller");
        const code = document.querySelector<HTMLElement>("[data-preview] pre");
        const markdownBody = document.querySelector<HTMLElement>("article[data-preview]");
        const heading2 = markdownBody?.querySelector<HTMLElement>("h2");
        if (editor === null) throw new Error("Editor scroller is missing.");
        if (code === null) throw new Error("Preview code block is missing.");
        if (markdownBody === null || heading2 === null) throw new Error("Preview body is missing.");
        const heading1 = document.createElement("h1");
        markdownBody.append(heading1);
        const heading1Size = Number.parseFloat(getComputedStyle(heading1).fontSize);
        heading1.remove();
        return {
          code: getComputedStyle(code).fontFamily,
          editor: getComputedStyle(editor).fontFamily,
          heading1: heading1Size,
          heading2: Number.parseFloat(getComputedStyle(heading2).fontSize),
          prose: getComputedStyle(document.body).fontFamily,
        };
      });
      assert.match(typography.prose, /Mallos Serif/u);
      assert.match(typography.editor, /Commit Mono/u);
      assert.equal(typography.code, typography.editor);
      assert.ok(typography.heading1 > typography.heading2);
      assert.ok(typography.heading1 <= 36);
      const editorAppearance = await first.evaluate(async () => {
        const editor = document.querySelector<HTMLElement>(".cm-editor");
        const content = document.querySelector<HTMLElement>(".cm-content");
        const gutter = document.querySelector<HTMLElement>(".cm-gutters");
        const activeLine = document.querySelector<HTMLElement>(".cm-activeLine");
        const keyword = document.querySelector<HTMLElement>(".cm-content .tok-keyword");
        if (
          editor === null ||
          content === null ||
          gutter === null ||
          activeLine === null ||
          keyword === null
        ) {
          throw new Error("Editor appearance elements are missing.");
        }
        const originalScheme = document.documentElement.dataset["colorScheme"];
        const canvasContext = document.createElement("canvas").getContext("2d");
        if (canvasContext === null) throw new Error("Canvas is unavailable.");
        const brightness = (color: string): number => {
          canvasContext.fillStyle = color;
          canvasContext.fillRect(0, 0, 1, 1);
          const [red = 0, green = 0, blue = 0] = canvasContext.getImageData(0, 0, 1, 1).data;
          return red + green + blue;
        };
        const sampleTheme = (theme: "dark" | "light") => {
          document.documentElement.dataset["colorScheme"] = theme;
          return {
            activeLine: brightness(getComputedStyle(activeLine).backgroundColor),
            editor: brightness(getComputedStyle(editor).backgroundColor),
            page: brightness(getComputedStyle(document.documentElement).backgroundColor),
            syntax: brightness(getComputedStyle(keyword).color),
          };
        };
        const light = sampleTheme("light");
        const dark = sampleTheme("dark");
        if (originalScheme === undefined) delete document.documentElement.dataset["colorScheme"];
        else document.documentElement.dataset["colorScheme"] = originalScheme;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const contentStyle = getComputedStyle(content);
        return {
          codeKeyword: getComputedStyle(document.documentElement)
            .getPropertyValue("--code-keyword")
            .trim(),
          dark,
          light,
          gutter: getComputedStyle(gutter).display,
          paddingLeft: Number.parseFloat(contentStyle.paddingLeft),
          paddingTop: Number.parseFloat(contentStyle.paddingTop),
        };
      });
      assert.equal(editorAppearance.gutter, "none");
      assert.ok(editorAppearance.paddingLeft >= 12);
      assert.ok(editorAppearance.paddingTop >= 10);
      assert.ok(editorAppearance.light.editor < editorAppearance.light.page);
      assert.ok(editorAppearance.light.activeLine < editorAppearance.light.editor);
      assert.ok(editorAppearance.dark.editor > editorAppearance.dark.page);
      assert.ok(editorAppearance.dark.activeLine > editorAppearance.dark.editor);
      assert.notEqual(editorAppearance.light.syntax, editorAppearance.dark.syntax);
      assert.match(editorAppearance.codeKeyword, /^oklch\(/u);
      const compactToc = await first
        .locator("[data-preview-scroller] [data-reader-toc]")
        .evaluate((toc) => ({
          position: getComputedStyle(toc).position,
          trigger: toc.querySelector("button")?.textContent ?? "",
        }));
      assert.equal(compactToc.position, "sticky");
      assert.match(compactToc.trigger, /On this page: \S/u);
      const synchronizedScroll = await first.evaluate(async () => {
        const source = document.querySelector<HTMLElement>(".cm-scroller");
        const preview = document.querySelector<HTMLElement>("[data-preview-scroller]");
        const previewBody = document.querySelector<HTMLElement>("[data-preview]");
        const sourceHeading = [...document.querySelectorAll<HTMLElement>(".cm-line")].find(
          (line) => line.textContent === "## Architecture",
        );
        const previewHeading = [
          ...document.querySelectorAll<HTMLElement>("[data-preview] h2"),
        ].find((heading) => heading.id === "architecture");
        if (
          source === null ||
          preview === null ||
          previewBody === null ||
          sourceHeading === undefined ||
          previewHeading === undefined
        ) {
          throw new Error("Mapped editor headings are missing.");
        }
        const sourceAnchor = Number.parseFloat(getComputedStyle(sourceHeading).lineHeight) * 3;
        const previewAnchor = Number.parseFloat(getComputedStyle(previewBody).lineHeight) * 3;

        sourceHeading.scrollIntoView({ block: "start" });
        source.scrollTop +=
          sourceHeading.getBoundingClientRect().top -
          source.getBoundingClientRect().top -
          sourceAnchor;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceToPreview = {
          preview: previewHeading.getBoundingClientRect().top - preview.getBoundingClientRect().top,
          source: sourceHeading.getBoundingClientRect().top - source.getBoundingClientRect().top,
        };

        const sourceMaximum = source.scrollHeight - source.clientHeight;
        const sourceBase = Math.min(source.scrollTop, sourceMaximum - 24);
        const previewSteps: number[] = [];
        let sourceChain = Promise.resolve();
        for (const offset of [0, 4, 8, 12, 16, 20, 24]) {
          sourceChain = sourceChain.then(
            () =>
              new Promise<void>((resolve) => {
                source.scrollTop = sourceBase + offset;
                setTimeout(() => {
                  previewSteps.push(preview.scrollTop);
                  resolve();
                }, 40);
              }),
          );
        }
        await sourceChain;

        previewHeading.scrollIntoView({ block: "start" });
        preview.scrollTop +=
          previewHeading.getBoundingClientRect().top -
          preview.getBoundingClientRect().top -
          previewAnchor;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const currentSourceHeading = [...document.querySelectorAll<HTMLElement>(".cm-line")].find(
          (line) => line.textContent === "## Architecture",
        );
        if (currentSourceHeading === undefined)
          throw new Error("Mapped source heading is missing.");
        const previewToSource = {
          preview: previewHeading.getBoundingClientRect().top - preview.getBoundingClientRect().top,
          source:
            currentSourceHeading.getBoundingClientRect().top - source.getBoundingClientRect().top,
        };

        const previewMaximum = preview.scrollHeight - preview.clientHeight;
        const previewBase = Math.min(preview.scrollTop, previewMaximum - 60);
        const sourceSteps: number[] = [];
        let previewChain = Promise.resolve();
        for (const offset of [0, 10, 20, 30, 40, 50, 60]) {
          previewChain = previewChain.then(
            () =>
              new Promise<void>((resolve) => {
                preview.scrollTop = previewBase + offset;
                setTimeout(() => {
                  sourceSteps.push(source.scrollTop);
                  resolve();
                }, 40);
              }),
          );
        }
        await previewChain;

        source.scrollTop = Math.min(80, sourceMaximum);
        await new Promise((resolve) => setTimeout(resolve, 40));
        source.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const sourceTop = { preview: preview.scrollTop, source: source.scrollTop };
        preview.scrollTop = Math.min(80, previewMaximum);
        await new Promise((resolve) => setTimeout(resolve, 40));
        preview.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 80));

        return {
          anchors: { preview: previewAnchor, source: sourceAnchor },
          previewSteps,
          previewToSource,
          previewTop: { preview: preview.scrollTop, source: source.scrollTop },
          sourceSteps,
          sourceToPreview,
          sourceTop,
        };
      });
      assert.ok(
        Math.abs(synchronizedScroll.sourceToPreview.source - synchronizedScroll.anchors.source) < 4,
      );
      assert.ok(
        Math.abs(synchronizedScroll.sourceToPreview.preview - synchronizedScroll.anchors.preview) <
          40,
      );
      assert.ok(
        Math.abs(synchronizedScroll.previewToSource.preview - synchronizedScroll.anchors.preview) <
          4,
      );
      assert.ok(
        Math.abs(synchronizedScroll.previewToSource.source - synchronizedScroll.anchors.source) <
          40,
      );
      assert.ok(strictlyIncreasing(synchronizedScroll.previewSteps));
      assert.ok(strictlyIncreasing(synchronizedScroll.sourceSteps));
      assert.deepEqual(synchronizedScroll.sourceTop, { preview: 0, source: 0 });
      assert.deepEqual(synchronizedScroll.previewTop, { preview: 0, source: 0 });

      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+Home");
      await first.keyboard.press("Shift+End");
      const sourceCommentComposer = first.locator(
        '[data-comment-composer][data-comment-surface="source"]',
      );
      assert.equal(await sourceCommentComposer.count(), 0);
      await first.locator(".cm-content").dispatchEvent("pointerup");
      await sourceCommentComposer.waitFor();
      assert.equal(
        await sourceCommentComposer.evaluate((bubble) => getComputedStyle(bubble).opacity),
        "0.48",
      );
      await sourceCommentComposer.click();
      await first.waitForFunction(
        () => document.querySelector("[data-comment-composer-popover]")?.checkVisibility() === true,
      );
      assert.equal(await first.locator("[data-comment-composer-dialog]").count(), 0);
      await first.locator("[data-comment-composer-popover] [data-comment-cancel]").click();
      await first.keyboard.press("ArrowRight");

      const second = await context.newPage();
      await second.goto(`${baseUrl}/rfc/0001/edit`);
      await second.waitForSelector(".cm-content");
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      const adminCursor = second.locator('[data-remote-cursor][data-remote-name="Browser Admin"]');
      await adminCursor.waitFor();
      const adminPresenceColor = await adminCursor.evaluate((cursor) =>
        getComputedStyle(cursor).getPropertyValue("--remote-color").trim(),
      );
      assert.match(adminPresenceColor, /^oklch\(/u);
      await first.keyboard.press("Shift+Home");
      await second.bringToFront();
      const adminSelection = second.locator(
        '[data-remote-selection][data-remote-name="Browser Admin"]',
      );
      await adminSelection.waitFor();
      assert.match(
        await adminSelection.evaluate((selection) => getComputedStyle(selection).backgroundColor),
        /^oklab\(|^oklch\(/u,
      );
      await first.bringToFront();
      await first.keyboard.press("ArrowRight");
      await first.keyboard.press("ControlOrMeta+End");
      await first.keyboard.insertText(" from first");
      await second.locator(".cm-content").click();
      await second.keyboard.press("ControlOrMeta+End");
      await second.keyboard.insertText(" and second");
      await Promise.all(
        [first, second].map((page) =>
          page.waitForFunction(
            () =>
              document.querySelector(".cm-content")?.textContent?.includes("from first") === true &&
              document.querySelector(".cm-content")?.textContent?.includes("and second") === true,
          ),
        ),
      );
      const editorGeometryBeforeComment = await second.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".cm-line")].slice(0, 2).map((line) => {
          const bounds = line.getBoundingClientRect();
          return { height: bounds.height, top: bounds.top };
        }),
      );

      await first.evaluate(async (id) => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("inkling_csrf="))
          ?.slice("inkling_csrf=".length);
        const documentResponse = await fetch(`/api/documents/${id}`);
        const source = (await documentResponse.json()) as { body: string };
        const start = source.body.indexOf("Shared starting body");
        await fetch(`/api/documents/${id}/comments`, {
          body: JSON.stringify({
            authorDisplayName: "Browser Admin",
            body: "Browser comment",
            // Browser line selections commonly include the trailing newline.
            selection: { end: start + "Shared starting body\n".length, start },
          }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "POST",
        });
      }, documentId);
      await second.waitForSelector('[data-comment-bubble][data-comment-surface="source"]');
      await second.waitForSelector(
        '[data-preview] [data-comment-bubble][data-comment-surface="preview"]',
      );
      assert.ok(
        (await second.locator("[data-comment-thread]").first().textContent()).startsWith(
          "Shared starting body",
        ),
      );
      const sourceBubbleLayout = await second
        .locator('[data-comment-bubble][data-comment-surface="source"]')
        .evaluate((bubble) => {
          const anchor = bubble.parentElement;
          const bubbleBounds = bubble.getBoundingClientRect();
          const lineBounds = bubble.closest(".cm-line")?.getBoundingClientRect();
          return {
            anchorDisplay: anchor === null ? undefined : getComputedStyle(anchor).display,
            anchorWidth: anchor?.getBoundingClientRect().width ?? 0,
            bubbleCenter: bubbleBounds.top + bubbleBounds.height / 2,
            bubblePosition: getComputedStyle(bubble).position,
            lineCenter:
              lineBounds === undefined ? undefined : lineBounds.top + lineBounds.height / 2,
          };
        });
      assert.equal(sourceBubbleLayout.anchorDisplay, "inline-flex");
      assert.ok(sourceBubbleLayout.anchorWidth > 0);
      assert.equal(sourceBubbleLayout.bubblePosition, "relative");
      assert.notEqual(sourceBubbleLayout.lineCenter, undefined);
      assert.ok(
        Math.abs(sourceBubbleLayout.bubbleCenter - (sourceBubbleLayout.lineCenter ?? 0)) < 2,
      );
      const editorGeometryAfterComment = await second.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".cm-line")].slice(0, 2).map((line) => {
          const bounds = line.getBoundingClientRect();
          return { height: bounds.height, top: bounds.top };
        }),
      );
      assert.deepEqual(editorGeometryAfterComment, editorGeometryBeforeComment);
      const previewPlacement = await second
        .locator('[data-preview] [data-comment-bubble][data-comment-surface="preview"]')
        .evaluate((bubble) => ({
          display: getComputedStyle(bubble.parentElement as HTMLElement).display,
          parentTag: bubble.parentElement?.parentElement?.tagName,
        }));
      assert.deepEqual(previewPlacement, { display: "inline-flex", parentTag: "P" });
      await second
        .locator('[data-preview] [data-comment-bubble][data-comment-surface="preview"]')
        .click();
      await second.waitForFunction(
        () =>
          document.querySelector("[data-comment-card]")?.checkVisibility() === true &&
          document
            .querySelector("[data-comment-card]")
            ?.textContent?.includes("Browser comment") === true,
      );
      await second.locator("[data-comment-close]").click();

      await first.locator(".cm-line").filter({ hasText: "Shared starting body" }).click();
      await first.keyboard.press("Home");
      await first.keyboard.insertText("Before ");
      await Promise.all(
        [first, second].map((page) =>
          page.waitForFunction(
            () =>
              document
                .querySelector("[data-comment-thread]")
                ?.textContent?.startsWith("Shared starting body") === true,
          ),
        ),
      );

      await second.evaluate(() => {
        const paragraph = document.querySelector<HTMLElement>("[data-preview] p");
        const text = paragraph?.firstChild;
        if (paragraph === null || paragraph === undefined || text === null || text === undefined) {
          throw new Error("Rendered paragraph is missing.");
        }
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, Math.min(6, text.textContent?.length ?? 0));
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
      await second.waitForSelector("[data-comment-composer]");
      await second.locator("[data-comment-composer]").click();
      await second
        .locator("[data-comment-composer-popover] [data-comment-body]")
        .fill("Preview segment comment");
      assert.equal(await second.locator("[data-comment-composer-dialog]").count(), 0);
      await second.locator("[data-comment-composer-popover] [data-comment-submit]").click();
      await second.waitForFunction(
        () => document.querySelector("[data-comment-count]")?.textContent === "2",
      );
      await second
        .locator('[data-preview] [data-comment-bubble][data-comment-surface="preview"]')
        .last()
        .click();
      await second.locator("[data-comment-card] [data-reply-thread]").click();
      await second
        .locator("[data-comment-card] [data-comment-composer-inline] [data-comment-body]")
        .fill("A composed reply");
      assert.equal(await second.locator("[data-comment-composer-dialog]").count(), 0);
      await second
        .locator("[data-comment-card] [data-comment-composer-inline] [data-comment-submit]")
        .click();
      await second.waitForFunction(() =>
        document.querySelector("[data-comment-card]")?.textContent?.includes("A composed reply"),
      );
      await second.locator("[data-comment-close]").click();

      const layout = await first.evaluate(() => {
        const source = document.querySelector("[data-source-pane]")?.getBoundingClientRect();
        const preview = document.querySelector("[data-preview-pane]")?.getBoundingClientRect();
        return {
          hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
          previewWidth: preview?.width ?? 0,
          sourceWidth: source?.width ?? 0,
        };
      });
      assert.equal(layout.hasHorizontalOverflow, false);
      assert.ok(Math.abs(layout.sourceWidth - layout.previewWidth) < 2);

      await second.close();
      await first.waitForFunction(
        () => document.querySelectorAll("[data-participants] .participant").length === 0,
      );

      await first.locator("[data-share]").click();
      await first.getByRole("radio", { name: "View, comment, and edit" }).check();
      await first.getByRole("button", { name: "Create and copy link" }).click();
      await first.locator('[data-share-link] >> text="Can edit"').waitFor();
      const capabilityUrl = await first.evaluate(async (id) => {
        const response = await fetch(`/api/documents/${id}/shares`);
        const links = (await response.json()) as {
          links: { access: string; passwordProtected: boolean; url: string }[];
        };
        return links.links.find((link) => link.access === "edit" && !link.passwordProtected)?.url;
      }, documentId);
      assert.ok(capabilityUrl);
      await first.getByRole("button", { name: "Close sharing settings" }).click();
      const sharedContext = await browser.newContext();
      const shared = await sharedContext.newPage();
      await shared.goto(capabilityUrl);
      await shared.waitForSelector("[data-reader]");
      assert.equal(await shared.locator("[data-account]").count(), 0);
      assert.equal(await shared.locator(".cm-editor").count(), 0);
      await shared.locator("[data-open-editor]").click();
      await shared.getByLabel("Display name").fill("Browser reviewer");
      await shared.getByRole("button", { name: "Join document" }).click();
      await shared.waitForFunction(
        () => document.querySelector(".cm-content")?.getAttribute("contenteditable") === "true",
      );
      await shared.locator(".cm-content").click();
      await shared.keyboard.press("ControlOrMeta+End");
      const guestCursor = first.locator(
        '[data-remote-cursor][data-remote-name="Browser reviewer"]',
      );
      await guestCursor.waitFor();
      const guestPresenceColor = await guestCursor.evaluate((cursor) =>
        getComputedStyle(cursor).getPropertyValue("--remote-color").trim(),
      );
      assert.match(guestPresenceColor, /^oklch\(/u);
      assert.notEqual(guestPresenceColor, adminPresenceColor);
      await first.locator("[data-share]").click();
      const editableLink = first.locator("[data-share-link]", { hasText: "Can edit" });
      await editableLink.getByRole("button", { name: "Delete" }).click();
      await editableLink.waitFor({ state: "detached" });
      await shared.waitForFunction(
        () => document.querySelector(".cm-content")?.getAttribute("contenteditable") === "false",
      );
      assert.equal(
        await shared
          .locator("[data-source-pane]")
          .evaluate((pane) => getComputedStyle(pane).display),
        "none",
      );
      assert.equal(
        await shared
          .locator("[data-preview-pane]")
          .evaluate((pane) => getComputedStyle(pane).display),
        "block",
      );

      await first.getByRole("radio", { exact: true, name: "View" }).check();
      await first.getByRole("checkbox", { name: "Require a password" }).check();
      await first.getByLabel("Password", { exact: true }).fill("browser share password");
      await first.getByRole("button", { name: "Create and copy link" }).click();
      const protectedRow = first.locator("[data-share-link]", { hasText: "Password protected" });
      await protectedRow.waitFor();
      const protectedCapabilityUrl = await first.evaluate(async (id) => {
        const response = await fetch(`/api/documents/${id}/shares`);
        const links = (await response.json()) as {
          links: { passwordProtected: boolean; url: string }[];
        };
        return links.links.find((link) => link.passwordProtected)?.url;
      }, documentId);
      assert.ok(protectedCapabilityUrl);
      await first.getByRole("button", { name: "Close sharing settings" }).click();

      const protectedContext = await browser.newContext();
      const protectedPage = await protectedContext.newPage();
      await protectedPage.goto(protectedCapabilityUrl);
      await protectedPage.waitForSelector("[data-share-password-screen]");
      await protectedPage.getByLabel("Password", { exact: true }).fill("wrong password");
      await protectedPage.getByRole("button", { name: "Open document" }).click();
      await protectedPage.getByText("The share password is incorrect.").waitFor();
      await protectedPage.getByLabel("Password", { exact: true }).fill("browser share password");
      await protectedPage.getByRole("button", { name: "Open document" }).click();
      await protectedPage.waitForSelector("[data-reader]");
      await protectedContext.close();

      await first.setViewportSize({ height: 844, width: 390 });
      await first.locator("[data-preview-toggle]").click();
      assert.equal(await first.locator("#app").getAttribute("data-preview-open"), "");
      await sharedContext.close();

      await first.setViewportSize({ height: 900, width: 1600 });
      const wrappedDocumentId = await first.evaluate(async () => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("inkling_csrf="))
          ?.slice("inkling_csrf=".length);
        const paragraphs = Array.from({ length: 31 }, (_, index) =>
          index === 15
            ? "## Wrapped source alignment"
            : `Wrapped paragraph ${index} deliberately occupies one logical Markdown line while wrapping across several visual editor rows. Its rendered counterpart uses different font metrics and line breaks so stale CodeMirror height estimates would accumulate visible synchronization drift.`,
        ).join("\n\n");
        const response = await fetch("/api/documents", {
          body: JSON.stringify({
            body: `---\nauthors: []\nstate: draft\nvisibility: private\nlabels: []\n---\n# Wrapped scrolling fixture\n\n${paragraphs}`,
            creationKey: "browser-wrapped-scroll-fixture",
            title: "Wrapped scrolling fixture",
          }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "POST",
        });
        return ((await response.json()) as { metadata: { id: string } }).metadata.id;
      });
      await first.goto(`${baseUrl}/documents/${wrappedDocumentId}/edit`);
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.evaluate(async () => {
        const source = document.querySelector<HTMLElement>(".cm-scroller");
        if (source === null) throw new Error("Editor scroller is missing.");
        source.scrollTop = 4;
        await new Promise((resolve) => setTimeout(resolve, 80));
        source.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 80));
        const content = source.querySelector<HTMLElement>(".cm-content");
        if (content === null) throw new Error("Editor content is missing.");
        content.style.fontSize = "18px";
        await new Promise((resolve) => setTimeout(resolve, 160));
      });
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+f");
      await first.locator(".cm-search input[name=search]").fill("Wrapped source alignment");
      await first.locator(".cm-search button[name=next]").click();
      await first.waitForFunction(() =>
        [...document.querySelectorAll(".cm-line")].some(
          (line) => line.textContent === "## Wrapped source alignment",
        ),
      );
      await first.keyboard.press("Escape");
      const wrappedScrollAlignment = await first.evaluate(async () => {
        const source = document.querySelector<HTMLElement>(".cm-scroller");
        const preview = document.querySelector<HTMLElement>("[data-preview-scroller]");
        const previewBody = document.querySelector<HTMLElement>("[data-preview]");
        const sourceHeading = [...document.querySelectorAll<HTMLElement>(".cm-line")].find(
          (line) => line.textContent === "## Wrapped source alignment",
        );
        const previewHeading = [
          ...document.querySelectorAll<HTMLElement>("[data-preview] h2"),
        ].find((heading) => heading.id === "wrapped-source-alignment");
        if (
          source === null ||
          preview === null ||
          previewBody === null ||
          sourceHeading === undefined ||
          previewHeading === undefined
        ) {
          throw new Error("Wrapped scroll headings are missing.");
        }
        const sourceAnchor = Number.parseFloat(getComputedStyle(sourceHeading).lineHeight) * 3;
        const previewAnchor = Number.parseFloat(getComputedStyle(previewBody).lineHeight) * 3;
        source.scrollTop +=
          sourceHeading.getBoundingClientRect().top -
          source.getBoundingClientRect().top -
          sourceAnchor;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const sourceToPreview = {
          preview: previewHeading.getBoundingClientRect().top - preview.getBoundingClientRect().top,
          source: sourceHeading.getBoundingClientRect().top - source.getBoundingClientRect().top,
        };
        const sourcePositions: number[] = [];
        const sourceSteps: number[] = [];
        const sourceBase = source.scrollTop;
        let chain = Promise.resolve();
        for (const offset of [0, 4, 8, 12, 16, 20, 24]) {
          chain = chain.then(
            () =>
              new Promise<void>((resolve) => {
                source.scrollTop = sourceBase + offset;
                setTimeout(() => {
                  sourcePositions.push(source.scrollTop);
                  sourceSteps.push(preview.scrollTop);
                  resolve();
                }, 80);
              }),
          );
        }
        await chain;
        return {
          previewAnchor,
          sourceAnchor,
          sourceBase,
          sourcePositions,
          sourceSteps,
          sourceToPreview,
        };
      });
      assert.ok(
        Math.abs(
          wrappedScrollAlignment.sourceToPreview.source -
            wrappedScrollAlignment.sourceAnchor -
            (wrappedScrollAlignment.sourceToPreview.preview - wrappedScrollAlignment.previewAnchor),
        ) < 30,
      );
      assert.ok(strictlyIncreasing(wrappedScrollAlignment.sourceSteps));
      assert.deepEqual(
        wrappedScrollAlignment.sourcePositions.map((position) => Math.round(position)),
        [0, 4, 8, 12, 16, 20, 24].map((offset) =>
          Math.round(wrappedScrollAlignment.sourceBase + offset),
        ),
      );

      const trashDocumentId = await first.evaluate(async () => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("inkling_csrf="))
          ?.slice("inkling_csrf=".length);
        const response = await fetch("/api/documents", {
          body: JSON.stringify({
            body: "A document that can be restored.",
            creationKey: "browser-trash-note",
            title: "Browser trash note",
          }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "POST",
        });
        const created = (await response.json()) as { metadata: { id: string } };
        return created.metadata.id;
      });
      await first.goto(`${baseUrl}/documents/${trashDocumentId}/edit`);
      await first.waitForSelector("[data-delete-document]");
      await first.locator("[data-delete-document]").click();
      await first.getByRole("button", { name: "Move to trash" }).click();
      await first.waitForURL(`${baseUrl}/`);
      await first.getByRole("link", { name: "Trash", exact: true }).click();
      await first.waitForURL(`${baseUrl}/trash`);
      await first.waitForSelector(`[data-trash-document="${trashDocumentId}"]`);
      const trashRow = first.locator(`[data-trash-document="${trashDocumentId}"]`);
      assert.match(await trashRow.innerText(), /Permanently deletes/u);
      assert.equal(
        await trashRow
          .locator(`[data-edit-trashed-document="${trashDocumentId}"]`)
          .getAttribute("href"),
        `/documents/${trashDocumentId}/edit`,
      );
      await first.goto(`${baseUrl}/documents/${trashDocumentId}`);
      await first.waitForSelector("[data-trashed]");
      assert.match(await first.locator("[data-trashed]").innerText(), /in trash/iu);
      assert.deepEqual(await first.locator("[data-breadcrumb]").allTextContents(), [
        "Inkling",
        "Trash",
        "Browser trash note",
      ]);
      await first.locator("[data-open-editor]").click();
      await first.waitForURL(`${baseUrl}/documents/${trashDocumentId}/edit`);
      await first.waitForSelector("[data-document-trashed]");
      assert.match(
        await first.locator("[data-document-trashed]").innerText(),
        /in trash\s*changes are still saved\./iu,
      );
      assert.equal(await first.locator("[data-delete-document]").count(), 0);
      assert.equal(await first.locator("[data-publish]").count(), 0);
      assert.equal(await first.locator("[data-share]").count(), 0);
      const trashedBodyLine = first
        .locator(".cm-line")
        .filter({ hasText: "A document that can be restored." });
      await trashedBodyLine.click();
      await first.keyboard.press("End");
      await first.keyboard.insertText(" It remains editable.");
      await first.waitForFunction(
        () => document.querySelector('[data-save-state="ready"]') !== null,
      );
      await first.getByRole("link", { name: "In Trash", exact: true }).click();
      await first.waitForURL(`${baseUrl}/trash`);
      await first.locator(`[data-restore-document="${trashDocumentId}"]`).click();
      await first.waitForSelector(`[data-trash-document="${trashDocumentId}"]`, {
        state: "detached",
      });

      await first.goto(`${baseUrl}/documents/${trashDocumentId}/edit`);
      await first.waitForSelector("[data-delete-document]");
      assert.match(await first.locator(".cm-content").innerText(), /It remains editable\./u);
      await first.locator("[data-delete-document]").click();
      await first.getByRole("button", { name: "Move to trash" }).click();
      await first.waitForURL(`${baseUrl}/`);
      await first.getByRole("link", { name: "Trash", exact: true }).click();
      await first.waitForSelector(`[data-hard-delete-document="${trashDocumentId}"]`);
      await first.locator(`[data-hard-delete-document="${trashDocumentId}"]`).click();
      await first
        .locator("[data-confirmation-dialog]")
        .getByRole("button", { name: "Delete forever" })
        .click();
      await first.waitForSelector(`[data-trash-document="${trashDocumentId}"]`, {
        state: "detached",
      });

      const publicNote = await first.evaluate(async () => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("inkling_csrf="))
          ?.slice("inkling_csrf=".length);
        const createdResponse = await fetch("/api/documents", {
          body: JSON.stringify({
            body: "---\nauthors: []\nstate: published\nvisibility: public\nlabels:\n  - public\n---\n# Public browser note\n\nVisible without signing in.",
            creationKey: "browser-public-note",
            title: "Public browser note",
          }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "POST",
        });
        const created = (await createdResponse.json()) as { metadata: { id: string } };
        const publishedResponse = await fetch(`/api/documents/${created.metadata.id}/publish`, {
          headers: { "X-CSRF-Token": csrf ?? "" },
          method: "POST",
        });
        return {
          createdStatus: createdResponse.status,
          documentId: created.metadata.id,
          publishedStatus: publishedResponse.status,
        };
      });
      assert.deepEqual(
        { createdStatus: publicNote.createdStatus, publishedStatus: publicNote.publishedStatus },
        { createdStatus: 200, publishedStatus: 200 },
      );
      const logoutResponse = first.waitForResponse((response) =>
        response.url().endsWith("/api/auth/logout"),
      );
      await first.locator("[data-account-trigger]").click();
      await first.locator("[data-logout]").click();
      assert.equal((await logoutResponse).status(), 200);
      await first.waitForSelector("[data-public-catalog]");
      await first.getByRole("link", { name: "Sign in" }).waitFor();
      assert.equal(await first.locator("[data-account]").count(), 0);
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      const publicNoteLink = first.locator("[data-catalog-document-id]", {
        hasText: "Public browser note",
      });
      assert.equal(await publicNoteLink.getAttribute("data-native-navigation"), "");
      await publicNoteLink.click();
      await first.waitForURL(
        new RegExp(
          `/public/documents/${publicNote.documentId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
          "u",
        ),
      );
      await first.waitForSelector(".public-document");
      assert.match(
        await first.locator(".public-document").innerText(),
        /Visible without signing in/u,
      );
      await context.close();
    } finally {
      await browser.close();
      await stopProcess(server);
      await google.stop();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.length > 1 && values.slice(1).every((value, index) => value > (values[index] ?? 0));
}

interface RunningGoogleOAuthMock {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

async function startGoogleOAuthMock(): Promise<RunningGoogleOAuthMock> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verificationKey = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "inkling-browser-key",
    use: "sig",
  };
  let nonce: string | undefined;
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/authorize") {
      nonce = url.searchParams.get("nonce") ?? undefined;
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      assert.ok(nonce);
      assert.ok(redirectUri);
      assert.ok(state);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "browser-authorization-code");
      callback.searchParams.set("state", state);
      response.writeHead(302, { Location: callback.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      assert.ok(nonce);
      const header = base64UrlJson({ alg: "RS256", kid: "inkling-browser-key", typ: "JWT" });
      const claims = base64UrlJson({
        aud: "inkling-browser-client",
        email: "browser@example.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1_000) + 300,
        hd: "example.com",
        iss: "https://accounts.google.com",
        name: "Browser Admin",
        nonce,
        sub: "browser-user",
      });
      const unsigned = `${header}.${claims}`;
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ id_token: `${unsigned}.${signature}` }));
      return;
    }
    if (url.pathname === "/certificates") {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ keys: [verificationKey] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not start the browser OAuth server.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a browser test port.");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function findBrowser(): Promise<string | undefined> {
  const candidates = [
    process.env["BROWSER_BIN"],
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => value !== undefined);
  const available = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await access(candidate);
        return candidate;
      } catch {
        return undefined;
      }
    }),
  );
  return available.find((candidate) => candidate !== undefined);
}

async function waitForServer(baseUrl: string, attempt = 0): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (response.ok) return;
  } catch {
    // The server is still starting.
  }
  if (attempt >= 99) assert.fail("The browser test server did not start.");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForServer(baseUrl, attempt + 1);
}

/** Polls a condition that needs Node-side awaiting, such as a fetch made in the page. */
async function waitUntil(condition: () => Promise<boolean>, attempt = 0): Promise<void> {
  if (await condition()) return;
  if (attempt >= 199) assert.fail("The awaited condition never held.");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitUntil(condition, attempt + 1);
}
