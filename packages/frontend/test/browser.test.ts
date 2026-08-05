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
      const initialTheme = await first.locator("html").getAttribute("data-theme");
      await first.locator("[data-theme-toggle]").dblclick();
      assert.notEqual(await first.locator("html").getAttribute("data-theme"), initialTheme);
      await first.locator("[data-new-document]").click();
      await first.locator('input[name="title"]').fill("Browser collaboration");
      await first
        .locator('textarea[name="body"]')
        .fill("Shared starting body\n\nSecond line\n\nThird line");
      await first.locator('input[name="rfc"]').check();
      await first
        .locator("[data-new-form]")
        .evaluate((form: HTMLFormElement) =>
          form.requestSubmit(form.querySelector('button[type="submit"]')),
        );
      await first.waitForURL(/\/documents\//u);
      const documentId = first.url().split("/").at(-1);
      assert.ok(documentId);
      await first.waitForSelector("[data-reader]");
      assert.equal(await first.locator(".cm-editor").count(), 0);
      assert.match(await first.locator("[data-preview]").innerText(), /Shared starting body/u);
      await first.locator("[data-open-editor]").click();
      await first.waitForURL(/\/documents\/[^/]+\/edit$/u);
      await first.waitForFunction(
        () => document.querySelector("[data-save-state]")?.textContent === "Saved",
      );

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
      const sourceBubbleAlignment = await second
        .locator('.segment-comment-bubble[data-comment-surface="source"]')
        .evaluate((bubble) => {
          const bubbleBounds = bubble.getBoundingClientRect();
          const lineBounds = bubble.closest(".cm-line")?.getBoundingClientRect();
          return {
            bubbleCenter: bubbleBounds.top + bubbleBounds.height / 2,
            lineCenter:
              lineBounds === undefined ? undefined : lineBounds.top + lineBounds.height / 2,
          };
        });
      assert.notEqual(sourceBubbleAlignment.lineCenter, undefined);
      assert.ok(
        Math.abs(sourceBubbleAlignment.bubbleCenter - (sourceBubbleAlignment.lineCenter ?? 0)) < 2,
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
      second.once("dialog", (dialog) => dialog.accept("Preview segment comment"));
      await second.locator("[data-comment-composer]").click();
      await second.waitForFunction(
        () => document.querySelector("[data-comment-count]")?.textContent === "2",
      );

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
      assert.equal(await shared.locator(".cm-editor").count(), 0);
      await shared.locator("[data-open-editor]").click();
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
