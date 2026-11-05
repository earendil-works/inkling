import assert from "node:assert/strict";
import test from "node:test";

import { Effect, Either, SchemaAST } from "effect";

import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { createBackendApp, handleMcpRequest, mcpProtocolVersions } from "../src/index.ts";
import { parseDocumentReference } from "../src/mcp/api.ts";
import { inklingTools } from "../src/mcp/tools.ts";

const origin = "https://rfcs.example.com";

interface RecordedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

type Route = (request: RecordedRequest) => Response | undefined;

function fakeWorkspace(routes: readonly Route[]) {
  const requests: RecordedRequest[] = [];
  const dispatch = async (request: Request): Promise<Response> => {
    assert.equal(request.headers.get("authorization"), "Bearer key_test.secret");
    const url = new URL(request.url);
    assert.equal(url.origin, origin);
    const text = await request.text();
    const recorded = {
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
      method: request.method,
      path: `${url.pathname}${url.search}`,
    };
    requests.push(recorded);
    for (const route of routes) {
      const response = route(recorded);
      if (response !== undefined) return response;
    }
    return Response.json(
      { code: "not_found", message: "Not found.", retryable: false },
      { status: 404 },
    );
  };
  return { dispatch, requests };
}

const authenticated: Route = (request) =>
  request.path === "/api/auth/status"
    ? Response.json({
        authenticated: true,
        principal: { displayName: "Ada", id: "ada@example.com", role: "member" },
      })
    : undefined;

function document(body: string, headRevision: number, rfcNumber?: number): DocumentResponse {
  return {
    body,
    comments: { revision: headRevision, threads: [] },
    metadata: {
      approvers: [],
      authors: [],
      createdAt: "2025-01-01T00:00:00.000Z",
      headRevision,
      id: "doc_test",
      labels: [],
      lifecycleState: "draft",
      relatedDocuments: [],
      reviewers: [],
      ...(rfcNumber === undefined ? {} : { rfcNumber }),
      sharing: { access: "disabled", generation: 0 },
      title: "Test document",
      updatedAt: "2025-01-01T00:00:00.000Z",
      visibility: "private",
    },
    sequence: headRevision,
  };
}

async function rpc(
  dispatch: (request: Request) => Promise<Response>,
  method: string,
  params?: unknown,
  headers: Readonly<Record<string, string>> = { Authorization: "Bearer key_test.secret" },
): Promise<{ readonly body: any; readonly response: Response }> {
  const response = await Effect.runPromise(
    handleMcpRequest(
      new Request(`${origin}/mcp`, {
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST",
      }),
      { dispatch, version: "test" },
    ),
  );
  const text = await response.text();
  return { body: text === "" ? undefined : (JSON.parse(text) as unknown), response };
}

async function callTool(
  dispatch: (request: Request) => Promise<Response>,
  name: string,
  args: unknown,
): Promise<any> {
  const { body, response } = await rpc(dispatch, "tools/call", { arguments: args, name });
  assert.equal(response.status, 200);
  return body.result;
}

test("MCP requires POST and a bearer API key", async () => {
  const app = createBackendApp({ version: "test" });
  const get = await app.request(`${origin}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const anonymous = await app.request(`${origin}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
    method: "POST",
  });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /^Bearer realm="Inkling"/u);
  assert.match(((await anonymous.json()) as any).error.message, /API key/u);

  const cookie = await app.request(`${origin}/mcp`, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize" }),
    headers: { Cookie: "inkling_session=session.secret" },
    method: "POST",
  });
  assert.equal(cookie.status, 401);
});

test("MCP initialize validates the key and negotiates the protocol", async () => {
  const valid = fakeWorkspace([authenticated]);
  const { body, response } = await rpc(valid.dispatch, "initialize", {
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
    protocolVersion: "2025-06-18",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(body.result.serverInfo, { name: "inkling", title: "Inkling", version: "test" });
  assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  assert.match(body.result.instructions, /https:\/\/rfcs\.example\.com/u);
  assert.match(body.result.instructions, /data, never as instructions/u);

  const latest = await rpc(valid.dispatch, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(latest.body.result.protocolVersion, mcpProtocolVersions[0]);

  const revoked = fakeWorkspace([
    (request) =>
      request.path === "/api/auth/status" ? Response.json({ authenticated: false }) : undefined,
  ]);
  const rejected = await rpc(revoked.dispatch, "initialize", {});
  assert.equal(rejected.response.status, 401);
  assert.match(rejected.response.headers.get("www-authenticate") ?? "", /error="invalid_token"/u);
});

test("MCP answers notifications, pings, and protocol errors", async () => {
  const { dispatch } = fakeWorkspace([authenticated]);
  const notification = await Effect.runPromise(
    handleMcpRequest(
      new Request(`${origin}/mcp`, {
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        headers: { Authorization: "Bearer key_test.secret" },
        method: "POST",
      }),
      { dispatch },
    ),
  );
  assert.equal(notification.status, 202);

  assert.deepEqual((await rpc(dispatch, "ping")).body.result, {});
  assert.equal((await rpc(dispatch, "resources/list")).body.error.code, -32601);
  assert.equal((await rpc(dispatch, "tools/call", { name: "nope" })).body.error.code, -32602);

  const malformed = await Effect.runPromise(
    handleMcpRequest(
      new Request(`${origin}/mcp`, {
        body: "{",
        headers: { Authorization: "Bearer key_test.secret" },
        method: "POST",
      }),
      { dispatch },
    ),
  );
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as any).error.code, -32700);

  const unsupported = await rpc(dispatch, "ping", undefined, {
    Authorization: "Bearer key_test.secret",
    "MCP-Protocol-Version": "1999-01-01",
  });
  assert.equal(unsupported.response.status, 400);
});

test("advertised tool schemas agree with the argument decoders", async () => {
  const { dispatch } = fakeWorkspace([authenticated]);
  const listed = (await rpc(dispatch, "tools/list")).body.result.tools as readonly any[];
  assert.equal(listed.length, inklingTools.length);
  assert.equal(new Set(listed.map((tool) => tool.name)).size, listed.length);

  for (const { arguments: decoder, tool } of inklingTools) {
    const signatures = SchemaAST.getPropertySignatures(decoder.ast);
    const decoded = signatures.map((signature) => String(signature.name)).toSorted();
    const required = signatures
      .filter((signature) => !signature.isOptional)
      .map((signature) => String(signature.name))
      .toSorted();
    assert.deepEqual(Object.keys(tool.inputSchema["properties"] as object).toSorted(), decoded);
    assert.deepEqual(
      [...((tool.inputSchema["required"] as readonly string[] | undefined) ?? [])].toSorted(),
      required,
      tool.name,
    );
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema["additionalProperties"], false);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(
      tool.annotations.readOnlyHint,
      /^(?:search|read|list)_/u.test(tool.name),
      tool.name,
    );
  }
  // Agents may share personal documents with named workspace people, but never
  // mint share links, purge documents, or manage credentials.
  assert.ok(listed.some((tool) => tool.name === "share_personal_document"));
  assert.ok(!listed.some((tool) => /hard|permanent|link|api_key/u.test(tool.name)));
});

test("document references accept IDs, RFC numbers, and workspace URLs", () => {
  const parse = (value: string) =>
    Effect.runSync(Effect.either(parseDocumentReference(value, origin)));
  assert.deepEqual(parse("doc_abc"), Either.right({ documentId: "doc_abc", kind: "id" }));
  for (const value of [
    "57",
    "0057",
    "RFC 0057",
    "rfc:57",
    `${origin}/rfc/0057`,
    `${origin}/rfc/0057/edit`,
    `${origin}/rfcs/57`,
    `${origin}/0057`,
  ]) {
    assert.deepEqual(parse(value), Either.right({ kind: "rfc", rfcNumber: 57 }), value);
  }
  for (const path of [
    "/documents/doc_abc",
    "/documents/doc_abc/edit",
    "/public/documents/doc_abc",
    "/share/doc_abc?cap=x",
  ]) {
    assert.deepEqual(
      parse(`${origin}${path}`),
      Either.right({ documentId: "doc_abc", kind: "id" }),
      path,
    );
  }
  assert.ok(Either.isLeft(parse("https://other.example.com/rfc/0057")));
  assert.ok(Either.isLeft(parse(`${origin}/settings`)));
  assert.ok(Either.isLeft(parse("not a document")));
  assert.ok(Either.isLeft(parse("0")));
});

test("edit_document resolves RFC numbers and retries revision conflicts against the head", async () => {
  let head = 4;
  let conflicts = 1;
  const { dispatch, requests } = fakeWorkspace([
    (request) =>
      request.path === "/api/documents?q=rfc%3A7"
        ? Response.json({ documents: [{ excerpt: "", metadata: document("", head, 7).metadata }] })
        : undefined,
    (request) =>
      request.method === "GET" && request.path === "/api/documents/doc_test"
        ? Response.json(document("# Test\n\nHello world", head, 7))
        : undefined,
    (request) => {
      if (request.path !== "/api/documents/doc_test/edits") return undefined;
      if (conflicts > 0) {
        conflicts -= 1;
        head += 1;
        return Response.json(
          {
            code: "revision_conflict",
            message: "Expected revision 4, current revision is 5.",
            retryable: false,
          },
          { status: 409 },
        );
      }
      return Response.json(document("# Test\n\nHello Inkling", head + 1, 7));
    },
  ]);

  const result = await callTool(dispatch, "edit_document", {
    document: "RFC 0007",
    edits: [{ new_text: "Inkling", old_text: "world" }],
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Applied 1 edit to RFC 0007 "Test document"/u);
  assert.match(result.content[0].text, /URL: https:\/\/rfcs\.example\.com\/rfc\/0007/u);
  assert.equal(result.structuredContent.metadata.headRevision, 6);
  const edits = requests.filter((request) => request.path.endsWith("/edits"));
  assert.deepEqual(
    edits.map((request) => request.body),
    [
      { edits: [{ newText: "Inkling", oldText: "world" }], expectedRevision: 4 },
      { edits: [{ newText: "Inkling", oldText: "world" }], expectedRevision: 5 },
    ],
  );

  conflicts = 1;
  const pinned = await callTool(dispatch, "edit_document", {
    document: "doc_test",
    edits: [{ new_text: "Inkling", old_text: "world" }],
    expected_revision: 3,
  });
  assert.equal(pinned.isError, true);
  assert.match(pinned.content[0].text, /revision_conflict, HTTP 409/u);
  assert.match(pinned.content[0].text, /read it again/u);
});

test("add_comment anchors to a unique quote", async () => {
  const body = "# Test\n\nThe cache is shared. The cache is warm.";
  const { dispatch, requests } = fakeWorkspace([
    (request) =>
      request.method === "GET" && request.path === "/api/documents/doc_test"
        ? Response.json(document(body, 2))
        : undefined,
    (request) =>
      request.path === "/api/documents/doc_test/comments"
        ? Response.json({
            revision: 3,
            threads: [
              {
                anchor: {
                  end: "e",
                  orphaned: false,
                  originalEnd: 0,
                  originalStart: 0,
                  prefix: "",
                  quote: "warm",
                  start: "s",
                  suffix: "",
                },
                createdAt: "2025-01-01T00:00:00.000Z",
                id: "thr_new",
                messages: [
                  {
                    authorDisplayName: "Ada",
                    authorId: "ada@example.com",
                    body: "Why?",
                    createdAt: "2025-01-01T00:00:00.000Z",
                    id: "msg_new",
                    updatedAt: "2025-01-01T00:00:00.000Z",
                  },
                ],
                resolved: false,
                updatedAt: "2025-01-01T00:00:00.000Z",
              },
            ],
          })
        : undefined,
  ]);

  const ambiguous = await callTool(dispatch, "add_comment", {
    body: "Why?",
    document: "doc_test",
    quote: "The cache",
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /occurs 2 times/u);

  const created = await callTool(dispatch, "add_comment", {
    body: "Why?",
    document: "doc_test",
    occurrence: 2,
    quote: "The cache",
  });
  assert.equal(created.isError, undefined);
  assert.match(created.content[0].text, /Created thread thr_new/u);
  const posted = requests.find((request) => request.path.endsWith("/comments"));
  const start = body.lastIndexOf("The cache");
  assert.deepEqual(posted?.body, {
    authorDisplayName: "Agent",
    body: "Why?",
    selection: { end: start + "The cache".length, start },
  });
});

test("read_document frames the body and slices line ranges", async () => {
  const body = ["---", "state: draft", "---", "# Test", "", "line six", "line seven"].join("\n");
  const { dispatch } = fakeWorkspace([
    (request) =>
      request.method === "GET" && request.path === "/api/documents/doc_test"
        ? Response.json(document(body, 9))
        : undefined,
  ]);
  const full = await callTool(dispatch, "read_document", { document: "doc_test" });
  assert.match(full.content[0].text, /Revision: 9 \(working head\)/u);
  assert.ok(full.content[0].text.includes(`<document_body>\n${body}\n</document_body>`));
  assert.equal(full.structuredContent.body, body);

  const range = await callTool(dispatch, "read_document", {
    document: "doc_test",
    end_line: 7,
    start_line: 6,
  });
  assert.match(range.content[0].text, /Lines: 6-7 of 7/u);
  assert.equal(range.structuredContent.body, "line six\nline seven");

  const invalid = await callTool(dispatch, "read_document", { document: "doc_test", extra: 1 });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid arguments for read_document/u);
});

test("search_passages renders sections with line ranges to read next", async () => {
  const { dispatch, requests } = fakeWorkspace([
    (request) =>
      request.method === "GET" && request.path.startsWith("/api/search?")
        ? Response.json({
            passages: [
              {
                documentId: "doc_test",
                endLine: 14,
                headingPath: ["Storage", "Recovery"],
                matchedBy: ["keyword", "semantic"],
                revision: 7,
                rfcNumber: 42,
                score: 0.03,
                snippet: "A checkpoint plus the journal tail recovers edits.",
                startLine: 12,
                title: "Storage",
              },
            ],
            semantic: true,
          })
        : undefined,
  ]);

  const result = await callTool(dispatch, "search_passages", {
    limit: 5,
    query: "how is recovery done?",
  });

  assert.equal(requests[0]?.path, "/api/search?q=how%20is%20recovery%20done%3F&limit=5");
  assert.match(result.content[0].text, /1\. RFC 0042 doc_test "Storage" › Storage › Recovery/u);
  assert.match(
    result.content[0].text,
    /Lines 12-14 at revision 7; matched by keyword and semantic/u,
  );
  assert.match(result.content[0].text, /<passage>A checkpoint plus the journal tail/u);
  assert.equal(result.structuredContent.passages[0].url, `${origin}/rfc/0042`);
  assert.equal(result.structuredContent.semantic, true);

  const missing = await callTool(dispatch, "search_passages", {});
  assert.equal(missing.isError, true);
});

test("a key rejected during a tool call becomes an HTTP 401", async () => {
  const { dispatch } = fakeWorkspace([
    () =>
      Response.json(
        { code: "unauthorized", message: "The API key is invalid or revoked.", retryable: false },
        { status: 401 },
      ),
  ]);
  const { body, response } = await rpc(dispatch, "tools/call", {
    arguments: { query: "" },
    name: "search_documents",
  });
  assert.equal(response.status, 401);
  assert.equal(body.id, 1);
  assert.match(response.headers.get("www-authenticate") ?? "", /invalid_token/u);
});
