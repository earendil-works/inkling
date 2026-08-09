import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface RunningWrangler {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

interface RunningGoogleOAuthMock {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

test(
  "Cloudflare development runtime persists isolated document authorities in R2 and DO storage",
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "inkling-cloudflare-test-"));
    let google: RunningGoogleOAuthMock | undefined;
    let running: RunningWrangler | undefined;
    try {
      google = await startGoogleOAuthMock();
      running = await startWrangler(directory, google.origin);
      const agentInstructions = await fetch(`${running.baseUrl}/AGENTS.md`);
      assert.equal(agentInstructions.status, 200);
      assert.match(agentInstructions.headers.get("content-type") ?? "", /^text\/markdown/u);
      assert.ok((await agentInstructions.text()).includes(`base URL is ${running.baseUrl}`));

      const cookie = await loginWithGoogle(running.baseUrl);
      const csrf = cookieValue(cookie, "inkling_csrf");
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
      const createdKey = (await keyResponse.json()) as {
        key: string;
        metadata: { personId: string };
      };
      assert.equal(createdKey.metadata.personId, "armin@earendil.com");
      const authorization = { Authorization: `Bearer ${createdKey.key}` };

      // Simulate a workspace created before authenticated accounts were copied into the people
      // directory. The active OAuth session still carries Armin's canonical display name, while
      // the separately synchronized directory entry for Colin remains available.
      const legacyBackup = await fetch(`${running.baseUrl}/api/admin/backup`, {
        headers: authorization,
      });
      assert.equal(legacyBackup.status, 200);
      const legacyArchive = (await legacyBackup.json()) as {
        workspaceState: { catalog: { people: { person: { email: string } }[] } };
      };
      assert.ok(
        legacyArchive.workspaceState.catalog.people.some(
          (entry) => entry.person.email === "colin@earendil.com",
        ),
      );
      legacyArchive.workspaceState.catalog.people =
        legacyArchive.workspaceState.catalog.people.filter(
          (entry) => entry.person.email !== "armin@earendil.com",
        );
      const legacyRestore = await fetch(`${running.baseUrl}/api/admin/restore`, {
        body: JSON.stringify(legacyArchive),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(legacyRestore.status, 200);

      const first = await createDocument(running.baseUrl, authorization, "first", true);
      const second = await createDocument(running.baseUrl, authorization, "second", false);
      assert.equal(first.metadata.rfcNumber, 1);
      assert.deepEqual(first.metadata.authors, [
        {
          displayName: "Armin Ronacher",
          email: "armin@earendil.com",
          id: "armin@earendil.com",
        },
      ]);
      assert.equal(second.metadata.rfcNumber, undefined);
      const allocation = await fetch(`${running.baseUrl}/api/documents/${second.metadata.id}/rfc`, {
        headers: authorization,
        method: "POST",
      });
      assert.equal(allocation.status, 200);
      assert.equal(((await allocation.json()) as DocumentWire["metadata"]).rfcNumber, 2);
      assert.equal(
        (await readDocument(running.baseUrl, second.metadata.id, authorization)).metadata.rfcNumber,
        2,
      );
      const edited = await fetch(`${running.baseUrl}/api/documents/${first.metadata.id}/edits`, {
        body: JSON.stringify({
          edits: [
            { newText: "durable", oldText: "initial" },
            {
              newText: "authors:\n  - armin@earendil.com\n  - alphatest0@earendil.com",
              oldText: "authors:\n  - armin@earendil.com",
            },
            { newText: "visibility: public", oldText: "visibility: private" },
            { newText: "labels:\n  - working", oldText: "labels: []" },
          ],
          expectedRevision: first.metadata.headRevision,
        }),
        headers: { ...authorization, "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(edited.status, 200);
      let changed = (await edited.json()) as DocumentWire;
      assert.match(changed.body, /---\n\n# Cloudflare first\n\ndurable first$/u);
      assert.match(
        (await readDocument(running.baseUrl, second.metadata.id, authorization)).body,
        /---\n\n# Cloudflare second\n\ninitial second$/u,
      );
      changed = await updateTitle(
        running.baseUrl,
        first.metadata.id,
        changed.metadata.headRevision,
        "Cloudflare first",
        "Intermediate title",
        authorization,
      );
      changed = await updateTitle(
        running.baseUrl,
        first.metadata.id,
        changed.metadata.headRevision,
        "Intermediate title",
        "Newest projected title",
        authorization,
      );
      await waitForCatalog(
        running.baseUrl,
        authorization,
        first.metadata.id,
        "Newest projected title",
      );
      const search = await fetch(
        `${running.baseUrl}/api/documents?q=${encodeURIComponent("rfc:1 label:working durable")}`,
        { headers: authorization },
      );
      assert.equal(search.status, 200);
      const searchResult = (await search.json()) as { documents: readonly DocumentWire[] };
      assert.equal(searchResult.documents[0]?.metadata.id, first.metadata.id);
      assert.deepEqual(searchResult.documents[0]?.metadata.labels, ["working"]);
      const publication = await fetch(
        `${running.baseUrl}/api/documents/${first.metadata.id}/publish`,
        { headers: authorization, method: "POST" },
      );
      assert.equal(publication.status, 200);
      const publicationMetadata = (await publication.json()) as DocumentWire["metadata"];
      assert.deepEqual(publicationMetadata.authors, [
        {
          displayName: "Armin Ronacher",
          email: "armin@earendil.com",
          id: "armin@earendil.com",
        },
        {
          displayName: "Colin Hanna",
          email: "alphatest0@earendil.com",
          id: "alphatest0@earendil.com",
        },
      ]);
      const publicRfc = await fetch(`${running.baseUrl}/rfcs/0001`);
      assert.equal(publicRfc.status, 200);
      const publicHtml = await publicRfc.text();
      assert.match(publicHtml, />Armin Ronacher<\/a>/u);
      assert.match(publicHtml, />Colin Hanna<\/a>/u);
      assert.match(publicHtml, /mailto:alphatest0@earendil\.com/u);

      const lateNumbered = await readDocument(running.baseUrl, second.metadata.id, authorization);
      const publicSecond = await fetch(
        `${running.baseUrl}/api/documents/${second.metadata.id}/edits`,
        {
          body: JSON.stringify({
            edits: [{ newText: "visibility: public", oldText: "visibility: private" }],
            expectedRevision: lateNumbered.metadata.headRevision,
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        },
      );
      assert.equal(publicSecond.status, 200);
      const publicSecondDocument = (await publicSecond.json()) as DocumentWire;
      const secondPublication = await fetch(
        `${running.baseUrl}/api/documents/${second.metadata.id}/publish`,
        { headers: authorization, method: "POST" },
      );
      assert.equal(secondPublication.status, 200);
      const lateAllocatedRfc = await fetch(`${running.baseUrl}/api/public/rfc/2`);
      assert.equal(lateAllocatedRfc.status, 200);
      assert.equal(
        ((await lateAllocatedRfc.json()) as { canonicalPath: string }).canonicalPath,
        "/rfcs/0002",
      );
      const anonymousSecond = await fetch(
        `${running.baseUrl}/api/documents/${publicSecondDocument.metadata.id}?published=true`,
      );
      assert.equal(anonymousSecond.status, 200);

      const shareSource = await readDocument(running.baseUrl, first.metadata.id, authorization);
      const protectedShare = await fetch(
        `${running.baseUrl}/api/documents/${first.metadata.id}/shares`,
        {
          body: JSON.stringify({
            access: "view",
            expectedRevision: shareSource.metadata.headRevision,
            password: "cloudflare share password",
          }),
          headers: { ...authorization, "Content-Type": "application/json" },
          method: "POST",
        },
      );
      assert.equal(protectedShare.status, 200);
      const protectedCapability = new URL(
        (
          (await protectedShare.json()) as {
            links: { passwordProtected: boolean; url: string }[];
          }
        ).links.find((link) => link.passwordProtected)?.url ?? "",
      ).searchParams.get("cap");
      assert.ok(protectedCapability);
      assert.equal(
        (
          await fetch(
            `${running.baseUrl}/api/documents/${first.metadata.id}?cap=${encodeURIComponent(protectedCapability)}`,
          )
        ).status,
        401,
      );

      const backup = await fetch(`${running.baseUrl}/api/admin/backup`, {
        headers: authorization,
      });
      assert.equal(backup.status, 200);
      assert.ok((await backup.arrayBuffer()).byteLength > 500);
      await running.stop();
      running = undefined;

      running = await startWrangler(directory, google.origin);
      try {
        assert.match(
          (await readDocument(running.baseUrl, first.metadata.id, authorization)).body,
          /---\n\n# Newest projected title\n\ndurable first$/u,
        );
        const unlocked = await fetch(
          `${running.baseUrl}/api/documents/${first.metadata.id}/shares/unlock?cap=${encodeURIComponent(protectedCapability)}`,
          {
            body: JSON.stringify({ password: "cloudflare share password" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        assert.equal(unlocked.status, 200);
        const shareCookie = unlocked.headers.get("set-cookie");
        assert.ok(shareCookie);
        assert.equal(
          (
            await fetch(
              `${running.baseUrl}/api/documents/${first.metadata.id}?cap=${encodeURIComponent(protectedCapability)}`,
              { headers: { Cookie: shareCookie } },
            )
          ).status,
          200,
        );
        const persistedSecond = await readDocument(
          running.baseUrl,
          second.metadata.id,
          authorization,
        );
        assert.match(persistedSecond.body, /---\n\n# Cloudflare second\n\ninitial second$/u);
        assert.equal(persistedSecond.metadata.rfcNumber, 2);

        const deleted = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}?expectedRevision=${persistedSecond.metadata.headRevision}`,
          { headers: authorization, method: "DELETE" },
        );
        assert.equal(deleted.status, 200);
        const trashResponse = await fetch(`${running.baseUrl}/api/trash`, {
          headers: authorization,
        });
        assert.equal(trashResponse.status, 200);
        let trash = (await trashResponse.json()) as { documents: DocumentWire[] };
        assert.equal(trash.documents[0]?.metadata.id, second.metadata.id);
        assert.ok(trash.documents[0]?.metadata.deletedAt);
        const trashed = trash.documents[0];
        assert.ok(trashed);
        const deletedReader = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}?published=true`,
          { headers: authorization },
        );
        assert.equal(deletedReader.status, 200);
        assert.equal(((await deletedReader.json()) as DocumentWire).body, "");
        const trashEdit = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}/edits`,
          {
            body: JSON.stringify({
              edits: [{ newText: "edited in Trash", oldText: "initial second" }],
              expectedRevision: trashed.metadata.headRevision,
            }),
            headers: { ...authorization, "Content-Type": "application/json" },
            method: "POST",
          },
        );
        assert.equal(trashEdit.status, 200);
        const editedInTrash = (await trashEdit.json()) as DocumentWire;
        assert.ok(editedInTrash.metadata.deletedAt);

        const restored = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}/restore?expectedRevision=${editedInTrash.metadata.headRevision}`,
          { headers: authorization, method: "POST" },
        );
        assert.equal(restored.status, 200);
        const restoredMetadata = (await restored.json()) as DocumentWire["metadata"];
        assert.equal(restoredMetadata.deletedAt, undefined);
        const restoredDocument = await readDocument(
          running.baseUrl,
          second.metadata.id,
          authorization,
        );
        assert.match(restoredDocument.body, /edited in Trash$/u);

        const deletedAgain = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}?expectedRevision=${restoredDocument.metadata.headRevision}`,
          { headers: authorization, method: "DELETE" },
        );
        assert.equal(deletedAgain.status, 200);
        trash = (await (
          await fetch(`${running.baseUrl}/api/trash`, { headers: authorization })
        ).json()) as { documents: DocumentWire[] };
        const permanentCandidate = trash.documents.find(
          (document) => document.metadata.id === second.metadata.id,
        );
        assert.ok(permanentCandidate);
        const permanent = await fetch(
          `${running.baseUrl}/api/documents/${second.metadata.id}/permanent?expectedRevision=${permanentCandidate.metadata.headRevision}`,
          { headers: authorization, method: "DELETE" },
        );
        assert.equal(permanent.status, 200);
        assert.equal(
          (
            await fetch(
              `${running.baseUrl}/api/documents/${second.metadata.id}/permanent?expectedRevision=${permanentCandidate.metadata.headRevision}`,
              { headers: authorization, method: "DELETE" },
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await fetch(`${running.baseUrl}/api/documents/${second.metadata.id}`, {
              headers: authorization,
            })
          ).status,
          404,
        );
        assert.equal(
          (
            (await (
              await fetch(`${running.baseUrl}/api/trash`, { headers: authorization })
            ).json()) as {
              documents: DocumentWire[];
            }
          ).documents.some((document) => document.metadata.id === second.metadata.id),
          false,
        );
      } finally {
        await running.stop();
        running = undefined;
      }
    } finally {
      await running?.stop();
      await google?.stop();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

interface DocumentWire {
  readonly body: string;
  readonly metadata: {
    readonly authors: readonly {
      readonly displayName: string;
      readonly email: string;
      readonly id: string;
    }[];
    readonly deletedAt?: string | undefined;
    readonly headRevision: number;
    readonly id: string;
    readonly labels: readonly string[];
    readonly rfcNumber?: number | undefined;
  };
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
  oldTitle: string,
  title: string,
  headers: Readonly<Record<string, string>>,
): Promise<DocumentWire> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/edits`, {
    body: JSON.stringify({
      edits: [{ newText: `# ${title}`, oldText: `# ${oldTitle}` }],
      expectedRevision,
    }),
    headers: { ...headers, "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return (await response.json()) as DocumentWire;
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

async function loginWithGoogle(baseUrl: string): Promise<string> {
  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await status.json(), { authenticated: false });

  const start = await fetch(`${baseUrl}/api/auth/google/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const oauthCookie = start.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const authorizationLocation = start.headers.get("Location");
  assert.ok(authorizationLocation);

  const authorization = await fetch(authorizationLocation, { redirect: "manual" });
  assert.equal(authorization.status, 302);
  const callbackLocation = authorization.headers.get("Location");
  assert.ok(callbackLocation);

  const callback = await fetch(callbackLocation, {
    headers: { Cookie: oauthCookie },
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  const cookie = callback.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookieValue(cookie, "inkling_session"));
  assert.ok(cookieValue(cookie, "inkling_csrf"));

  const authenticated = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
  const authenticatedBody = (await authenticated.json()) as {
    readonly authenticated: boolean;
    readonly principal?: { readonly displayName: string; readonly email?: string | undefined };
  };
  assert.equal(authenticatedBody.authenticated, true);
  assert.equal(authenticatedBody.principal?.displayName, "Armin Ronacher");
  assert.equal(authenticatedBody.principal?.email, "armin@earendil.com");
  return cookie;
}

async function startGoogleOAuthMock(): Promise<RunningGoogleOAuthMock> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verificationKey = {
    ...publicKey.export({ format: "jwk" }),
    alg: "RS256",
    kid: "inkling-test-key",
    use: "sig",
  };
  let nonce: string | undefined;
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/authorize") {
      nonce = url.searchParams.get("nonce") ?? undefined;
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      assert.match(url.searchParams.get("scope") ?? "", /admin\.directory\.user\.readonly/u);
      assert.ok(nonce);
      assert.ok(redirectUri);
      assert.ok(state);
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", "test-authorization-code");
      callback.searchParams.set("state", state);
      response.writeHead(302, { Location: callback.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      assert.ok(nonce);
      const header = base64UrlJson({ alg: "RS256", kid: "inkling-test-key", typ: "JWT" });
      const claims = base64UrlJson({
        aud: "inkling-test-client",
        email: "armin@earendil.com",
        email_verified: true,
        exp: Math.floor(Date.now() / 1_000) + 300,
        hd: "earendil.com",
        iss: "https://accounts.google.com",
        name: "Armin Ronacher",
        nonce,
        sub: "google-test-user",
      });
      const unsigned = `${header}.${claims}`;
      const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          access_token: "google-directory-access-token",
          id_token: `${unsigned}.${signature}`,
        }),
      );
      return;
    }
    if (url.pathname === "/directory/users") {
      assert.equal(request.headers.authorization, "Bearer google-directory-access-token");
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          users: [
            {
              aliases: [],
              name: { fullName: "Armin Ronacher" },
              primaryEmail: "armin@earendil.com",
            },
            {
              aliases: ["alphatest0@earendil.com"],
              name: { fullName: "Colin Hanna" },
              primaryEmail: "colin@earendil.com",
            },
          ],
        }),
      );
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
    throw new Error("Could not start the Google OAuth test server.");
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

async function startWrangler(directory: string, googleOrigin: string): Promise<RunningWrangler> {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environmentFile = path.join(directory, "oauth.env");
  await writeFile(
    environmentFile,
    [
      "GOOGLE_ADMIN_EMAILS=armin@earendil.com",
      "GOOGLE_ALLOWED_DOMAINS=earendil.com",
      "GOOGLE_CLIENT_ID=inkling-test-client",
      "GOOGLE_CLIENT_SECRET=inkling-test-secret",
      `GOOGLE_REDIRECT_URI=${baseUrl}/api/auth/google/callback`,
      `INKLING_GOOGLE_AUTHORIZATION_ENDPOINT=${googleOrigin}/authorize`,
      `INKLING_GOOGLE_CERTIFICATES_ENDPOINT=${googleOrigin}/certificates`,
      `INKLING_GOOGLE_DIRECTORY_ENDPOINT=${googleOrigin}/directory/users`,
      `INKLING_GOOGLE_TOKEN_ENDPOINT=${googleOrigin}/token`,
      "INKLING_OAUTH_STATE_SECRET=inkling-test-state-secret",
      "",
    ].join("\n"),
  );
  const child = spawn(
    path.resolve(import.meta.dirname, "../node_modules/.bin/wrangler"),
    ["dev", "--port", String(port), "--persist-to", directory, "--env-file", environmentFile],
    { cwd: path.resolve(import.meta.dirname, ".."), stdio: "ignore" },
  );
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
