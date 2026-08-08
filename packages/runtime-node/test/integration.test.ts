import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { JotApplication } from "@earendil-works/jot-backend";
import { personId } from "@earendil-works/jot-core";

import { startServer } from "../src/server.ts";

test(
  "local HTTP, WebSocket, publication, attachment, and restart behavior",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jot-integration-"));
    try {
      const first = await withServer(directory, async (baseUrl, session) => {
        const agentInstructions = await fetch(`${baseUrl}/AGENTS.md`);
        assert.equal(agentInstructions.status, 200);
        assert.match(agentInstructions.headers.get("content-type") ?? "", /^text\/markdown/u);
        assert.ok((await agentInstructions.text()).includes(`base URL is ${baseUrl}`));

        const { cookieHeader, csrf } = session;

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
        const createdKey = (await keyResponse.json()) as {
          key: string;
          metadata: { personId: string };
        };
        assert.equal(createdKey.metadata.personId, "admin@example.com");
        const apiKey = createdKey.key;
        const authorization = { Authorization: `Bearer ${apiKey}` };

        const create = await fetch(`${baseUrl}/api/documents`, {
          body: JSON.stringify({
            allocateRfc: false,
            body: "Initial body",
            creationKey: "integration-document",
            title: "Integrated RFC",
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(create.status, 200);
        let document = (await create.json()) as DocumentWire;
        assert.equal(document.metadata.rfcNumber, undefined);
        const allocate = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/rfc`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(allocate.status, 200);
        const allocated = (await allocate.json()) as DocumentWire["metadata"];
        assert.equal(allocated.rfcNumber, 1);
        const allocateAgain = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/rfc`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(allocateAgain.status, 200);
        assert.equal(
          ((await allocateAgain.json()) as DocumentWire["metadata"]).headRevision,
          allocated.headRevision,
        );

        await appendOverWebSocket(
          baseUrl,
          document.metadata.id,
          cookieHeader,
          " from collaboration\n\n```ts\nconst value: number = 1;\n```",
        );
        document = await readDocument(baseUrl, document.metadata.id, authorization);
        assert.match(
          document.body,
          /---\n\n# Integrated RFC\n\nInitial body from collaboration\n\n```ts\nconst value: number = 1;\n```$/u,
        );

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
        assert.match(
          document.body,
          /---\n\n# Integrated RFC\n\nDurable body from collaboration\n\n```ts\nconst value: number = 1;\n```$/u,
        );
        const search = await fetch(
          `${baseUrl}/api/documents?q=${encodeURIComponent("rfc:1 state:draft durable")}`,
          { headers: authorization },
        );
        assert.equal(search.status, 200);
        assert.equal(
          ((await search.json()) as { documents: readonly DocumentWire[] }).documents[0]?.metadata
            .id,
          document.metadata.id,
        );

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
            authorDisplayName: "Integration Admin",
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
            authors: [
              {
                displayName: "Ada Lovelace",
                email: "ada@example.com",
                id: "ada@example.com",
              },
            ],
            expectedRevision: document.metadata.headRevision,
            targetDecisionDate: "2026-09-01",
            visibility: "public",
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "PATCH",
        });
        assert.equal(metadata.status, 200);
        const metadataResponse = (await metadata.json()) as DocumentWire["metadata"];
        const frontmatter = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
          body: JSON.stringify({
            edits: [
              {
                newText: "authors:\n  - ada@example.com",
                oldText: "authors: []",
              },
              { newText: "visibility: public", oldText: "visibility: workspace" },
              {
                newText: "labels:\n  - architecture\n  - platform",
                oldText: "labels: []",
              },
            ],
            expectedRevision: metadataResponse.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(frontmatter.status, 200);
        const workingLabels = await fetch(
          `${baseUrl}/api/documents?q=${encodeURIComponent("label:architecture")}`,
          { headers: authorization },
        );
        assert.equal(workingLabels.status, 200);
        const workingLabelDocuments = (await workingLabels.json()) as {
          documents: readonly { metadata: { id: string; labels: readonly string[] } }[];
        };
        assert.equal(workingLabelDocuments.documents[0]?.metadata.id, document.metadata.id);
        assert.deepEqual(workingLabelDocuments.documents[0]?.metadata.labels, [
          "architecture",
          "platform",
        ]);
        assert.equal((await fetch(`${baseUrl}/rfcs/0001`)).status, 404);
        const publish = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(publish.status, 200);
        const published = await fetch(`${baseUrl}/rfcs/0001`);
        assert.equal(published.status, 200);
        const legacyRfc = await fetch(`${baseUrl}/rfc/0001`, { redirect: "manual" });
        assert.equal(legacyRfc.status, 308);
        assert.equal(legacyRfc.headers.get("location"), "/rfcs/0001");
        const publishedCsp = published.headers.get("content-security-policy") ?? "";
        assert.match(publishedCsp, /style-src 'self' https:\/\/fonts\.googleapis\.com/u);
        assert.match(publishedCsp, /font-src 'self' https:\/\/fonts\.gstatic\.com/u);
        assert.doesNotMatch(publishedCsp, /style-src 'unsafe-inline'/u);
        const publishedHtml = await published.text();
        assert.match(publishedHtml, /Integrated RFC/u);
        assert.match(publishedHtml, /<title>Integrated RFC<\/title>/u);
        assert.match(publishedHtml, /class="public-hero"/u);
        assert.match(publishedHtml, /class="public-state" data-lifecycle-state="draft"/u);
        assert.match(publishedHtml, /class="public-metadata"/u);
        assert.match(publishedHtml, /mailto:ada@example\.com/u);
        assert.match(publishedHtml, />Ada Lovelace<\/a>/u);
        assert.match(publishedHtml, /href="\/keyword\/architecture"/u);
        assert.match(publishedHtml, /Target decision/u);
        assert.doesNotMatch(publishedHtml, /visibility: public/u);
        assert.match(publishedHtml, /class="tok-keyword">const<\/span>/u);
        assert.match(publishedHtml, /<link rel="stylesheet" href="\/fonts\.css">/u);
        assert.match(publishedHtml, /<link rel="stylesheet" href="\/public\.css">/u);
        assert.doesNotMatch(publishedHtml, /<style>/u);
        const statePage = await fetch(`${baseUrl}/state/draft`);
        assert.equal(statePage.status, 200);
        assert.match(await statePage.text(), /<title>Notes and RFCs<\/title>/u);
        const fontStylesheet = await fetch(`${baseUrl}/fonts.css`);
        assert.equal(fontStylesheet.status, 200);
        const fontStyles = await fontStylesheet.text();
        assert.match(fontStyles, /family=JetBrains\+Mono/u);
        assert.match(fontStyles, /family=Newsreader/u);
        const publicStylesheet = await fetch(`${baseUrl}/public.css`);
        assert.equal(publicStylesheet.status, 200);
        const publicStyles = await publicStylesheet.text();
        assert.match(publicStyles, /@import url\("\/syntax-theme\.css"\)/u);
        assert.match(publicStyles, /\.public-metadata/u);
        assert.match(publicStyles, /\.public-content-grid/u);
        const syntaxTheme = await fetch(`${baseUrl}/syntax-theme.css`);
        assert.equal(syntaxTheme.status, 200);
        assert.match(await syntaxTheme.text(), /\.tok-keyword/u);
        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const workingTitle = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
          body: JSON.stringify({
            edits: [
              {
                newText: "# Unpublished working title",
                oldText: "# Integrated RFC",
              },
            ],
            expectedRevision: document.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(workingTitle.status, 200);
        const workingTitleDocument = (await workingTitle.json()) as DocumentWire;
        assert.equal(workingTitleDocument.metadata.title, "Unpublished working title");
        const publishedDocument = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}?published=true`,
          { headers: authorization },
        );
        assert.equal(publishedDocument.status, 200);
        const publishedDocumentBody = (await publishedDocument.json()) as DocumentWire;
        assert.equal(publishedDocumentBody.metadata.title, "Integrated RFC");
        assert.match(publishedDocumentBody.body, /# Integrated RFC/u);
        assert.doesNotMatch(publishedDocumentBody.body, /Unpublished working title/u);
        const isolatedPublication = await (await fetch(`${baseUrl}/rfcs/0001`)).text();
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
        const attachmentUrl = `${baseUrl}/api/documents/${document.metadata.id}/attachments/${attachmentMetadata.id}`;
        const unpublish = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/unpublish`,
          { headers: authorization, method: "POST" },
        );
        assert.equal(unpublish.status, 200);
        assert.equal((await fetch(attachmentUrl)).status, 403);
        const downloaded = await fetch(attachmentUrl, { headers: authorization });
        assert.match(downloaded.headers.get("Content-Disposition") ?? "", /decision\.txt/u);
        assert.equal(await downloaded.text(), "attachment content");
        const republish = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(republish.status, 200);
        const publicAttachment = await fetch(attachmentUrl);
        assert.equal(publicAttachment.status, 200);
        assert.match(publicAttachment.headers.get("Cache-Control") ?? "", /public/u);

        const backup = await fetch(`${baseUrl}/api/admin/backup`, { headers: authorization });
        assert.equal(backup.status, 200);
        assert.ok((await backup.arrayBuffer()).byteLength > 500);

        await writeFile(
          path.join(
            directory,
            "objects",
            "workspaces",
            "local",
            "documents",
            document.metadata.id,
            "attachments",
            attachmentMetadata.id,
          ),
          "corrupted attachment",
        );
        const verification = await fetch(`${baseUrl}/api/admin/verify`, {
          headers: authorization,
        });
        assert.equal(verification.status, 200);
        assert.match(
          JSON.stringify((await verification.json()) as unknown),
          /Digest mismatch:.*attachments/u,
        );
        return { apiKey, documentId: document.metadata.id };
      });

      await withServer(directory, async (baseUrl) => {
        const authorization = { Authorization: `Bearer ${first.apiKey}` };
        const recovered = await readDocument(baseUrl, first.documentId, authorization);
        assert.match(
          recovered.body,
          /---\n\n# Unpublished working title\n\nDurable body from collaboration\n\n```ts\nconst value: number = 1;\n```$/u,
        );
        assert.equal(recovered.comments.threads.length, 1);
        assert.equal((await fetch(`${baseUrl}/rfcs/0001`)).status, 200);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("backup corruption is rejected and a fresh installation restores portably", async () => {
  const sourceDirectory = await mkdtemp(path.join(tmpdir(), "jot-backup-source-"));
  const targetDirectory = await mkdtemp(path.join(tmpdir(), "jot-backup-target-"));
  try {
    const source = await withServer(sourceDirectory, async (baseUrl, session) => {
      const authorization = await setupApiKey(baseUrl, "source backup", session);
      const created = await fetch(`${baseUrl}/api/documents`, {
        body: JSON.stringify({
          body: "Portable recovery body",
          creationKey: "portable-recovery",
          title: "Portable recovery",
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(created.status, 200);
      const document = (await created.json()) as DocumentWire;
      const backup = await fetch(`${baseUrl}/api/admin/backup`, { headers: authorization });
      assert.equal(backup.status, 200);
      return {
        archive: new Uint8Array(await backup.arrayBuffer()),
        authorization,
        documentId: document.metadata.id,
      };
    });

    await withServer(targetDirectory, async (baseUrl, session) => {
      const targetAuthorization = await setupApiKey(baseUrl, "restore operator", session);
      const decoded = JSON.parse(new TextDecoder().decode(source.archive)) as {
        objects: { digest: string }[];
      };
      const firstObject = decoded.objects[0];
      assert.ok(firstObject);
      firstObject.digest = "0".repeat(64);
      const corrupted = new TextEncoder().encode(JSON.stringify(decoded));
      const rejected = await fetch(`${baseUrl}/api/admin/restore`, {
        body: corrupted,
        headers: { ...targetAuthorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(rejected.status, 400);

      const restored = await fetch(`${baseUrl}/api/admin/restore`, {
        body: source.archive,
        headers: { ...targetAuthorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(restored.status, 200);
      const document = await readDocument(baseUrl, source.documentId, source.authorization);
      assert.match(document.body, /---\n\n# Portable recovery\n\nPortable recovery body$/u);
      const verification = await fetch(`${baseUrl}/api/admin/verify`, {
        headers: source.authorization,
      });
      const verificationResult = (await verification.json()) as {
        checkedObjects: number;
        errors: unknown[];
      };
      assert.ok(verificationResult.checkedObjects > 0);
      assert.deepEqual(verificationResult.errors, []);
    });
  } finally {
    await Promise.all([
      rm(sourceDirectory, { force: true, recursive: true }),
      rm(targetDirectory, { force: true, recursive: true }),
    ]);
  }
});

interface DocumentWire {
  readonly body: string;
  readonly comments: { readonly threads: readonly unknown[] };
  readonly metadata: {
    readonly headRevision: number;
    readonly id: string;
    readonly publishedRevision?: number | undefined;
    readonly rfcNumber?: number | undefined;
    readonly title: string;
  };
}

interface TestSession {
  readonly cookieHeader: string;
  readonly csrf: string;
}

async function withServer<A>(
  directory: string,
  callback: (baseUrl: string, session: TestSession) => Promise<A>,
): Promise<A> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const running = yield* startServer({ dataDirectory: directory, port: 0 });
        const address = running.server.address();
        if (address === null || typeof address === "string") {
          return yield* Effect.die("The integration server did not expose a TCP address.");
        }
        const accountId = yield* personId("admin@example.com");
        const session = yield* Effect.promise(() =>
          running.runtime.runPromise(
            Effect.flatMap(JotApplication, (application) =>
              application.loginWorkspaceIdentity({
                displayName: "Integration Admin",
                email: "admin@example.com",
                personId: accountId,
                role: "administrator",
              }),
            ),
          ),
        );
        return yield* Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            callback(`http://127.0.0.1:${address.port}`, {
              cookieHeader: `jot_session=${session.sessionToken}; jot_csrf=${session.csrfToken}`,
              csrf: session.csrfToken,
            }),
        });
      }),
    ),
  );
}

async function setupApiKey(
  baseUrl: string,
  label: string,
  session: TestSession,
): Promise<Readonly<Record<string, string>>> {
  const keyResponse = await fetch(`${baseUrl}/api/api-keys`, {
    body: JSON.stringify({ label }),
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookieHeader,
      Origin: baseUrl,
      "X-CSRF-Token": session.csrf,
    },
    method: "POST",
  });
  assert.equal(keyResponse.status, 200);
  const key = ((await keyResponse.json()) as { key: string }).key;
  return { Authorization: `Bearer ${key}` };
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
