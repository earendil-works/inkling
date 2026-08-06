import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

const browserExecutable = await findBrowser();

test(
  "browser pages read, collaborate, comment, preview, and honor a live share downgrade",
  { skip: browserExecutable === undefined, timeout: 60_000 },
  async () => {
    assert.ok(browserExecutable);
    const directory = await mkdtemp(path.join(tmpdir(), "jot-browser-"));
    const port = await availablePort();
    const server = spawn("node", ["../runtime-node/src/main.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        JOT_DATA_DIR: directory,
        PORT: String(port),
      },
      stdio: "ignore",
    });
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForServer(baseUrl);
      const context = await browser.newContext();
      const first = await context.newPage();
      await first.goto(baseUrl);
      await first.locator('input[name="password"]').fill("correct horse battery staple");
      await first
        .locator("[data-auth-form]")
        .evaluate((form: HTMLFormElement) => form.requestSubmit());
      await first.waitForSelector("[data-new-document]");
      assert.equal(await first.locator(".workspace-heading h1").textContent(), "Jots");
      assert.equal(await first.locator("[data-account-name]").textContent(), "Owner");
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      assert.equal(await first.locator(".catalog-tools [data-logout]").count(), 0);
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
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      assert.equal(await first.locator("[data-api-status]").textContent(), "Saved");
      assert.equal(await first.locator(".cm-content").textContent(), "");
      await first.locator("[data-document-details] > summary").click();
      await first.locator("[data-allocate-rfc]").click();
      await first.waitForFunction(
        () =>
          document.querySelector(".document-bar .document-identity > span")?.textContent ===
          "RFC 0001",
      );
      assert.equal(await first.locator("[data-allocate-rfc]").count(), 0);
      await first.locator("[data-document-details] > summary").click();
      await first.locator(".cm-content").click();
      await first.keyboard.insertText(
        "Shared starting body\n\nSecond line\n\n```ts\nconst answer: number = 42;\n```\n\nThird line",
      );
      await first.waitForSelector(".cm-content .tok-keyword");
      await first.waitForSelector("[data-preview] .tok-keyword");
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      const editorKeyword = first.locator(".cm-content .tok-keyword").last();
      assert.equal(await editorKeyword.textContent(), "const");
      const editorKeywordClass = await editorKeyword.getAttribute("class");
      await first.evaluate(() => {
        document.documentElement.dataset["browserNavigation"] = "same-document";
      });
      await first.getByRole("link", { name: "Read" }).click();
      await first.waitForURL(/\/documents\/[^/]+$/u);
      assert.equal(
        await first.locator("html").getAttribute("data-browser-navigation"),
        "same-document",
      );
      await first.waitForSelector("[data-reader]");
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      assert.equal(await first.locator(".cm-editor").count(), 0);
      assert.match(await first.locator("[data-preview]").innerText(), /Shared starting body/u);
      await first.waitForSelector("[data-preview] .tok-keyword");
      const renderedKeyword = first.locator("[data-preview] .tok-keyword");
      assert.equal(await renderedKeyword.textContent(), "const");
      assert.equal(await renderedKeyword.getAttribute("class"), editorKeywordClass);
      await first.getByRole("link", { name: "All documents" }).click();
      await first.waitForSelector("[data-document-search]");
      await first.keyboard.press("/");
      const documentSearch = first.locator("[data-search]");
      assert.equal(
        await documentSearch.evaluate((input) => input === document.activeElement),
        true,
      );
      await documentSearch.fill("lab");
      await first.waitForSelector("[data-search-completions]");
      assert.equal(
        await first.locator("[data-search-completions] code").first().textContent(),
        "label:",
      );
      await documentSearch.fill("rfc:1 answer");
      await first.waitForFunction(
        () => document.querySelector('[role="listbox"]')?.getAttribute("aria-busy") === "false",
      );
      await first.waitForSelector("[data-search-result]");
      assert.match(
        await first.locator("[data-search-result]").first().innerText(),
        /Browser collaboration/u,
      );
      assert.match(await first.locator("[data-search-result]").first().innerText(), /answer/u);
      assert.equal(new URL(first.url()).searchParams.get("q"), "rfc:1 answer");
      await first.route("**/api/documents?q=*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("q") === 'rfc:1 "answer"') {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        await route.continue();
      });
      await documentSearch.fill('rfc:1 "answer"');
      await first.waitForFunction(
        () => document.querySelector('[role="listbox"]')?.getAttribute("aria-busy") === "true",
      );
      assert.equal(await first.locator("[data-search-result]").count(), 1);
      await first.waitForFunction(
        () => document.querySelector('[role="listbox"]')?.getAttribute("aria-busy") === "false",
      );
      assert.equal(await first.locator("[data-search-result]").count(), 1);
      await documentSearch.press("Enter");
      await first.waitForURL(/\/documents\/[^/]+$/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForURL(/\/documents\/[^/]+\/edit$/u);
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );
      assert.equal(await first.locator("[data-api-status]").textContent(), "Saved");
      await first.waitForSelector(".cm-content .tok-keyword");
      const typography = await first.evaluate(() => {
        const editor = document.querySelector<HTMLElement>(".cm-scroller");
        const code = document.querySelector<HTMLElement>("[data-preview] pre");
        if (editor === null) throw new Error("Editor scroller is missing.");
        if (code === null) throw new Error("Preview code block is missing.");
        return {
          code: getComputedStyle(code).fontFamily,
          editor: getComputedStyle(editor).fontFamily,
          prose: getComputedStyle(document.body).fontFamily,
        };
      });
      assert.match(typography.prose, /Newsreader/u);
      assert.match(typography.editor, /JetBrains Mono/u);
      assert.equal(typography.code, typography.editor);

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
      await second.goto(`${baseUrl}/documents/${documentId}/edit`);
      await second.waitForSelector(".cm-content");
      await first.locator(".cm-content").click();
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
          .find((part) => part.startsWith("jot_csrf="))
          ?.slice("jot_csrf=".length);
        await fetch(`/api/documents/${id}/comments`, {
          body: JSON.stringify({
            authorDisplayName: "Browser owner",
            body: "Browser comment",
            // Browser line selections commonly include the trailing newline.
            selection: { end: "Shared starting body\n".length, start: 0 },
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

      await first.locator(".cm-content").click();
      await first.keyboard.press("ControlOrMeta+Home");
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

      const capabilityUrl = await first.evaluate(async (id) => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("jot_csrf="))
          ?.slice("jot_csrf=".length);
        const current = (await (await fetch(`/api/documents/${id}`)).json()) as {
          metadata: { headRevision: number };
        };
        const response = await fetch(`/api/documents/${id}/share`, {
          body: JSON.stringify({ access: "edit", expectedRevision: current.metadata.headRevision }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "PATCH",
        });
        return ((await response.json()) as { capabilityUrl: string }).capabilityUrl;
      }, documentId);
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
      await first.evaluate(async (id) => {
        const csrf = document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("jot_csrf="))
          ?.slice("jot_csrf=".length);
        const current = (await (await fetch(`/api/documents/${id}`)).json()) as {
          metadata: { headRevision: number };
        };
        await fetch(`/api/documents/${id}/share`, {
          body: JSON.stringify({ access: "view", expectedRevision: current.metadata.headRevision }),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf ?? "" },
          method: "PATCH",
        });
      }, documentId);
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

      await first.setViewportSize({ height: 844, width: 390 });
      await first.locator("[data-preview-toggle]").click();
      assert.equal(
        await first
          .locator("#app")
          .evaluate((element) => element.classList.contains("preview-open")),
        true,
      );
      await sharedContext.close();
      const logoutResponse = first.waitForResponse((response) =>
        response.url().endsWith("/api/auth/logout"),
      );
      await first.locator("[data-logout]").click();
      assert.equal((await logoutResponse).status(), 200);
      await first.waitForSelector("[data-auth-form]");
      assert.equal(await first.locator("[data-account]").count(), 0);
      assert.equal(await first.locator("[data-api-status]").count(), 0);
      await context.close();
    } finally {
      await browser.close();
      await stopProcess(server);
      await rm(directory, { force: true, recursive: true });
    }
  },
);

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
