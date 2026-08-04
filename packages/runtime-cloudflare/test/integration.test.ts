import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface RunningWrangler {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

test(
  "Cloudflare development runtime persists isolated document authorities in R2 and DO storage",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jot-cloudflare-test-"));
    let running: RunningWrangler | undefined;
    try {
      running = await startWrangler(directory);
      const setup = await fetch(`${running.baseUrl}/api/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(setup.status, 200);
      const cookie = setup.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const csrf = cookieValue(cookie, "jot_csrf");
      assert.ok(csrf);
      const keyResponse = await fetch(`${running.baseUrl}/api/api-keys`, {
        body: JSON.stringify({ label: "cloudflare integration" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: running.baseUrl,
          "X-CSRF-Token": csrf,
        },
        method: "POST",
      });
      const apiKey = ((await keyResponse.json()) as { key: string }).key;
      const authorization = { Authorization: `Bearer ${apiKey}` };
      const first = await createDocument(running.baseUrl, authorization, "first", true);
      const second = await createDocument(running.baseUrl, authorization, "second", false);
      const edited = await fetch(`${running.baseUrl}/api/documents/${first.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "durable", oldText: "initial" }],
          expectedRevision: first.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(edited.status, 200);
      let changed = (await edited.json()) as DocumentWire;
      assert.equal(changed.body, "durable first");
      assert.equal(
        (await readDocument(running.baseUrl, second.metadata.id, authorization)).body,
        "initial second",
      );
      changed = await updateTitle(
        running.baseUrl,
        first.metadata.id,
        changed.metadata.headRevision,
        "Intermediate title",
        authorization,
      );
      changed = await updateTitle(
        running.baseUrl,
        first.metadata.id,
        changed.metadata.headRevision,
        "Newest projected title",
        authorization,
      );
      await waitForCatalog(
        running.baseUrl,
        authorization,
        first.metadata.id,
        "Newest projected title",
      );
      const backup = await fetch(`${running.baseUrl}/api/admin/backup`, {
        headers: authorization,
      });
      assert.equal(backup.status, 200);
      assert.ok((await backup.arrayBuffer()).byteLength > 500);
      await running.stop();
      running = undefined;

      running = await startWrangler(directory);
      try {
        assert.equal(
          (await readDocument(running.baseUrl, first.metadata.id, authorization)).body,
          "durable first",
        );
        assert.equal(
          (await readDocument(running.baseUrl, second.metadata.id, authorization)).body,
          "initial second",
        );
      } finally {
        await running.stop();
        running = undefined;
      }
    } finally {
      await running?.stop();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

interface DocumentWire {
  readonly body: string;
  readonly metadata: { readonly headRevision: number; readonly id: string };
}

async function createDocument(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  name: string,
  allocateRfc: boolean,
): Promise<DocumentWire> {
  const response = await fetch(`${baseUrl}/api/documents`, {
    body: JSON.stringify({
      allocateRfc,
      body: `initial ${name}`,
      creationKey: `cloudflare-${name}`,
      title: `Cloudflare ${name}`,
    }),
    headers: { ...headers, "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return (await response.json()) as DocumentWire;
}

async function readDocument(
  baseUrl: string,
  documentId: string,
  headers: Readonly<Record<string, string>>,
): Promise<DocumentWire> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as DocumentWire;
}

async function updateTitle(
  baseUrl: string,
  documentId: string,
  expectedRevision: number,
  title: string,
  headers: Readonly<Record<string, string>>,
): Promise<DocumentWire> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/metadata`, {
    body: JSON.stringify({ expectedRevision, title }),
    headers: { ...headers, "Content-Type": "application/json" },
    method: "PATCH",
  });
  assert.equal(response.status, 200);
  return readDocument(baseUrl, documentId, headers);
}

async function waitForCatalog(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  documentId: string,
  title: string,
  attempt = 0,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/documents`, { headers });
  const catalog = (await response.json()) as {
    documents: readonly { metadata: { id: string; title: string } }[];
  };
  if (
    catalog.documents.some(
      (document) => document.metadata.id === documentId && document.metadata.title === title,
    )
  ) {
    return;
  }
  if (attempt >= 99) {
    assert.fail(
      `The latest document projection did not reach the workspace authority: ${JSON.stringify(catalog.documents)}`,
    );
  }
  await delay(25);
  return waitForCatalog(baseUrl, headers, documentId, title, attempt + 1);
}

async function startWrangler(directory: string): Promise<RunningWrangler> {
  const port = await availablePort();
  const child = spawn(
    path.resolve(import.meta.dirname, "../node_modules/.bin/wrangler"),
    ["dev", "--port", String(port), "--persist-to", directory],
    { cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore" },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForWrangler(baseUrl, child);
  return {
    baseUrl,
    stop: () => stopProcess(child),
  };
}

function stopProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}

async function waitForWrangler(
  baseUrl: string,
  child: ReturnType<typeof spawn>,
  attempt = 0,
): Promise<void> {
  try {
    if ((await fetch(`${baseUrl}/api/health`)).ok) return;
  } catch {
    // Wrangler is still starting.
  }
  if (attempt >= 199) {
    child.kill("SIGTERM");
    assert.fail("Wrangler did not start.");
  }
  await delay(50);
  return waitForWrangler(baseUrl, child, attempt + 1);
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
    throw new Error("Could not reserve a Cloudflare test port.");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cookieValue(cookies: string, name: string): string | undefined {
  return cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
