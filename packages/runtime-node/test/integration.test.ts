import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { startServer } from "../src/server.ts";

test(
  "local HTTP, WebSocket, publication, attachment, and restart behavior",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jot-integration-"));
    try {
      const first = await withServer(directory, async (baseUrl) => {
        const setup = await fetch(`${baseUrl}/api/auth/setup`, {
          body: JSON.stringify({ password: "correct horse battery staple" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(setup.status, 200);
        const cookies = setup.headers.getSetCookie();
        const cookieHeader = cookies.map((value) => value.split(";")[0]).join("; ");
        const csrf = cookieValue(cookieHeader, "jot_csrf");
        assert.ok(csrf);

        const keyResponse = await fetch(`${baseUrl}/api/api-keys`, {
          body: JSON.stringify({ label: "integration" }),
          headers: {
            "Content-Type": "application/json",
            Cookie: cookieHeader,
            Origin: baseUrl,
            "X-CSRF-Token": csrf,
          },
          method: "POST",
        });
        assert.equal(keyResponse.status, 200);
        const apiKey = ((await keyResponse.json()) as { key: string }).key;
        const authorization = { Authorization: `Bearer ${apiKey}` };

        const create = await fetch(`${baseUrl}/api/documents`, {
          body: JSON.stringify({
            allocateRfc: true,
            body: "Initial body",
            creationKey: "integration-document",
            title: "Integrated RFC",
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(create.status, 200);
        let document = (await create.json()) as DocumentWire;

        await appendOverWebSocket(
          baseUrl,
          document.metadata.id,
          cookieHeader,
          " from collaboration",
        );
        document = await readDocument(baseUrl, document.metadata.id, authorization);
        assert.equal(document.body, "Initial body from collaboration");

        const edit = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
          body: JSON.stringify({
            edits: [{ newText: "Durable", oldText: "Initial" }],
            expectedRevision: document.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(edit.status, 200);
        document = (await edit.json()) as DocumentWire;
        assert.equal(document.body, "Durable body from collaboration");

        const stale = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
          body: JSON.stringify({
            edits: [{ newText: "unsafe", oldText: "Durable" }],
            expectedRevision: 0,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(stale.status, 409);

        const comment = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/comments`, {
          body: JSON.stringify({
            authorDisplayName: "Integration owner",
            body: "Keep this decision explicit.",
            selection: { end: 7, start: 0 },
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(comment.status, 200);

        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const share = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/share`, {
          body: JSON.stringify({
            access: "view",
            expectedRevision: document.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "PATCH",
        });
        assert.equal(share.status, 200);
        const capabilityUrl = ((await share.json()) as { capabilityUrl: string }).capabilityUrl;
        const capability = new URL(capabilityUrl).searchParams.get("cap");
        assert.ok(capability);
        assert.equal(
          (
            await fetch(
              `${baseUrl}/api/documents/${document.metadata.id}?cap=${encodeURIComponent(capability)}`,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(
              `${baseUrl}/api/documents/${document.metadata.id}/edits?cap=${encodeURIComponent(capability)}`,
              {
                body: JSON.stringify({
                  edits: [{ newText: "wrong", oldText: "Durable" }],
                  expectedRevision: document.metadata.headRevision,
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              },
            )
          ).status,
          403,
        );

        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const metadata = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/metadata`, {
          body: JSON.stringify({
            expectedRevision: document.metadata.headRevision,
            visibility: "public",
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "PATCH",
        });
        assert.equal(metadata.status, 200);
        assert.equal((await fetch(`${baseUrl}/rfc/0001`)).status, 404);
        const publish = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(publish.status, 200);
        const published = await fetch(`${baseUrl}/rfc/0001`);
        assert.equal(published.status, 200);
        assert.match(await published.text(), /Integrated RFC/u);
        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const workingTitle = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/metadata`,
          {
            body: JSON.stringify({
              expectedRevision: document.metadata.headRevision,
              title: "Unpublished working title",
            }),
            headers: { ...authorization, "Content-Type": "application/json" },
            method: "PATCH",
          },
        );
        assert.equal(workingTitle.status, 200);
        const isolatedPublication = await (await fetch(`${baseUrl}/rfc/0001`)).text();
        assert.match(isolatedPublication, /Integrated RFC/u);
        assert.doesNotMatch(isolatedPublication, /Unpublished working title/u);

        const attachment = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/attachments`,
          {
            body: "attachment content",
            headers: {
              ...authorization,
              "Content-Type": "text/plain",
              "X-Jot-Filename": "decision.txt",
            },
            method: "POST",
          },
        );
        assert.equal(attachment.status, 200);
        const attachmentMetadata = (await attachment.json()) as { id: string };
        const downloaded = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/attachments/${attachmentMetadata.id}`,
          { headers: authorization },
        );
        assert.equal(await downloaded.text(), "attachment content");

        const backup = await fetch(`${baseUrl}/api/admin/backup`, { headers: authorization });
        assert.equal(backup.status, 200);
        assert.ok((await backup.arrayBuffer()).byteLength > 500);
        return { apiKey, documentId: document.metadata.id };
      });

      await withServer(directory, async (baseUrl) => {
        const authorization = { Authorization: `Bearer ${first.apiKey}` };
        const recovered = await readDocument(baseUrl, first.documentId, authorization);
        assert.equal(recovered.body, "Durable body from collaboration");
        assert.equal(recovered.comments.threads.length, 1);
        assert.equal((await fetch(`${baseUrl}/rfc/0001`)).status, 200);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

interface DocumentWire {
  readonly body: string;
  readonly comments: { readonly threads: readonly unknown[] };
  readonly metadata: {
    readonly headRevision: number;
    readonly id: string;
  };
}

async function withServer<A>(
  directory: string,
  callback: (baseUrl: string) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const running = yield* startServer({ dataDirectory: directory, port: 0 });
        const address = running.server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("The integration server did not expose a TCP address.");
        }
        return yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () => callback(`http://127.0.0.1:${address.port}`),
        });
      }),
    ),
  );
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

async function appendOverWebSocket(
  baseUrl: string,
  documentId: string,
  cookies: string,
  suffix: string,
): Promise<void> {
  const socket = new WebSocket(
    `${baseUrl.replace(/^http/u, "ws")}/api/documents/${documentId}/ws`,
    { headers: { Cookie: cookies, Origin: baseUrl } },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ protocolVersion: 1, type: "hello" }));
  const welcome = await nextSocketMessage(socket);
  assert.equal(welcome["type"], "welcome");
  const stateUpdate = typeof welcome["stateUpdate"] === "string" ? welcome["stateUpdate"] : "";
  const document = new Y.Doc();
  Y.applyUpdate(document, Buffer.from(stateUpdate, "base64"));
  let update: Uint8Array | undefined;
  document.on("update", (next, origin) => {
    if (origin === "integration") update = next;
  });
  document.transact(() => {
    const body = document.getText("body");
    body.insert(body.length, suffix);
  }, "integration");
  assert.ok(update);
  socket.send(
    JSON.stringify({
      clientUpdateId: "integration-update",
      type: "body-update",
      update: Buffer.from(update).toString("base64"),
    }),
  );
  const accepted = await nextSocketMessage(socket);
  assert.equal(accepted["type"], "update-accepted");
  socket.close();
  document.destroy();
}

function nextSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function cookieValue(cookies: string, name: string): string | undefined {
  return cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
