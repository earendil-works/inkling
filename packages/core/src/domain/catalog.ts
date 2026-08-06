import { Effect } from "effect";

import { DomainError, documentId } from "./document.ts";
import type {
  DocumentId,
  DocumentMetadata,
  DocumentRevision,
  LifecycleState,
  PersonReference,
  Sensitivity,
  Visibility,
} from "./document.ts";

export type RegistryStatus = "pending" | "active" | "deleted";

export interface CatalogSummary {
  readonly documentId: DocumentId;
  readonly revision: DocumentRevision;
  readonly rfcNumber?: number | undefined;
  readonly title: string;
  readonly state: LifecycleState;
  readonly visibility: Visibility;
  readonly sensitivity: Sensitivity;
  readonly labels: readonly string[];
  readonly authors: readonly PersonReference[];
  readonly reviewers: readonly PersonReference[];
  readonly approvers: readonly PersonReference[];
  readonly updatedAt: string;
  readonly excerpt: string;
  /** Complete metadata projection for workspace reads without loading a document authority. */
  readonly metadata?: DocumentMetadata | undefined;
  readonly normalizedBody: string;
  readonly publishedRevision?: DocumentRevision | undefined;
}

export interface RegistryEntry {
  readonly documentId: DocumentId;
  readonly status: RegistryStatus;
  readonly rfcNumber?: number | undefined;
  readonly creationKey: string;
  readonly summary?: CatalogSummary | undefined;
}

export interface PeopleDirectoryEntry {
  readonly person: PersonReference;
  readonly aliases: readonly string[];
}

export interface WorkspaceCatalogState {
  readonly nextRfcNumber: number;
  readonly entries: readonly RegistryEntry[];
  readonly people: readonly PeopleDirectoryEntry[];
}

export interface DocumentReservation {
  readonly state: WorkspaceCatalogState;
  readonly entry: RegistryEntry;
}

export interface RfcAllocation {
  readonly state: WorkspaceCatalogState;
  readonly rfcNumber: number;
}

export interface CatalogSearchOptions {
  readonly includeDeleted?: boolean | undefined;
  readonly publicOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

export function emptyWorkspaceCatalog(startingRfcNumber = 1): WorkspaceCatalogState {
  return { entries: [], nextRfcNumber: startingRfcNumber, people: [] };
}

export function reserveDocument(
  state: WorkspaceCatalogState,
  input: {
    readonly creationKey: string;
    readonly documentId: string;
    readonly allocateRfc: boolean;
    readonly requestedRfcNumber?: number | undefined;
  },
): Effect.Effect<DocumentReservation, DomainError> {
  return Effect.gen(function* () {
    const existing = state.entries.find((entry) => entry.creationKey === input.creationKey);
    if (existing !== undefined) {
      return { entry: existing, state };
    }
    if (input.creationKey.trim().length === 0 || input.creationKey.length > 200) {
      return yield* failure("invalid_creation_key", "Creation idempotency keys must be non-empty.");
    }

    const id = yield* documentId(input.documentId);
    if (state.entries.some((entry) => entry.documentId === id)) {
      return yield* failure("duplicate_document", "The document identifier is already registered.");
    }

    const requested = input.requestedRfcNumber;
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) {
      return yield* failure("invalid_rfc_number", "RFC numbers must be positive integers.");
    }
    const rfcNumber = requested ?? (input.allocateRfc ? state.nextRfcNumber : undefined);
    if (rfcNumber !== undefined && state.entries.some((entry) => entry.rfcNumber === rfcNumber)) {
      return yield* failure("duplicate_rfc_number", `RFC ${rfcNumber} is already allocated.`);
    }

    const entry: RegistryEntry = {
      creationKey: input.creationKey,
      documentId: id,
      rfcNumber,
      status: "pending",
    };
    const nextRfcNumber =
      rfcNumber === undefined ? state.nextRfcNumber : Math.max(state.nextRfcNumber, rfcNumber + 1);
    return {
      entry,
      state: { ...state, entries: [...state.entries, entry], nextRfcNumber },
    };
  });
}

export function activateDocument(
  state: WorkspaceCatalogState,
  document: DocumentId,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  return updateEntry(state, document, (entry) => ({ ...entry, status: "active" }));
}

export function allocateRfcNumber(
  state: WorkspaceCatalogState,
  rawDocumentId: string,
): Effect.Effect<RfcAllocation, DomainError> {
  return Effect.gen(function* () {
    const id = yield* documentId(rawDocumentId);
    const entry = state.entries.find((candidate) => candidate.documentId === id);
    if (entry === undefined || entry.status !== "active") {
      return yield* failure("document_not_active", "The document is not active in the workspace.");
    }
    if (entry.rfcNumber !== undefined) {
      return { rfcNumber: entry.rfcNumber, state };
    }

    const rfcNumber = state.nextRfcNumber;
    if (state.entries.some((candidate) => candidate.rfcNumber === rfcNumber)) {
      return yield* failure("duplicate_rfc_number", `RFC ${rfcNumber} is already allocated.`);
    }
    return {
      rfcNumber,
      state: {
        ...state,
        entries: state.entries.map((candidate) =>
          candidate.documentId === id ? { ...candidate, rfcNumber } : candidate,
        ),
        nextRfcNumber: rfcNumber + 1,
      },
    };
  });
}

export function tombstoneDocument(
  state: WorkspaceCatalogState,
  document: DocumentId,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  return updateEntry(state, document, (entry) => ({ ...entry, status: "deleted" }));
}

export function applyCatalogSummary(
  state: WorkspaceCatalogState,
  summary: CatalogSummary,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  return updateEntry(state, summary.documentId, (entry) =>
    entry.summary !== undefined && entry.summary.revision >= summary.revision
      ? entry
      : { ...entry, summary },
  );
}

export function searchCatalog(
  state: WorkspaceCatalogState,
  query: string,
  options: CatalogSearchOptions = {},
): readonly CatalogSummary[] {
  const terms = normalizeSearchText(query).split(" ").filter(Boolean);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return state.entries
    .filter((entry) => options.includeDeleted === true || entry.status === "active")
    .flatMap((entry) => (entry.summary === undefined ? [] : [entry.summary]))
    .filter(
      (summary) =>
        options.publicOnly !== true ||
        (summary.visibility === "public" && summary.publishedRevision !== undefined),
    )
    .map((summary) => ({ score: scoreSummary(summary, terms, state.people), summary }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.summary.updatedAt) - Date.parse(left.summary.updatedAt),
    )
    .slice(0, limit)
    .map(({ summary }) => summary);
}

export function publicCatalog(state: WorkspaceCatalogState): readonly CatalogSummary[] {
  return searchCatalog(state, "", { publicOnly: true, limit: 500 }).toSorted(
    (left, right) =>
      (left.rfcNumber ?? Number.MAX_SAFE_INTEGER) - (right.rfcNumber ?? Number.MAX_SAFE_INTEGER),
  );
}

export function upsertPerson(
  state: WorkspaceCatalogState,
  entry: PeopleDirectoryEntry,
): WorkspaceCatalogState {
  const aliases = [...new Set(entry.aliases.map(normalizeSearchText).filter(Boolean))];
  const people = state.people.filter((item) => item.person.id !== entry.person.id);
  return { ...state, people: [...people, { ...entry, aliases }] };
}

export function findPerson(
  state: WorkspaceCatalogState,
  nameOrEmail: string,
): PersonReference | undefined {
  const query = normalizeSearchText(nameOrEmail);
  return state.people.find(
    (entry) =>
      normalizeSearchText(entry.person.displayName) === query ||
      normalizeSearchText(entry.person.email) === query ||
      entry.aliases.includes(query),
  )?.person;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function scoreSummary(
  summary: CatalogSummary,
  terms: readonly string[],
  directory: readonly PeopleDirectoryEntry[],
): number {
  if (terms.length === 0) {
    return 1;
  }
  const people = [...summary.authors, ...summary.reviewers, ...summary.approvers]
    .flatMap((person) =>
      [person.displayName, person.email].concat(
        directory.find((entry) => entry.person.id === person.id)?.aliases ?? [],
      ),
    )
    .join(" ");
  const weighted = [
    [String(summary.rfcNumber ?? ""), 12],
    [summary.title, 10],
    [summary.labels.join(" "), 8],
    [people, 6],
    [summary.state, 5],
    [summary.visibility, 4],
    [summary.excerpt, 3],
    [summary.normalizedBody, 1],
  ] as const;
  return terms.every((term) =>
    weighted.some(([value]) => normalizeSearchText(value).includes(term)),
  )
    ? terms.reduce(
        (score, term) =>
          score +
          weighted.reduce(
            (fieldScore, [value, weight]) =>
              fieldScore + (normalizeSearchText(value).includes(term) ? weight : 0),
            0,
          ),
        0,
      )
    : 0;
}

function updateEntry(
  state: WorkspaceCatalogState,
  document: DocumentId,
  update: (entry: RegistryEntry) => RegistryEntry,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  const index = state.entries.findIndex((entry) => entry.documentId === document);
  if (index === -1) {
    return failure("document_not_registered", "The document is not in the workspace registry.");
  }
  return Effect.succeed({
    ...state,
    entries: state.entries.map((entry, entryIndex) =>
      entryIndex === index ? update(entry) : entry,
    ),
  });
}

function failure<A = never>(code: string, message: string): Effect.Effect<A, DomainError> {
  return Effect.fail(new DomainError({ code, message }));
}
