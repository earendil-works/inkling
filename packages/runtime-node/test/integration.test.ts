import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Effect } from "effect";
import { WebSocket } from "ws";
import * as Y from "yjs";

import { InklingApplication } from "@earendil-works/inkling-backend";
import { personId } from "@earendil-works/inkling-core";

import { startServer } from "../src/server.ts";
import type { RunningServer } from "../src/server.ts";

test(
  "local HTTP, WebSocket, publication, attachment, and restart behavior",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "inkling-integration-"));
    try {
      const first = await withServer(directory, async (baseUrl, session) => {
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
        const keyListResponse = await fetch(`${baseUrl}/api/api-keys`, {
          headers: { Cookie: cookieHeader },
        });
        assert.equal(keyListResponse.status, 200);
        const keyList = (await keyListResponse.json()) as { id: string; revealable: boolean }[];
        assert.equal(keyList[0]?.revealable, true);
        const revealedKeyResponse = await fetch(`${baseUrl}/api/api-keys/${keyList[0]?.id}`, {
          headers: { Cookie: cookieHeader },
        });
        assert.equal(revealedKeyResponse.status, 200);
        assert.equal(((await revealedKeyResponse.json()) as { key: string }).key, apiKey);
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
        assert.deepEqual(document.metadata.authors, [
          {
            displayName: "Integration Admin",
            email: "admin@example.com",
            id: "admin@example.com",
          },
        ]);
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
        const share = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/shares`, {
          body: JSON.stringify({
            access: "view",
            expectedRevision: document.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(share.status, 200);
        const shared = (await share.json()) as {
          links: { id: string; passwordProtected: boolean; url: string }[];
        };
        assert.equal(shared.links.length, 1);
        assert.equal(shared.links[0]?.passwordProtected, false);
        const capabilityUrl = shared.links[0]?.url;
        assert.ok(capabilityUrl);
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

        const retained = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/shares`, {
          headers: authorization,
        });
        assert.equal(retained.status, 200);
        assert.equal(
          ((await retained.json()) as { links: { url: string }[] }).links[0]?.url,
          capabilityUrl,
        );

        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const duplicate = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/shares`, {
          body: JSON.stringify({
            access: "view",
            expectedRevision: document.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(duplicate.status, 409);

        const protectedShare = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/shares`,
          {
            body: JSON.stringify({
              access: "view",
              expectedRevision: document.metadata.headRevision,
              password: "correct horse battery staple",
            }),
            headers: { ...authorization, "Content-Type": "application/json" },
            method: "POST",
          },
        );
        assert.equal(protectedShare.status, 200);
        const protectedLinks = (await protectedShare.json()) as {
          links: { id: string; passwordProtected: boolean; url: string }[];
        };
        const protectedLink = protectedLinks.links.find((link) => link.passwordProtected);
        assert.ok(protectedLink);
        const protectedCapability = new URL(protectedLink.url).searchParams.get("cap");
        assert.ok(protectedCapability);
        const protectedDocumentUrl = `${baseUrl}/api/documents/${document.metadata.id}?cap=${encodeURIComponent(protectedCapability)}`;
        const passwordRequired = await fetch(protectedDocumentUrl);
        assert.equal(passwordRequired.status, 401);
        assert.equal(
          ((await passwordRequired.json()) as { code: string }).code,
          "capability_password_required",
        );
        const wrongPassword = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/shares/unlock?cap=${encodeURIComponent(protectedCapability)}`,
          {
            body: JSON.stringify({ password: "incorrect password" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        assert.equal(wrongPassword.status, 401);
        const unlocked = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/shares/unlock?cap=${encodeURIComponent(protectedCapability)}`,
          {
            body: JSON.stringify({ password: "correct horse battery staple" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        assert.equal(unlocked.status, 200);
        const shareCookie = unlocked.headers.get("set-cookie");
        assert.ok(shareCookie);
        assert.equal(
          (await fetch(protectedDocumentUrl, { headers: { Cookie: shareCookie } })).status,
          200,
        );

        document = await readDocument(baseUrl, document.metadata.id, authorization);
        const deletedShare = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}/shares/${shared.links[0]?.id}?expectedRevision=${document.metadata.headRevision}`,
          { headers: authorization, method: "DELETE" },
        );
        assert.equal(deletedShare.status, 200);
        assert.equal(((await deletedShare.json()) as { links: unknown[] }).links.length, 1);
        assert.equal(
          (
            await fetch(
              `${baseUrl}/api/documents/${document.metadata.id}?cap=${encodeURIComponent(capability)}`,
            )
          ).status,
          401,
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
                oldText: "authors:\n  - admin@example.com",
              },
              { newText: "visibility: public", oldText: "visibility: private" },
              {
                newText: "labels:\n  - architecture\n  - platform",
                oldText: "labels: []",
              },
              {
                newText:
                  "```ts\nconst value: number = 1;\n```\n\n[Recording](https://videos.example/watch?signature=a%2Bb&__require_auth=1&part=2#chapter)",
                oldText: "```ts\nconst value: number = 1;\n```",
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
        const unavailableRfc = await fetch(`${baseUrl}/rfc/0001`);
        assert.equal(unavailableRfc.status, 404);
        assert.match(unavailableRfc.headers.get("content-type") ?? "", /^text\/html/u);
        const unavailableHtml = await unavailableRfc.text();
        assert.ok(unavailableHtml.indexOf("INKLING AGENT HANDOFF") < 128);
        assert.ok(unavailableHtml.indexOf("/mcp") < 256);
        const publish = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(publish.status, 200);
        const publicationMetadata = (await publish.json()) as DocumentWire["metadata"];
        const published = await fetch(`${baseUrl}/rfc/0001`);
        assert.equal(published.status, 200);
        const anonymousCatalog = await fetch(`${baseUrl}/api/public/documents`);
        assert.equal(anonymousCatalog.status, 200);
        assert.match(anonymousCatalog.headers.get("cache-control") ?? "", /s-maxage=60/u);
        const anonymousDocuments = (await anonymousCatalog.json()) as {
          documents: readonly { metadata: { id: string; title: string } }[];
        };
        assert.equal(anonymousDocuments.documents.length, 1);
        assert.equal(anonymousDocuments.documents[0]?.metadata.id, document.metadata.id);
        assert.equal(anonymousDocuments.documents[0]?.metadata.title, "Integrated RFC");
        assert.doesNotMatch(JSON.stringify(anonymousDocuments), /videos\.example|signature=a/u);
        const protectedSearch = await fetch(
          `${baseUrl}/api/public/documents?q=${encodeURIComponent("videos.example")}`,
        );
        assert.deepEqual((await protectedSearch.json()) as { documents: unknown[] }, {
          documents: [],
        });
        const pluralRfc = await fetch(`${baseUrl}/rfcs/0001`, { redirect: "manual" });
        assert.equal(pluralRfc.status, 308);
        assert.equal(pluralRfc.headers.get("location"), "/rfc/0001");
        const numericRfc = await fetch(`${baseUrl}/0001/`, { redirect: "manual" });
        assert.equal(numericRfc.status, 308);
        assert.equal(numericRfc.headers.get("location"), "/rfc/0001");
        const publishedCsp = published.headers.get("content-security-policy") ?? "";
        assert.match(publishedCsp, /style-src 'self' https:\/\/fonts\.googleapis\.com/u);
        assert.match(publishedCsp, /font-src 'self' https:\/\/fonts\.gstatic\.com/u);
        assert.doesNotMatch(publishedCsp, /style-src 'unsafe-inline'/u);
        const publishedHtml = await published.text();
        assert.ok(publishedHtml.indexOf("INKLING AGENT HANDOFF") < 128);
        assert.ok(publishedHtml.indexOf("/mcp") < 256);
        assert.match(publishedHtml, /Integrated RFC/u);
        assert.match(publishedHtml, /<title>Integrated RFC<\/title>/u);
        assert.match(publishedHtml, /class="public-hero"/u);
        assert.match(
          publishedHtml,
          /class="public-state" data-lifecycle-state="draft" href="\/\?q=state%3Adraft"/u,
        );
        assert.match(publishedHtml, /class="public-hero-badges"/u);
        assert.doesNotMatch(publishedHtml, /class="public-topline"/u);
        assert.match(
          publishedHtml,
          /class="public-visibility" data-document-visibility="public">public/u,
        );
        assert.match(publishedHtml, /class="public-metadata"/u);
        assert.match(publishedHtml, /mailto:ada@example\.com/u);
        assert.match(publishedHtml, />Ada Lovelace<\/a>/u);
        assert.match(publishedHtml, /href="\/keyword\/architecture"/u);
        assert.match(publishedHtml, /Target decision/u);
        assert.doesNotMatch(publishedHtml, /visibility: public/u);
        assert.match(publishedHtml, /class="tok-keyword">const<\/span>/u);
        assert.match(publishedHtml, /<link rel="stylesheet" href="\/theme\.css">/u);
        assert.match(publishedHtml, /<link rel="stylesheet" href="\/public\.css">/u);
        assert.doesNotMatch(publishedHtml, /<style>/u);
        assert.doesNotMatch(publishedHtml, /videos\.example|signature=a/u);
        const protectedHref = /href="(\/auth\/link\/[^"]+)"/u.exec(publishedHtml)?.[1];
        assert.equal(
          protectedHref,
          `/auth/link/${document.metadata.id}/${publicationMetadata.publishedRevision}/0`,
        );
        const anonymousProtectedLink = await fetch(`${baseUrl}${protectedHref}`, {
          redirect: "manual",
        });
        assert.equal(anonymousProtectedLink.status, 302);
        assert.equal(
          anonymousProtectedLink.headers.get("location"),
          `/api/auth/google/start?next=${encodeURIComponent(protectedHref ?? "")}`,
        );
        const authenticatedProtectedLink = await fetch(`${baseUrl}${protectedHref}`, {
          headers: { Cookie: cookieHeader },
          redirect: "manual",
        });
        assert.equal(authenticatedProtectedLink.status, 302);
        assert.equal(
          authenticatedProtectedLink.headers.get("location"),
          "https://videos.example/watch?signature=a%2Bb&part=2#chapter",
        );
        assert.equal(authenticatedProtectedLink.headers.get("cache-control"), "no-store");
        assert.equal(authenticatedProtectedLink.headers.get("referrer-policy"), "no-referrer");

        const cliConfig = path.join(directory, "agent-cli-config.json");
        await writeFile(
          cliConfig,
          `${JSON.stringify({
            active: "linked",
            instances: [{ apiKey, baseUrl, name: "linked" }],
            version: 1,
          })}\n`,
          { mode: 0o600 },
        );
        const linkedRead = await runCommand(
          process.execPath,
          [
            path.resolve(import.meta.dirname, "../../cli/src/main.ts"),
            "read",
            `${baseUrl}/rfc/0001`,
          ],
          { ...process.env, INKLING_CONFIG: cliConfig },
        );
        assert.equal(linkedRead.status, 0, linkedRead.stderr);
        assert.match(linkedRead.stdout, /RFC 0001: Integrated RFC/u);
        assert.match(linkedRead.stdout, /Durable body from collaboration/u);

        const statePage = await fetch(`${baseUrl}/state/draft`);
        assert.equal(statePage.status, 200);
        assert.match(await statePage.text(), /<title>Inkling<\/title>/u);
        const themeStylesheet = await fetch(`${baseUrl}/theme.css`);
        assert.equal(themeStylesheet.status, 200);
        const themeStyles = await themeStylesheet.text();
        assert.match(themeStyles, /default Elanor theme/u);
        assert.doesNotMatch(themeStyles, /:root/u);
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
        const anonymousPublishedDocument = await fetch(
          `${baseUrl}/api/documents/${document.metadata.id}?published=true`,
        );
        assert.equal(anonymousPublishedDocument.status, 200);
        const anonymousPublishedBody = (await anonymousPublishedDocument.json()) as DocumentWire;
        assert.equal(anonymousPublishedBody.metadata.title, "Integrated RFC");
        assert.match(anonymousPublishedBody.body, /# Integrated RFC/u);
        assert.match(anonymousPublishedBody.body, /\/auth\/link\//u);
        assert.doesNotMatch(anonymousPublishedBody.body, /videos\.example|__require_auth/u);
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
              "X-Inkling-Filename": "decision.txt",
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
        const keyId = first.apiKey.split(".")[0];
        assert.ok(keyId);
        const revealedAfterRestart = await fetch(`${baseUrl}/api/api-keys/${keyId}`, {
          headers: authorization,
        });
        assert.equal(revealedAfterRestart.status, 200);
        assert.equal(((await revealedAfterRestart.json()) as { key: string }).key, first.apiKey);
        const recovered = await readDocument(baseUrl, first.documentId, authorization);
        assert.match(
          recovered.body,
          /---\n\n# Unpublished working title\n\nDurable body from collaboration\n\n```ts\nconst value: number = 1;\n```\n\n\[Recording\]/u,
        );
        assert.equal(recovered.comments.threads.length, 1);
        assert.equal((await fetch(`${baseUrl}/rfc/0001`)).status, 200);
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("application pages render on the server with the reader's data", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-render-"));
  try {
    await withServer(directory, async (baseUrl, session) => {
      const created = await fetch(`${baseUrl}/api/documents`, {
        body: JSON.stringify({
          body: "# Rendered on the server\n\nNo waiting for scripts.\n",
          creationKey: "server-render",
          title: "Rendered on the server",
        }),
        headers: {
          "Content-Type": "application/json",
          Cookie: session.cookieHeader,
          Origin: baseUrl,
          "X-CSRF-Token": session.csrf,
        },
        method: "POST",
      });
      assert.equal(created.status, 200);
      const documentId = ((await created.json()) as { metadata: { id: string } }).metadata.id;

      const workspace = await fetch(`${baseUrl}/`, { headers: { Cookie: session.cookieHeader } });
      assert.equal(workspace.status, 200);
      assert.equal(workspace.headers.get("Cache-Control"), "private, no-cache");
      const workspaceHtml = await workspace.text();
      assert.match(workspaceHtml, new RegExp(`data-catalog-document-id="${documentId}"`, "u"));
      assert.match(workspaceHtml, /id="inkling-initial-route"/u);

      const editor = await fetch(`${baseUrl}/documents/${documentId}/edit`, {
        headers: { Cookie: session.cookieHeader },
      });
      const editorHtml = await editor.text();
      assert.match(editorHtml, /<title>Rendered on the server<\/title>/u);
      assert.match(editorHtml, /data-dgst="inkling-client-only"/u);

      // Anonymous readers cannot load private documents, so they get the static shell.
      const anonymous = await fetch(`${baseUrl}/documents/${documentId}`);
      const anonymousHtml = await anonymous.text();
      assert.match(anonymousHtml, /INKLING AGENT HANDOFF<\/h1>/u);
      assert.doesNotMatch(anonymousHtml, /Rendered on the server|inkling-initial-route/u);

      const entryScript = /<script type="module" crossorigin src="(\/assets\/[^"]+)"/u.exec(
        workspaceHtml,
      )?.[1];
      assert.ok(entryScript);
      const asset = await fetch(`${baseUrl}${entryScript}`);
      assert.equal(asset.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
      await asset.arrayBuffer();
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("search indexes working passages and published revisions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-search-"));
  try {
    await withServer(directory, async (baseUrl, session) => {
      const authorization = await setupApiKey(baseUrl, "search", session);
      const create = async (title: string, body: string): Promise<DocumentWire> => {
        const response = await fetch(`${baseUrl}/api/documents`, {
          body: JSON.stringify({ allocateRfc: false, body, creationKey: title, title }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(response.status, 200);
        return (await response.json()) as DocumentWire;
      };
      const search = async (query: string) => {
        const response = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(query)}`, {
          headers: authorization,
        });
        assert.equal(response.status, 200);
        return (
          (await response.json()) as {
            passages: readonly {
              documentId: string;
              endLine: number;
              headingPath: readonly string[];
              matchedBy: readonly string[];
              startLine: number;
              title: string;
            }[];
            semantic: boolean;
          }
        ).passages;
      };

      const retries = await create(
        "Retry policy",
        "Overview of client behavior.\n\n## Backoff\n\nRetries use exponential backoff with jitter.\n\n## Limits\n\nAt most five attempts.",
      );
      const caching = await create("Caching", "Caches never retry failed origin fetches.");

      const passages = await search("backoff");
      assert.equal(passages.length, 1);
      assert.equal(passages[0]?.documentId, retries.metadata.id);
      assert.deepEqual(passages[0]?.headingPath, ["Retry policy", "Backoff"]);
      assert.deepEqual(passages[0]?.matchedBy, ["keyword"]);
      const lines = (await readDocument(baseUrl, retries.metadata.id, authorization)).body
        .split("\n")
        .slice((passages[0]?.startLine ?? 1) - 1, passages[0]?.endLine)
        .join("\n");
      assert.match(lines, /## Backoff\n\nRetries use exponential backoff with jitter\./u);
      assert.deepEqual(
        [...new Set((await search("retr")).map((passage) => passage.documentId))].toSorted(),
        [retries.metadata.id, caching.metadata.id].toSorted(),
      );
      assert.deepEqual(await search("backoff -jitter"), []);
      assert.deepEqual(await search("backoff label:unrelated"), []);
      const filtersOnly = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("is:note")}`, {
        headers: authorization,
      });
      assert.equal(filtersOnly.status, 400);
      const anonymous = await fetch(`${baseUrl}/api/search?q=backoff`);
      assert.equal(anonymous.status, 403);

      const catalog = await fetch(`${baseUrl}/api/documents?q=${encodeURIComponent("jitter")}`, {
        headers: authorization,
      });
      const listed = (await catalog.json()) as {
        documents: readonly { excerpt: string; metadata: { id: string } }[];
      };
      assert.deepEqual(
        listed.documents.map((document) => document.metadata.id),
        [retries.metadata.id],
      );
      assert.match(listed.documents[0]?.excerpt ?? "", /exponential backoff with jitter/u);

      const visibility = await fetch(`${baseUrl}/api/documents/${retries.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "visibility: public", oldText: "visibility: private" }],
          expectedRevision: retries.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(visibility.status, 200);
      const publish = await fetch(`${baseUrl}/api/documents/${retries.metadata.id}/publish`, {
        headers: authorization,
        method: "POST",
      });
      assert.equal(publish.status, 200);
      const published = (await publish.json()) as DocumentWire["metadata"];
      const draft = await fetch(`${baseUrl}/api/documents/${retries.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "decorrelated delays", oldText: "exponential backoff with jitter" }],
          expectedRevision: published.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(draft.status, 200);
      const publicSearch = async (query: string) =>
        (
          (await (
            await fetch(`${baseUrl}/api/public/documents?q=${encodeURIComponent(query)}`)
          ).json()) as { documents: readonly { metadata: { id: string } }[] }
        ).documents.map((document) => document.metadata.id);
      assert.deepEqual(await publicSearch("exponential backoff"), [retries.metadata.id]);
      assert.deepEqual(await publicSearch("decorrelated"), []);
      assert.deepEqual(
        (await search("decorrelated")).map((passage) => passage.documentId),
        [retries.metadata.id],
      );
      assert.deepEqual(await search("exponential"), []);

      const rebuild = await fetch(`${baseUrl}/api/admin/search/rebuild`, {
        headers: authorization,
        method: "POST",
      });
      assert.equal(rebuild.status, 200);
      assert.deepEqual(await rebuild.json(), { errors: [], indexedDocuments: 2 });
      assert.equal((await search("decorrelated")).length, 1);
      assert.deepEqual(await publicSearch("exponential backoff"), [retries.metadata.id]);

      const deleted = await fetch(
        `${baseUrl}/api/documents/${caching.metadata.id}?expectedRevision=${caching.metadata.headRevision}`,
        { headers: authorization, method: "DELETE" },
      );
      assert.equal(deleted.status, 200);
      assert.deepEqual(
        [...new Set((await search("retr")).map((passage) => passage.documentId))],
        [retries.metadata.id],
      );
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("references resolve the sections each reader may open", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-references-"));
  try {
    await withServer(directory, async (baseUrl, session) => {
      const authorization = await setupApiKey(baseUrl, "references", session);
      const json = { ...authorization, "Content-Type": "application/json" };
      const create = async (
        title: string,
        body: string,
        allocateRfc: boolean,
      ): Promise<DocumentWire> => {
        const response = await fetch(`${baseUrl}/api/documents`, {
          body: JSON.stringify({
            allocateRfc,
            body,
            creationKey: title,
            title,
          }),
          headers: json,
          method: "POST",
        });
        assert.equal(response.status, 200);
        return (await response.json()) as DocumentWire;
      };
      const makePublic = async (document: DocumentWire): Promise<void> => {
        const response = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
          body: JSON.stringify({
            edits: [
              {
                newText: "visibility: public",
                oldText: "visibility: private",
              },
            ],
            expectedRevision: document.metadata.headRevision,
          }),
          headers: json,
          method: "POST",
        });
        assert.equal(response.status, 200);
      };
      const publish = async (document: DocumentWire): Promise<number> => {
        const response = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
          headers: authorization,
          method: "POST",
        });
        assert.equal(response.status, 200);
        return ((await response.json()) as DocumentWire["metadata"]).publishedRevision ?? -1;
      };
      const resolve = async (
        headers: Readonly<Record<string, string>>,
        keys: readonly string[],
      ): Promise<Record<string, unknown>> => {
        const query = keys.map((key) => `ref=${encodeURIComponent(key)}`).join("&");
        const response = await fetch(`${baseUrl}/api/references?${query}`, {
          headers,
        });
        assert.equal(response.status, 200);
        return ((await response.json()) as { references: Record<string, unknown> }).references;
      };

      const storage = await create(
        "Storage",
        "## Summary\n\nShort.\n\n## Design\n\n### Motivation\n\nWhy.",
        true,
      );
      await makePublic(storage);
      await publish(storage);
      const acquisition = await create("Acquisition", "## Secret plan\n\nHidden.", true);
      await publish(acquisition);
      const note = await create("Meeting", "## Hidden notes\n\nPrivate.", false);
      const source = await create(
        "Overview",
        [
          "## Context",
          "",
          "- <rfc:1#motivation>",
          "- <rfc:2#secret-plan>",
          `- [](doc:${note.metadata.id}#hidden-notes)`,
          "- [](#context)",
        ].join("\n"),
        true,
      );
      await makePublic(source);
      const sourceRevision = await publish(source);
      const keys = [
        "rfc:1#motivation",
        "rfc:2#secret-plan",
        `doc:${note.metadata.id}#hidden-notes`,
      ];

      assert.deepEqual(await resolve(authorization, keys), {
        [`doc:${note.metadata.id}#hidden-notes`]: {
          href: `/documents/${note.metadata.id}`,
          section: { id: "hidden-notes", text: "Hidden notes" },
          status: "available",
          title: "Meeting",
        },
        "rfc:1#motivation": {
          href: "/rfc/0001",
          rfcNumber: 1,
          section: { id: "motivation", number: "2.1", text: "Motivation" },
          status: "available",
          title: "Storage",
        },
        "rfc:2#secret-plan": {
          href: "/rfc/0002",
          rfcNumber: 2,
          section: { id: "secret-plan", number: "1", text: "Secret plan" },
          status: "available",
          title: "Acquisition",
        },
      });
      const anonymous = await resolve({}, keys);
      assert.equal((anonymous["rfc:1#motivation"] as { status: string }).status, "available");
      assert.deepEqual(anonymous["rfc:2#secret-plan"], {
        status: "unavailable",
      });
      assert.deepEqual(anonymous[`doc:${note.metadata.id}#hidden-notes`], {
        status: "unavailable",
      });

      const page = await fetch(`${baseUrl}/rfc/0003`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /href="\/rfc\/0001#motivation"[^>]*>RFC 0001 §2\.1 Motivation<\/a>/u);
      const redirect = `/auth/reference/${source.metadata.id}/${sourceRevision}/1`;
      assert.match(html, new RegExp(`href="${redirect}"[^>]*>RFC 0002 \\(unavailable\\)</a>`, "u"));
      assert.match(html, />Unavailable document<\/a>/u);
      assert.match(html, /href="#context"[^>]*>§1 Context<\/a>/u);
      assert.match(html, /<span class="inkling-section-number">1<\/span> Context/u);
      assert.doesNotMatch(html, /secret-plan|hidden-notes|Acquisition|Meeting/u);

      const anonymousBody = (
        (await (
          await fetch(`${baseUrl}/api/documents/${source.metadata.id}?published=true`)
        ).json()) as DocumentWire
      ).body;
      assert.match(anonymousBody, /<rfc:1#motivation>/u);
      assert.match(
        anonymousBody,
        new RegExp(`\\[RFC 0002 \\(unavailable\\)\\]\\(${redirect}\\)`, "u"),
      );
      assert.doesNotMatch(anonymousBody, /secret-plan|hidden-notes/u);

      const signIn = await fetch(`${baseUrl}${redirect}`, {
        redirect: "manual",
      });
      assert.equal(signIn.status, 302);
      assert.equal(
        signIn.headers.get("location"),
        `/api/auth/google/start?next=${encodeURIComponent(redirect)}`,
      );
      const member = await fetch(`${baseUrl}${redirect}`, {
        headers: { Cookie: session.cookieHeader },
        redirect: "manual",
      });
      assert.equal(member.status, 302);
      assert.equal(member.headers.get("location"), "/rfc/0002#secret-plan");
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("document history is available over HTTP and restores forward", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-history-"));
  try {
    await withServer(directory, async (baseUrl, session) => {
      const authorization = await setupApiKey(baseUrl, "history operator", session);
      const createdResponse = await fetch(`${baseUrl}/api/documents`, {
        body: JSON.stringify({
          body: "first version",
          creationKey: "history-document",
          title: "History document",
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(createdResponse.status, 200);
      const created = (await createdResponse.json()) as DocumentWire;
      const firstEdit = await fetch(`${baseUrl}/api/documents/${created.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "second version", oldText: "first version" }],
          expectedRevision: created.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(firstEdit.status, 200);
      const second = (await firstEdit.json()) as DocumentWire;
      const secondEdit = await fetch(`${baseUrl}/api/documents/${created.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "third version", oldText: "second version" }],
          expectedRevision: second.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(secondEdit.status, 200);
      const third = (await secondEdit.json()) as DocumentWire;

      const historyResponse = await fetch(
        `${baseUrl}/api/documents/${created.metadata.id}/history`,
        { headers: authorization },
      );
      assert.equal(historyResponse.status, 200);
      const history = (await historyResponse.json()) as {
        versions: {
          actor?: { id?: string; kind: string } | undefined;
          kind: string;
          revision: number;
          sequence: number;
        }[];
      };
      assert.deepEqual(
        history.versions.map((version) => version.revision),
        [0, 1, 2],
      );
      assert.equal(history.versions[0]?.kind, "snapshot");
      assert.deepEqual(
        history.versions.slice(1).map((version) => ({
          id: version.actor?.id,
          kind: version.actor?.kind,
        })),
        [
          { id: "admin@example.com", kind: "api-key" },
          { id: "admin@example.com", kind: "api-key" },
        ],
      );
      assert.equal(
        (await fetch(`${baseUrl}/api/documents/${created.metadata.id}/history`)).status,
        403,
      );

      const firstRevision = await fetch(
        `${baseUrl}/api/documents/${created.metadata.id}/history/0`,
        { headers: authorization },
      );
      assert.equal(firstRevision.status, 200);
      assert.match(((await firstRevision.json()) as DocumentWire).body, /first version$/u);

      const restoredResponse = await fetch(
        `${baseUrl}/api/documents/${created.metadata.id}/history/0/restore`,
        {
          body: JSON.stringify({ expectedRevision: third.metadata.headRevision }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        },
      );
      assert.equal(restoredResponse.status, 200);
      const restored = (await restoredResponse.json()) as DocumentWire;
      assert.equal(restored.metadata.headRevision, third.metadata.headRevision + 1);
      assert.match(restored.body, /first version$/u);

      const retainedThird = await fetch(
        `${baseUrl}/api/documents/${created.metadata.id}/history/2`,
        { headers: authorization },
      );
      assert.equal(retainedThird.status, 200);
      assert.match(((await retainedThird.json()) as DocumentWire).body, /third version$/u);
      const staleRestore = await fetch(
        `${baseUrl}/api/documents/${created.metadata.id}/history/1/restore`,
        {
          body: JSON.stringify({ expectedRevision: third.metadata.headRevision }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        },
      );
      assert.equal(staleRestore.status, 409);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("documents move through Trash, restore, and permanent deletion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-trash-"));
  try {
    const first = await withServer(directory, async (baseUrl, session, running) => {
      const authorization = await setupApiKey(baseUrl, "trash operator", session);
      const createdResponse = await fetch(`${baseUrl}/api/documents`, {
        body: JSON.stringify({
          body: "Body retained while recoverable",
          creationKey: "trash-document",
          title: "Recoverable document",
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(createdResponse.status, 200);
      let document = (await createdResponse.json()) as DocumentWire;
      const publicBody = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [{ newText: "visibility: public", oldText: "visibility: private" }],
          expectedRevision: document.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(publicBody.status, 200);
      assert.equal(
        (
          await fetch(`${baseUrl}/api/documents/${document.metadata.id}/publish`, {
            headers: authorization,
            method: "POST",
          })
        ).status,
        200,
      );
      document = await readDocument(baseUrl, document.metadata.id, authorization);
      assert.equal(
        (await fetch(`${baseUrl}/api/public/documents/${document.metadata.id}`)).status,
        200,
      );

      const deleted = await fetch(
        `${baseUrl}/api/documents/${document.metadata.id}?expectedRevision=${document.metadata.headRevision}`,
        { headers: authorization, method: "DELETE" },
      );
      assert.equal(deleted.status, 200);
      assert.equal(
        (
          await fetch(
            `${baseUrl}/api/documents/${document.metadata.id}?expectedRevision=${document.metadata.headRevision}`,
            { headers: authorization, method: "DELETE" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          (await (await fetch(`${baseUrl}/api/documents`, { headers: authorization })).json()) as {
            documents: unknown[];
          }
        ).documents.length,
        0,
      );
      const trashResponse = await fetch(`${baseUrl}/api/trash`, { headers: authorization });
      assert.equal(trashResponse.status, 200);
      const trash = (await trashResponse.json()) as { documents: DocumentWire[] };
      assert.equal(trash.documents.length, 1);
      assert.equal(trash.documents[0]?.metadata.id, document.metadata.id);
      assert.ok(trash.documents[0]?.metadata.deletedAt);
      assert.equal(
        (await fetch(`${baseUrl}/api/public/documents/${document.metadata.id}`)).status,
        404,
      );

      const trashed = trash.documents[0];
      assert.ok(trashed);
      const deletedReader = await fetch(
        `${baseUrl}/api/documents/${document.metadata.id}?published=true`,
        { headers: authorization },
      );
      assert.equal(deletedReader.status, 200);
      assert.equal(((await deletedReader.json()) as DocumentWire).body, "");
      const trashEdit = await fetch(`${baseUrl}/api/documents/${document.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [
            {
              newText: "Body edited while in Trash",
              oldText: "Body retained while recoverable",
            },
          ],
          expectedRevision: trashed.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(trashEdit.status, 200);
      const editedInTrash = (await trashEdit.json()) as DocumentWire;
      assert.ok(editedInTrash.metadata.deletedAt);
      const restoredResponse = await fetch(
        `${baseUrl}/api/documents/${document.metadata.id}/restore?expectedRevision=${editedInTrash.metadata.headRevision}`,
        { headers: authorization, method: "POST" },
      );
      assert.equal(restoredResponse.status, 200);
      const restored = (await restoredResponse.json()) as DocumentWire["metadata"];
      assert.equal(restored.deletedAt, undefined);
      document = await readDocument(baseUrl, document.metadata.id, authorization);
      assert.match(document.body, /Body edited while in Trash/u);
      assert.equal(
        (await fetch(`${baseUrl}/api/public/documents/${document.metadata.id}`)).status,
        200,
      );

      const deletedAgain = await fetch(
        `${baseUrl}/api/documents/${document.metadata.id}?expectedRevision=${document.metadata.headRevision}`,
        { headers: authorization, method: "DELETE" },
      );
      assert.equal(deletedAgain.status, 200);
      const trashedAgain = (await (
        await fetch(`${baseUrl}/api/trash`, { headers: authorization })
      ).json()) as { documents: DocumentWire[] };
      const permanentCandidate = trashedAgain.documents[0];
      assert.ok(permanentCandidate);
      const permanent = await fetch(
        `${baseUrl}/api/documents/${document.metadata.id}/permanent?expectedRevision=${permanentCandidate.metadata.headRevision}`,
        { headers: authorization, method: "DELETE" },
      );
      assert.equal(permanent.status, 200);
      assert.equal(
        (
          await fetch(
            `${baseUrl}/api/documents/${document.metadata.id}/permanent?expectedRevision=${permanentCandidate.metadata.headRevision}`,
            { headers: authorization, method: "DELETE" },
          )
        ).status,
        200,
      );
      assert.equal(
        (
          (await (await fetch(`${baseUrl}/api/trash`, { headers: authorization })).json()) as {
            documents: unknown[];
          }
        ).documents.length,
        0,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/documents/${document.metadata.id}`, {
            headers: authorization,
          })
        ).status,
        404,
      );

      const expiringResponse = await fetch(`${baseUrl}/api/documents`, {
        body: JSON.stringify({
          body: "Automatically expires",
          creationKey: "expiring-trash-document",
          title: "Expiring trash document",
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(expiringResponse.status, 200);
      const expiring = (await expiringResponse.json()) as DocumentWire;
      assert.equal(
        (
          await fetch(
            `${baseUrl}/api/documents/${expiring.metadata.id}?expectedRevision=${expiring.metadata.headRevision}`,
            { headers: authorization, method: "DELETE" },
          )
        ).status,
        200,
      );
      const purged = await running.runtime.runPromise(
        Effect.flatMap(InklingApplication, (application) =>
          application.purgeExpiredDocuments("2100-01-01T00:00:00.000Z"),
        ),
      );
      assert.deepEqual(purged, [expiring.metadata.id]);
      assert.equal(
        (
          await fetch(`${baseUrl}/api/documents/${expiring.metadata.id}`, {
            headers: authorization,
          })
        ).status,
        404,
      );
      return { authorization, documentId: document.metadata.id };
    });

    await withServer(directory, async (baseUrl) => {
      assert.equal(
        (
          await fetch(`${baseUrl}/api/documents/${first.documentId}`, {
            headers: first.authorization,
          })
        ).status,
        404,
      );
      const trash = await fetch(`${baseUrl}/api/trash`, { headers: first.authorization });
      assert.equal(trash.status, 200);
      assert.deepEqual((await trash.json()) as { documents: unknown[] }, { documents: [] });
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("personal documents stay hidden from everyone but their owner", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-personal-"));
  try {
    await withServer(directory, async (baseUrl, session, running) => {
      const administrator = await setupApiKey(baseUrl, "administrator", session);
      const ownerId = await Effect.runPromise(personId("owner@example.com"));
      const ownerLogin = await running.runtime.runPromise(
        Effect.flatMap(InklingApplication, (application) =>
          application.loginWorkspaceIdentity({
            displayName: "Personal Owner",
            email: "owner@example.com",
            personId: ownerId,
            role: "member",
          }),
        ),
      );
      const owner = await setupApiKey(baseUrl, "owner", {
        cookieHeader: `inkling_session=${ownerLogin.sessionToken}; inkling_csrf=${ownerLogin.csrfToken}`,
        csrf: ownerLogin.csrfToken,
      });
      const create = (
        headers: Readonly<Record<string, string>>,
        request: Readonly<Record<string, unknown>>,
      ): Promise<Response> =>
        fetch(`${baseUrl}/api/documents`, {
          body: JSON.stringify(request),
          headers: { ...headers, "Content-Type": "application/json" },
          method: "POST",
        });
      const catalogIds = async (
        headers: Readonly<Record<string, string>>,
        route: string,
      ): Promise<readonly string[]> => {
        const response = await fetch(`${baseUrl}${route}`, { headers });
        assert.equal(response.status, 200);
        return ((await response.json()) as { documents: readonly DocumentWire[] }).documents.map(
          (document) => document.metadata.id,
        );
      };

      const rejected = await create(owner, {
        allocateRfc: true,
        creationKey: "personal-rfc",
        personal: true,
        title: "Secret RFC",
      });
      assert.equal(rejected.status, 400);
      assert.equal(((await rejected.json()) as { code: string }).code, "personal_rfc");

      const createdResponse = await create(owner, {
        body: "Thoughts about zephyrine pricing.",
        creationKey: "personal-note",
        personal: true,
        title: "Private thoughts",
      });
      assert.equal(createdResponse.status, 200);
      const created = (await createdResponse.json()) as DocumentWire;
      const id = created.metadata.id;
      assert.equal(created.metadata.personalOwner, "owner@example.com");

      const readerView = await fetch(`${baseUrl}/api/documents/${id}?published=true`, {
        headers: owner,
      });
      assert.match(((await readerView.json()) as DocumentWire).body, /zephyrine pricing/u);
      assert.deepEqual(await catalogIds(owner, "/api/documents?q=zephyrine"), [id]);
      assert.deepEqual(await catalogIds(owner, "/api/documents?q=is%3Apersonal"), [id]);
      assert.deepEqual(await catalogIds(administrator, "/api/documents?q="), []);
      assert.deepEqual(await catalogIds(administrator, "/api/documents?q=zephyrine"), []);
      assert.deepEqual(await catalogIds(administrator, "/api/public/documents?q="), []);
      const ownerPassages = await fetch(`${baseUrl}/api/search?q=zephyrine`, { headers: owner });
      assert.equal(
        ((await ownerPassages.json()) as { passages: readonly unknown[] }).passages.length,
        1,
      );
      const hiddenPassages = await fetch(`${baseUrl}/api/search?q=zephyrine`, {
        headers: administrator,
      });
      assert.deepEqual(
        ((await hiddenPassages.json()) as { passages: readonly unknown[] }).passages,
        [],
      );
      const reference = await fetch(
        `${baseUrl}/api/references?ref=${encodeURIComponent(`doc:${id}`)}`,
        { headers: administrator },
      );
      assert.deepEqual(
        Object.values(
          ((await reference.json()) as { references: Record<string, { status: string }> })
            .references,
        ).map((resolution) => resolution.status),
        ["unavailable"],
      );
      const forbidden = await Promise.all(
        (
          [
            ["GET", ""],
            ["GET", "/history"],
            ["GET", "/attachments"],
            ["POST", "/publish"],
            ["POST", `/workspace?expectedRevision=${created.metadata.headRevision}`],
            ["DELETE", `?expectedRevision=${created.metadata.headRevision}`],
          ] as const
        ).map(async ([method, suffix]) => {
          const response = await fetch(`${baseUrl}/api/documents/${id}${suffix}`, {
            headers: administrator,
            method,
          });
          return `${method} ${suffix}: ${response.status}`;
        }),
      );
      assert.deepEqual(
        forbidden,
        forbidden.map((result) => result.replace(/\d+$/u, "403")),
      );

      assert.equal(
        (await fetch(`${baseUrl}/api/documents/${id}/publish`, { headers: owner, method: "POST" }))
          .status,
        403,
      );
      const allocation = await fetch(`${baseUrl}/api/documents/${id}/rfc`, {
        headers: owner,
        method: "POST",
      });
      assert.equal(allocation.status, 409);

      const current = await readDocument(baseUrl, id, owner);
      const moved = await fetch(
        `${baseUrl}/api/documents/${id}/workspace?expectedRevision=${current.metadata.headRevision}`,
        { headers: owner, method: "POST" },
      );
      assert.equal(moved.status, 200);
      assert.equal(((await moved.json()) as DocumentWire["metadata"]).personalOwner, undefined);
      assert.deepEqual(await catalogIds(administrator, "/api/documents?q=zephyrine"), [id]);
      assert.equal((await readDocument(baseUrl, id, administrator)).metadata.id, id);

      const trashedResponse = await create(owner, {
        creationKey: "personal-trash",
        personal: true,
        title: "Discarded thoughts",
      });
      const trashed = (await trashedResponse.json()) as DocumentWire;
      const deleted = await fetch(
        `${baseUrl}/api/documents/${trashed.metadata.id}?expectedRevision=${trashed.metadata.headRevision}`,
        { headers: owner, method: "DELETE" },
      );
      assert.equal(deleted.status, 200);
      assert.deepEqual(await catalogIds(owner, "/api/trash"), [trashed.metadata.id]);
      assert.deepEqual(await catalogIds(administrator, "/api/trash"), []);
      const inTrash = await readDocument(baseUrl, trashed.metadata.id, owner);
      const purged = await fetch(
        `${baseUrl}/api/documents/${trashed.metadata.id}/permanent?expectedRevision=${inTrash.metadata.headRevision}`,
        { headers: owner, method: "DELETE" },
      );
      assert.equal(purged.status, 200);
      assert.deepEqual(await catalogIds(owner, "/api/trash"), []);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("personal documents are shared with named people and through links", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-personal-sharing-"));
  try {
    await withServer(directory, async (baseUrl, session, running) => {
      const administrator = await setupApiKey(baseUrl, "administrator", session);
      const signIn = async (email: string, displayName: string) => {
        const id = await Effect.runPromise(personId(email));
        const login = await running.runtime.runPromise(
          Effect.flatMap(InklingApplication, (application) =>
            application.loginWorkspaceIdentity({
              displayName,
              email,
              personId: id,
              role: "member",
            }),
          ),
        );
        return setupApiKey(baseUrl, email, {
          cookieHeader: `inkling_session=${login.sessionToken}; inkling_csrf=${login.csrfToken}`,
          csrf: login.csrfToken,
        });
      };
      const owner = await signIn("owner@example.com", "Personal Owner");
      const friend = await signIn("friend@example.com", "Trusted Friend");
      const request = (
        headers: Readonly<Record<string, string>>,
        method: string,
        route: string,
        body?: unknown,
      ): Promise<Response> =>
        fetch(`${baseUrl}${route}`, {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { ...headers, "Content-Type": "application/json" },
          method,
        });
      const head = async (id: string): Promise<number> =>
        (await readDocument(baseUrl, id, owner)).metadata.headRevision;

      const created = (await (
        await request(owner, "POST", "/api/documents", {
          body: "Draft for a few trusted readers.",
          creationKey: "shared-personal",
          personal: true,
          title: "Shared draft",
        })
      ).json()) as DocumentWire;
      const id = created.metadata.id;
      const documentRoute = `/api/documents/${id}`;
      assert.equal((await request(friend, "GET", documentRoute)).status, 403);

      const people = await request(friend, "PUT", `${documentRoute}/people`, {
        emails: ["friend@example.com"],
        expectedRevision: await head(id),
      });
      assert.equal(people.status, 403);
      const sharedResponse = await request(owner, "PUT", `${documentRoute}/people`, {
        emails: ["Friend@Example.com", "owner@example.com"],
        expectedRevision: await head(id),
      });
      assert.equal(sharedResponse.status, 200);
      const shared = (await sharedResponse.json()) as DocumentWire["metadata"] & {
        sharedWith?: readonly { email: string; displayName: string }[];
      };
      assert.deepEqual(
        shared.sharedWith?.map((person) => [person.email, person.displayName]),
        [["friend@example.com", "Trusted Friend"]],
      );

      const friendCatalog = await request(friend, "GET", "/api/documents?q=is%3Ashared");
      assert.deepEqual(
        ((await friendCatalog.json()) as { documents: readonly DocumentWire[] }).documents.map(
          (document) => document.metadata.id,
        ),
        [id],
      );
      const edited = await request(friend, "POST", `${documentRoute}/edits`, {
        edits: [{ newText: "trusted", oldText: "few trusted" }],
        expectedRevision: await head(id),
      });
      assert.equal(edited.status, 200);
      const denied = await Promise.all(
        [
          request(friend, "POST", `${documentRoute}/workspace?expectedRevision=${await head(id)}`),
          request(friend, "DELETE", `${documentRoute}?expectedRevision=${await head(id)}`),
          request(friend, "GET", `${documentRoute}/shares`),
          request(administrator, "GET", documentRoute),
        ].map(async (response) => (await response).status),
      );
      assert.deepEqual(denied, [403, 403, 403, 403]);

      const linksResponse = await request(owner, "POST", `${documentRoute}/shares`, {
        access: "comment",
        expectedRevision: await head(id),
      });
      assert.equal(linksResponse.status, 200);
      const links = (await linksResponse.json()) as { links: readonly { url?: string }[] };
      const capability = new URL(links.links[0]?.url ?? "", baseUrl).searchParams.get("cap");
      assert.ok(capability);
      const withLink = `?cap=${encodeURIComponent(capability)}`;

      const guestRead = await fetch(`${baseUrl}${documentRoute}${withLink}`);
      assert.equal(guestRead.status, 200);
      const linkedRead = await request(administrator, "GET", `${documentRoute}${withLink}`);
      assert.equal(linkedRead.status, 200);
      const commentResponse = await request(
        administrator,
        "POST",
        `${documentRoute}/comments${withLink}`,
        {
          authorDisplayName: "Ignored guest name",
          body: "Looks good",
          selection: { end: 5, start: 0 },
        },
      );
      assert.equal(commentResponse.status, 200);
      const comments = (await commentResponse.json()) as {
        threads: readonly {
          messages: readonly { authorDisplayName: string; authorId: string }[];
        }[];
      };
      assert.deepEqual(
        comments.threads[0]?.messages.map((message) => [
          message.authorId,
          message.authorDisplayName,
        ]),
        [["admin@example.com", "Integration Admin"]],
      );
      const linkedEdit = await request(administrator, "POST", `${documentRoute}/edits${withLink}`, {
        edits: [{ newText: "readers!", oldText: "readers." }],
        expectedRevision: await head(id),
      });
      assert.equal(linkedEdit.status, 403);
      assert.equal(
        (await request(administrator, "GET", `/api/documents?q=${encodeURIComponent("is:shared")}`))
          .status,
        200,
      );

      const unshared = await request(owner, "PUT", `${documentRoute}/people`, {
        emails: [],
        expectedRevision: await head(id),
      });
      assert.equal(unshared.status, 200);
      assert.equal((await request(friend, "GET", documentRoute)).status, 403);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("backup corruption is rejected and a fresh installation restores portably", async () => {
  const sourceDirectory = await mkdtemp(path.join(tmpdir(), "inkling-backup-source-"));
  const targetDirectory = await mkdtemp(path.join(tmpdir(), "inkling-backup-target-"));
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
      const restoredSearch = await fetch(`${baseUrl}/api/search?q=portable`, {
        headers: source.authorization,
      });
      assert.deepEqual(
        ((await restoredSearch.json()) as { passages: { documentId: string }[] }).passages.map(
          (passage) => passage.documentId,
        ),
        [source.documentId],
      );
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
    readonly authors: readonly {
      readonly displayName: string;
      readonly email: string;
      readonly id: string;
    }[];
    readonly deletedAt?: string | undefined;
    readonly headRevision: number;
    readonly id: string;
    readonly personalOwner?: string | undefined;
    readonly publishedRevision?: number | undefined;
    readonly rfcNumber?: number | undefined;
    readonly title: string;
  };
}

interface TestSession {
  readonly cookieHeader: string;
  readonly csrf: string;
}

test("agents read and write documents over MCP", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inkling-mcp-"));
  try {
    await withServer(directory, async (baseUrl, session) => {
      const authorization = await setupApiKey(baseUrl, "mcp agent", session);
      let nextId = 1;
      const rpc = async (
        method: string,
        params: unknown,
        headers: Readonly<Record<string, string>> = authorization,
      ) => {
        const response = await fetch(`${baseUrl}/mcp`, {
          body: JSON.stringify({ id: nextId++, jsonrpc: "2.0", method, params }),
          headers: {
            ...headers,
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        return { body: (await response.json()) as any, status: response.status };
      };
      const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
        const { body, status } = await rpc("tools/call", { arguments: args, name });
        assert.equal(status, 200, name);
        assert.notEqual(body.result.isError, true, `${name}: ${body.result.content?.[0]?.text}`);
        return body.result as {
          readonly content: readonly { readonly text: string }[];
          readonly structuredContent: any;
        };
      };

      const rejected = await rpc("initialize", {}, { Authorization: "Bearer key_bogus.secret" });
      assert.equal(rejected.status, 401);
      const initialized = await rpc("initialize", {
        capabilities: {},
        clientInfo: { name: "integration", version: "1" },
        protocolVersion: "2025-11-25",
      });
      assert.equal(initialized.status, 200);
      assert.equal(initialized.body.result.protocolVersion, "2025-11-25");
      const listed = await rpc("tools/list", {});
      assert.ok(listed.body.result.tools.some((tool: any) => tool.name === "edit_document"));

      const created = await call("create_document", {
        body: "# Cache design\n\nThe cache is shared between workers.\n",
        rfc: true,
        title: "Cache design",
      });
      const rfcNumber = created.structuredContent.metadata.rfcNumber as number;
      const documentId = created.structuredContent.metadata.id as string;
      assert.ok(rfcNumber > 0);
      const rfcPath = `/rfc/${String(rfcNumber).padStart(4, "0")}`;
      assert.equal(created.structuredContent.url, `${baseUrl}${rfcPath}`);

      const read = await call("read_document", { document: `${baseUrl}${rfcPath}/edit` });
      assert.equal(read.structuredContent.metadata.id, documentId);
      assert.match(read.content[0]?.text ?? "", /The cache is shared between workers\./u);
      assert.match(read.content[0]?.text ?? "", /^---$/mu);

      const edited = await call("edit_document", {
        document: String(rfcNumber),
        edits: [{ new_text: "is partitioned per tenant", old_text: "is shared between workers" }],
      });
      assert.match(edited.content[0]?.text ?? "", /Applied 1 edit/u);

      const passages = await call("search_passages", { query: "partitioned tenant" });
      assert.equal(passages.structuredContent.passages[0]?.documentId, documentId);
      assert.equal(passages.structuredContent.passages[0]?.url, `${baseUrl}${rfcPath}`);
      assert.match(passages.content[0]?.text ?? "", /Cache design/u);
      const passageLines = await call("read_document", {
        document: documentId,
        end_line: passages.structuredContent.passages[0]?.endLine,
        start_line: passages.structuredContent.passages[0]?.startLine,
      });
      assert.match(passageLines.structuredContent.body, /partitioned per tenant/u);

      const personal = await call("create_document", {
        body: "# Agent scratchpad\n\nOnly for me.\n",
        personal: true,
        title: "Agent scratchpad",
      });
      const personalId = personal.structuredContent.metadata.id as string;
      assert.equal(personal.structuredContent.metadata.personalOwner, "admin@example.com");
      const sharedPersonal = await call("share_personal_document", {
        document: personalId,
        people: ["Reviewer@Example.com"],
      });
      assert.deepEqual(
        sharedPersonal.structuredContent.metadata.sharedWith.map(
          (person: { email: string }) => person.email,
        ),
        ["reviewer@example.com"],
      );
      assert.match(sharedPersonal.content[0]?.text ?? "", /reviewer@example\.com/u);
      const personalRead = await call("read_document", { document: personalId });
      assert.match(personalRead.content[0]?.text ?? "", /shared with reviewer@example\.com/u);
      const unsharedPersonal = await call("share_personal_document", {
        document: personalId,
        people: [],
      });
      assert.equal(unsharedPersonal.structuredContent.metadata.sharedWith, undefined);

      const commented = await call("add_comment", {
        body: "Which partition key?",
        document: documentId,
        quote: "partitioned per tenant",
      });
      const threadId = commented.structuredContent.thread.id as string;
      assert.equal(
        commented.structuredContent.thread.messages[0].authorDisplayName,
        "Integration Admin",
      );
      await call("reply_to_comment", {
        body: "The tenant ID.",
        document: documentId,
        thread_id: threadId,
      });
      const resolved = await call("resolve_comment_thread", {
        document: documentId,
        thread_id: threadId,
      });
      assert.equal(resolved.structuredContent.thread.resolved, true);
      assert.equal(resolved.structuredContent.thread.messages.length, 2);

      const current = await readDocument(baseUrl, documentId, authorization);
      assert.ok(current.body.includes("The cache is partitioned per tenant."));
      assert.equal((current.comments.threads[0] as any)?.anchor.quote, "partitioned per tenant");

      const found = await call("search_documents", { query: "partitioned" });
      assert.deepEqual(
        found.structuredContent.documents.map((document: any) => document.id),
        [documentId],
      );

      await call("publish_document", { document: documentId });
      const published = await call("read_document", { document: documentId, published: true });
      assert.match(published.content[0]?.text ?? "", /\(published revision\)/u);

      const stale = await rpc("tools/call", {
        arguments: { body: "# Replaced\n", document: documentId, expected_revision: 0 },
        name: "replace_document_body",
      });
      assert.equal(stale.body.result.isError, true);
      assert.match(stale.body.result.content[0].text, /revision_conflict/u);

      await call("delete_document", { document: documentId });
      const trash = await call("list_trash", {});
      assert.equal(trash.structuredContent.documents[0]?.id, documentId);
      await call("restore_document", { document: documentId });
      assert.equal(
        (await readDocument(baseUrl, documentId, authorization)).metadata.deletedAt,
        undefined,
      );
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test(
  "MCP clients sign in with OAuth and receive revocable API keys",
  { timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "inkling-oauth-"));
    try {
      await withServer(directory, async (baseUrl, session) => {
        const redirectUri = "http://127.0.0.1:45678/callback";
        const registration = await fetch(`${baseUrl}/oauth/register`, {
          body: JSON.stringify({ client_name: "Integration agent", redirect_uris: [redirectUri] }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registration.status, 201);
        const clientId = ((await registration.json()) as { client_id: string }).client_id;

        const verifier = "integration-verifier-0123456789-abcdefghijklmnop";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const authorize = async (): Promise<string> => {
          const parameters = new URLSearchParams({
            client_id: clientId,
            code_challenge: challenge,
            code_challenge_method: "S256",
            redirect_uri: redirectUri,
            resource: `${baseUrl}/mcp`,
            response_type: "code",
            state: "integration-state",
          });
          const consent = await fetch(`${baseUrl}/oauth/authorize?${parameters}`, {
            headers: { Cookie: session.cookieHeader },
          });
          assert.equal(consent.status, 200);
          assert.match(await consent.text(), /Connect Integration agent to Inkling\?/u);
          parameters.set("csrf", session.csrf);
          parameters.set("decision", "allow");
          const approved = await fetch(`${baseUrl}/oauth/authorize`, {
            body: parameters,
            headers: { Cookie: session.cookieHeader, Origin: baseUrl },
            method: "POST",
            redirect: "manual",
          });
          assert.equal(approved.status, 303);
          const location = new URL(approved.headers.get("location") ?? "");
          assert.equal(`${location.origin}${location.pathname}`, redirectUri);
          assert.equal(location.searchParams.get("state"), "integration-state");
          assert.equal(location.searchParams.get("iss"), baseUrl);
          const code = location.searchParams.get("code");
          assert.ok(code);
          return code;
        };
        const redeem = (code: string, codeVerifier: string) =>
          fetch(`${baseUrl}/oauth/token`, {
            body: new URLSearchParams({
              client_id: clientId,
              code,
              code_verifier: codeVerifier,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
              resource: `${baseUrl}/mcp`,
            }),
            method: "POST",
          });

        // A failed attempt spends the code, so a stolen code cannot be retried.
        const guessed = await authorize();
        const wrong = await redeem(guessed, "wrong-verifier-0123456789-abcdefghijklmnopqrstu");
        assert.equal(wrong.status, 400);
        assert.equal(((await wrong.json()) as { error: string }).error, "invalid_grant");
        assert.equal((await redeem(guessed, verifier)).status, 400);

        const code = await authorize();
        const issued = await redeem(code, verifier);
        assert.equal(issued.status, 200);
        assert.equal(issued.headers.get("cache-control"), "no-store");
        const token = (await issued.json()) as { access_token: string; token_type: string };
        assert.equal(token.token_type, "Bearer");
        assert.equal((await redeem(code, verifier)).status, 400);

        const initialized = await fetch(`${baseUrl}/mcp`, {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} }),
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(initialized.status, 200);
        const created = await fetch(`${baseUrl}/mcp`, {
          body: JSON.stringify({
            id: 2,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: { title: "Signed in note" }, name: "create_document" },
          }),
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const result = ((await created.json()) as { result: any }).result;
        assert.equal(result.structuredContent.metadata.authors[0].displayName, "Integration Admin");

        const keys = (await (
          await fetch(`${baseUrl}/api/api-keys`, { headers: { Cookie: session.cookieHeader } })
        ).json()) as { label: string; oauthClientName?: string; revealable: boolean }[];
        assert.deepEqual(
          keys.map(({ label, oauthClientName, revealable }) => ({
            label,
            oauthClientName,
            revealable,
          })),
          [{ label: "Integration agent", oauthClientName: "Integration agent", revealable: false }],
        );
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

async function withServer<A>(
  directory: string,
  callback: (baseUrl: string, session: TestSession, running: RunningServer) => Promise<A>,
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
            Effect.flatMap(InklingApplication, (application) =>
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
            callback(
              `http://127.0.0.1:${address.port}`,
              {
                cookieHeader: `inkling_session=${session.sessionToken}; inkling_csrf=${session.csrfToken}`,
                csrf: session.csrfToken,
              },
              running,
            ),
        });
      }),
    ),
  );
}

async function runCommand(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly stderr: string; readonly stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stderr, stdout }));
  });
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
