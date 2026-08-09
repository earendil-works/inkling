import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const browserExecutable = await findBrowser();

test(
  "browser pages read, collaborate, comment, preview, and honor share revocation",
  { skip: browserExecutable === undefined, timeout: 60_000 },
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
        await first.locator(".workspace-heading .eyebrow").textContent(),
        "Public archive / published revisions",
      );
      assert.match(
        (await first.locator(".empty-state").textContent()) ?? "",
        /No public revisions have been published yet/u,
      );
      await first.getByRole("link", { name: "Sign in" }).click();
      await first.waitForSelector("[data-new-document]");
      await first.waitForSelector("main.workspace-layout:not([data-public-catalog])");
      assert.equal(await first.title(), "Inkling");
      assert.equal(await first.locator(".workspace-heading > div > .eyebrow").count(), 0);
      assert.equal(await first.locator(".workspace-heading h1").textContent(), "Inkling");
      assert.equal(await first.locator(".wordmark").textContent(), "Inkling");
      assert.equal(await first.locator("[data-account-name]").textContent(), "Browser Admin");
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      assert.equal(await first.locator(".catalog-tools [data-logout]").count(), 0);
      assert.equal(await first.locator("[data-account-menu]").isVisible(), false);
      await first.locator(".account-control__trigger").click();
      assert.deepEqual(await first.locator("[data-account-menu] button").allTextContents(), [
        "API keys",
        "Sign out",
      ]);
      await first.locator("[data-open-api-keys]").click();
      assert.equal(
        await first.locator("[data-settings-dialog] .dialog-heading .eyebrow").count(),
        0,
      );
      assert.equal(await first.locator("[data-settings-dialog] h2").textContent(), "API keys");
      assert.match(
        (await first.locator("[data-settings-dialog] .dialog-note").textContent()) ?? "",
        /belong to your account/u,
      );
      await first.getByLabel("Key name").fill("Browser agent");
      await first.getByRole("button", { name: "Create API key" }).click();
      const revealedKey = (await first.locator("[data-api-key-secret]").textContent()) ?? "";
      assert.match(revealedKey, /^key_[0-9A-Za-z]+\./u);
      assert.doesNotMatch(
        (await first.locator("[data-api-key-reveal]").textContent()) ?? "",
        /inkling instance add/u,
      );
      assert.equal(await first.locator("[data-copy-api-key]").textContent(), "Copy API key");
      await first.getByLabel("Close API keys").click();
      const initialTheme = await first.locator("html").getAttribute("data-theme");
      await first.locator("[data-theme-toggle]").dblclick();
      assert.notEqual(await first.locator("html").getAttribute("data-theme"), initialTheme);
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      assert.equal(await first.title(), "Browser collaboration");
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
      const temporaryTitleLine = first
        .locator(".cm-line")
        .filter({ hasText: "# Temporary browser title" });
      await temporaryTitleLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("# Browser collaboration");
      await first.waitForFunction(() => document.title === "Browser collaboration");
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      assert.match(
        await first.locator(".cm-content").innerText(),
        /---\s+authors:\s+- browser@example\.com\s+state: draft\s+visibility: private\s+labels: \[\]\s+---/u,
      );
      const draftStateChip = first.locator(".editor-preview-page .reader-state-chip");
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
        '.editor-preview-page .reader-state-chip[data-lifecycle-state="accepted"]',
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
      await first.waitForURL(/\/rfcs\/0001\/edit$/u);
      await first.waitForFunction(
        () =>
          document.querySelector(".document-bar .document-identity > span")?.textContent ===
          "RFC 0001",
      );
      assert.equal(await first.locator("[data-allocate-rfc]").count(), 0);
      const labelsLine = first.locator(".cm-line").filter({ hasText: "labels: []" });
      await labelsLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("labels: [] invalid");
      await first.waitForTimeout(100);
      assert.equal(await first.locator("[data-toasts] .toast").count(), 0);
      assert.equal(
        await first.locator(".editor-preview-page [data-document-page] h1").textContent(),
        "Browser collaboration",
      );
      const invalidLabelsLine = first.locator(".cm-line").filter({ hasText: "labels: [] invalid" });
      await invalidLabelsLine.click();
      await first.keyboard.press("End");
      await first.keyboard.press("Shift+Home");
      await first.keyboard.insertText("labels:\n  - architecture\n  - platform");
      assert.equal(
        await first.locator(".editor-preview-page [data-document-page] h1").textContent(),
        "Browser collaboration",
      );
      assert.match(
        await first.locator(".editor-preview-page [data-document-metadata]").innerText(),
        /Authors\s+Browser Admin[\s\S]+Created[\s\S]+Updated/iu,
      );
      assert.equal(
        await first
          .locator('.editor-preview-page .reader-labels a[href="/labels?label=platform"]')
          .textContent(),
        "platform",
      );
      await first.waitForFunction(async () => {
        const response = await fetch(`/api/documents?q=${encodeURIComponent("label:platform")}`);
        const catalog = (await response.json()) as {
          documents: readonly { metadata: { title: string } }[];
        };
        return catalog.documents.some(
          (document) => document.metadata.title === "Browser collaboration",
        );
      });
      await first.locator(".wordmark").click();
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.title(), "Inkling");
      await first.getByRole("link", { name: "Browse labels" }).click();
      await first.getByRole("link", { name: /platform/u }).click();
      const workingLabelRow = first.locator(".catalog-row", { hasText: "Browser collaboration" });
      assert.equal(await workingLabelRow.locator(".catalog-row__folio").textContent(), "RFC 0001");
      assert.equal(
        await workingLabelRow.locator(".catalog-row__visibility").textContent(),
        "private",
      );
      assert.notEqual(
        await workingLabelRow.evaluate((row) => getComputedStyle(row).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      const visibilityBackgrounds = await first.evaluate(() =>
        ["public", "private", "confidential"].map((visibility) => {
          const row = document.createElement("a");
          row.className = "catalog-row";
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Publish",
      );
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      await first.keyboard.insertText("\n\nPublished follow-up");
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      await first.waitForFunction(
        () => document.querySelector("[data-publish]")?.textContent === "Publish Changes",
      );
      const documentActionLabels = await first
        .locator(".document-actions > a, .document-actions > button")
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
      await first.waitForURL(/\/rfcs\/0001$/u);
      assert.equal(
        await first.locator("html").getAttribute("data-browser-navigation"),
        "same-document",
      );
      await first.waitForSelector("[data-reader]");
      await first.waitForSelector("[data-reader-toc]");
      assert.match(
        await first.locator("[data-reader] [data-document-metadata]").innerText(),
        /Authors\s+Browser Admin[\s\S]+Created[\s\S]+Updated/iu,
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
      assert.equal(
        await architectureTocLink
          .locator("..")
          .evaluate((item) => getComputedStyle(item, "::before").width),
        "2px",
      );
      await first.locator("#delivery").evaluate((heading) => heading.scrollIntoView());
      await first.waitForFunction(
        () =>
          document.querySelector('a[href="#delivery"]')?.getAttribute("aria-current") ===
          "location",
      );
      assert.equal(await architectureTocLink.getAttribute("aria-current"), null);
      assert.equal(await deliveryTocLink.getAttribute("aria-current"), "location");
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
      assert.equal(await first.locator(".reader-back-link").count(), 0);
      const readerState = first.locator(".reader-state-chip");
      assert.equal(await readerState.getAttribute("href"), "/?q=state%3Adraft");
      await readerState.click();
      await first.waitForURL(/\?q=state%3Adraft$/u);
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.locator("[data-search]").inputValue(), "state:draft");
      await first.getByRole("link", { name: "Browse labels" }).click();
      await first.waitForURL(/\/labels$/u);
      await first.waitForSelector("[data-label-index]");
      assert.equal(await first.locator(".workspace-heading h1").textContent(), "Labels");
      await first.getByRole("link", { name: /platform/u }).click();
      assert.equal(new URL(first.url()).searchParams.get("label"), "platform");
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      await first.locator(".wordmark").click();
      await first.waitForSelector("[data-document-search]");
      assert.equal(await first.locator(".catalog-row").count(), 2);
      await first.keyboard.press("j");
      const firstKeyboardSelection = await first
        .locator(".catalog-row[data-catalog-selected]")
        .innerText();
      await first.keyboard.press("j");
      const secondKeyboardSelection = await first
        .locator(".catalog-row[data-catalog-selected]")
        .innerText();
      assert.notEqual(secondKeyboardSelection, firstKeyboardSelection);
      await first.keyboard.press("k");
      assert.equal(
        await first.locator(".catalog-row[data-catalog-selected]").innerText(),
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
      assert.equal(await first.locator(".catalog-row").count(), 2);
      await documentSearch.press("Enter");
      assert.equal(await first.locator("[data-search-panel]").count(), 0);
      assert.equal(await documentSearch.inputValue(), "author:me");
      assert.deepEqual(
        await documentSearch.evaluate((input) => [input.selectionStart, input.selectionEnd]),
        [9, 9],
      );
      await first.locator(".wordmark").click();
      await first.waitForFunction(
        () =>
          new URL(location.href).searchParams.get("q") === null &&
          document.querySelector<HTMLInputElement>("[data-search]")?.value === "" &&
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator(".catalog-row").count(), 2);
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
      assert.equal(await first.locator(".catalog-row").count(), 1);
      assert.match(await first.locator(".catalog-row").innerText(), /Browser collaboration/u);
      assert.match(await first.locator(".catalog-row").innerText(), /answer/u);
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
      assert.equal(await first.locator(".catalog-row").count(), 1);
      await first.waitForFunction(
        () =>
          document.querySelector("[data-document-search]")?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator(".catalog-row").count(), 1);
      await documentSearch.press("ArrowDown");
      assert.equal(await first.locator(".catalog-row[data-catalog-selected]").count(), 1);
      await documentSearch.press("Enter");
      assert.match(first.url(), /\?q=rfc%3A1(?:\+|%20)%22answer%22$/u);
      await first.locator(".catalog-row[data-catalog-selected]").click();
      await first.waitForURL(/\/rfcs\/0001$/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForURL(/\/rfcs\/0001\/edit$/u);
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      assert.equal(await first.locator("[data-api-status]").textContent(), "Saved");
      assert.equal(
        await first.locator("[data-source-pane] .pane-label span").first().textContent(),
        "Markdown",
      );
      await first.waitForSelector(".cm-content .tok-keyword");
      const typography = await first.evaluate(() => {
        const editor = document.querySelector<HTMLElement>(".cm-scroller");
        const code = document.querySelector<HTMLElement>("[data-preview] pre");
        const markdownBody = document.querySelector<HTMLElement>("[data-preview].markdown-body");
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
      assert.match(typography.prose, /Newsreader/u);
      assert.match(typography.editor, /JetBrains Mono/u);
      assert.equal(typography.code, typography.editor);
      assert.ok(typography.heading1 > typography.heading2);
      assert.ok(typography.heading1 <= 36);
      const editorAppearance = await first.evaluate(async () => {
        const editor = document.querySelector<HTMLElement>(".cm-editor");
        const content = document.querySelector<HTMLElement>(".cm-content");
        const gutter = document.querySelector<HTMLElement>(".cm-gutters");
        const activeLine = document.querySelector<HTMLElement>(".cm-activeLine");
        if (editor === null || content === null || gutter === null || activeLine === null) {
          throw new Error("Editor appearance elements are missing.");
        }
        const originalTheme = document.documentElement.dataset["theme"];
        const canvasContext = document.createElement("canvas").getContext("2d");
        if (canvasContext === null) throw new Error("Canvas is unavailable.");
        const brightness = (color: string): number => {
          canvasContext.fillStyle = color;
          canvasContext.fillRect(0, 0, 1, 1);
          const [red = 0, green = 0, blue = 0] = canvasContext.getImageData(0, 0, 1, 1).data;
          return red + green + blue;
        };
        const sampleTheme = (theme: "dark" | "light") => {
          document.documentElement.dataset["theme"] = theme;
          return {
            activeLine: brightness(getComputedStyle(activeLine).backgroundColor),
            editor: brightness(getComputedStyle(editor).backgroundColor),
            page: brightness(getComputedStyle(document.documentElement).backgroundColor),
          };
        };
        const light = sampleTheme("light");
        const dark = sampleTheme("dark");
        if (originalTheme === undefined) delete document.documentElement.dataset["theme"];
        else document.documentElement.dataset["theme"] = originalTheme;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const contentStyle = getComputedStyle(content);
        return {
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
      const compactToc = await first
        .locator(".editor-preview-page [data-reader-toc]")
        .evaluate((toc) => {
          const list = toc.querySelector("ol");
          const link = toc.querySelector("a");
          if (list === null || link === null) throw new Error("Preview TOC is incomplete.");
          return {
            display: getComputedStyle(list).display,
            overflowX: getComputedStyle(list).overflowX,
            whiteSpace: getComputedStyle(link).whiteSpace,
          };
        });
      assert.deepEqual(compactToc, {
        display: "flex",
        overflowX: "auto",
        whiteSpace: "nowrap",
      });
      const synchronizedScroll = await first.evaluate(async () => {
        const source = document.querySelector<HTMLElement>(".cm-scroller");
        const preview = document.querySelector<HTMLElement>(".editor-preview-page");
        const previewBody = document.querySelector<HTMLElement>("[data-preview]");
        const sourceHeading = [...document.querySelectorAll<HTMLElement>(".cm-line")].find(
          (line) => line.textContent === "## Architecture",
        );
        const previewHeading = [
          ...document.querySelectorAll<HTMLElement>("[data-preview] h2"),
        ].find((heading) => heading.textContent === "Architecture");
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
        () =>
          document.querySelector("[data-comment-composer-popover]")?.matches(":popover-open") ===
          true,
      );
      assert.equal(await first.locator("[data-comment-composer-dialog]").count(), 0);
      await first.locator("[data-comment-composer-popover] [data-comment-cancel]").click();
      await first.keyboard.press("ArrowRight");

      const second = await context.newPage();
      await second.goto(`${baseUrl}/rfcs/0001/edit`);
      await second.waitForSelector(".cm-content");
      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+End");
      const adminCursor = second.locator('.cm-remote-cursor[data-remote-name="Browser Admin"]');
      await adminCursor.waitFor();
      const adminPresenceColor = await adminCursor.evaluate((cursor) =>
        getComputedStyle(cursor).getPropertyValue("--remote-color").trim(),
      );
      assert.match(adminPresenceColor, /^oklch\(/u);
      await first.keyboard.press("Shift+Home");
      await second.bringToFront();
      const adminSelection = second.locator(
        '.cm-remote-selection[data-remote-name="Browser Admin"]',
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
      await second.waitForSelector('.segment-comment-bubble[data-comment-surface="source"]');
      await second.waitForSelector(
        '[data-preview] .segment-comment-bubble[data-comment-surface="preview"]',
      );
      assert.ok(
        (await second.locator(".cm-comment-anchor").first().textContent()).startsWith(
          "Shared starting body",
        ),
      );
      const sourceBubbleLayout = await second
        .locator('.segment-comment-bubble[data-comment-surface="source"]')
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
        .locator('[data-preview] .segment-comment-bubble[data-comment-surface="preview"]')
        .evaluate((bubble) => ({
          display: getComputedStyle(bubble.parentElement as HTMLElement).display,
          parentTag: bubble.parentElement?.parentElement?.tagName,
        }));
      assert.deepEqual(previewPlacement, { display: "inline-flex", parentTag: "P" });
      await second
        .locator('[data-preview] .segment-comment-bubble[data-comment-surface="preview"]')
        .click();
      await second.waitForFunction(
        () =>
          document.querySelector("[data-comment-card]")?.matches(":popover-open") === true &&
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
                .querySelector(".cm-comment-anchor")
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
      await first.getByLabel("Anyone with this link can").selectOption("edit");
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
      const guestCursor = first.locator('.cm-remote-cursor[data-remote-name="Browser reviewer"]');
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

      await first.getByLabel("Anyone with this link can").selectOption("view");
      await first.getByLabel("Require a password").check();
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
      await protectedPage.waitForSelector(".share-password-layout");
      await protectedPage.getByLabel("Password", { exact: true }).fill("wrong password");
      await protectedPage.getByRole("button", { name: "Open document" }).click();
      await protectedPage.getByText("The share password is incorrect.").waitFor();
      await protectedPage.getByLabel("Password", { exact: true }).fill("browser share password");
      await protectedPage.getByRole("button", { name: "Open document" }).click();
      await protectedPage.waitForSelector("[data-reader]");
      await protectedContext.close();

      await first.setViewportSize({ height: 844, width: 390 });
      await first.locator("[data-preview-toggle]").click();
      assert.equal(
        await first
          .locator("#app")
          .evaluate((element) => element.classList.contains("preview-open")),
        true,
      );
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
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
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
        const preview = document.querySelector<HTMLElement>(".editor-preview-page");
        const previewBody = document.querySelector<HTMLElement>("[data-preview]");
        const sourceHeading = [...document.querySelectorAll<HTMLElement>(".cm-line")].find(
          (line) => line.textContent === "## Wrapped source alignment",
        );
        const previewHeading = [
          ...document.querySelectorAll<HTMLElement>("[data-preview] h2"),
        ].find((heading) => heading.textContent === "Wrapped source alignment");
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
      await first.locator(".account-control__trigger").click();
      await first.locator("[data-logout]").click();
      assert.equal((await logoutResponse).status(), 200);
      await first.waitForSelector("[data-public-catalog]");
      await first.getByRole("link", { name: "Sign in" }).waitFor();
      assert.equal(await first.locator("[data-account]").count(), 0);
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      const publicNoteLink = first.locator(".catalog-row", { hasText: "Public browser note" });
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
