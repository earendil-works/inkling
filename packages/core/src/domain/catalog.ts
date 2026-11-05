import { Effect } from "effect";

import { DomainError, documentId, normalizeDocumentMetadata } from "./document.ts";
import type {
  DocumentId,
  DocumentMetadata,
  DocumentRevision,
  LifecycleState,
  PersonId,
  PersonReference,
  Visibility,
} from "./document.ts";

export type RegistryStatus = "pending" | "active" | "deleted" | "purged";

/** A section heading of a document, as references resolve it. */
export interface CatalogHeading {
  readonly id: string;
  /** The section number; only RFC headings are numbered. */
  readonly number?: string | undefined;
  readonly text: string;
}

export interface CatalogSummary {
  readonly documentId: DocumentId;
  readonly revision: DocumentRevision;
  readonly rfcNumber?: number | undefined;
  readonly title: string;
  readonly state: LifecycleState;
  readonly visibility: Visibility;
  readonly labels: readonly string[];
  /** Valid labels proposed by the current working frontmatter. */
  readonly workingLabels?: readonly string[] | undefined;
  readonly authors: readonly PersonReference[];
  readonly reviewers: readonly PersonReference[];
  readonly approvers: readonly PersonReference[];
  readonly updatedAt: string;
  readonly excerpt: string;
  /** Complete metadata projection for workspace reads without loading a document authority. */
  readonly metadata?: DocumentMetadata | undefined;
  readonly publishedRevision?: DocumentRevision | undefined;
  /** Section headings of the working draft, so references resolve without loading it. */
  readonly headings?: readonly CatalogHeading[] | undefined;
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

/** Documents whose indexed body matches each normalized free-text term. */
export type CatalogBodyMatches = ReadonlyMap<string, ReadonlySet<DocumentId>>;

export interface CatalogSearchOptions {
  /**
   * Keeps only summaries the reader may see, before ranking and limits apply,
   * so documents hidden from the reader never displace visible ones.
   */
  readonly visible?: ((summary: CatalogSummary) => boolean) | undefined;
  readonly bodyMatches?: CatalogBodyMatches | undefined;
  readonly currentPersonId?: PersonId | undefined;
  readonly includeDeleted?: boolean | undefined;
  readonly onlyDeleted?: boolean | undefined;
  readonly publicOnly?: boolean | undefined;
  readonly limit?: number | undefined;
}

export const catalogSearchFields = [
  "label",
  "state",
  "visibility",
  "author",
  "reviewer",
  "approver",
  "person",
  "rfc",
  "is",
  "has",
] as const;

export type CatalogSearchField = (typeof catalogSearchFields)[number];

export interface CatalogSearchTerm {
  readonly field?: CatalogSearchField | undefined;
  readonly negated: boolean;
  readonly value: string;
}

export interface CatalogSearchQuery {
  readonly terms: readonly CatalogSearchTerm[];
}

export function emptyWorkspaceCatalog(startingRfcNumber = 1): WorkspaceCatalogState {
  return { entries: [], nextRfcNumber: startingRfcNumber, people: [] };
}

export function normalizeWorkspaceCatalog(state: WorkspaceCatalogState): WorkspaceCatalogState {
  return {
    ...state,
    entries: state.entries.map((entry) => {
      if (entry.summary === undefined) return entry;
      const legacy = entry.summary as CatalogSummary & {
        readonly normalizedBody?: string | undefined;
        readonly sensitivity?: "confidential" | "normal" | undefined;
        readonly visibility: Visibility | "workspace";
      };
      const { normalizedBody: _normalizedBody, sensitivity, ...withoutSensitivity } = legacy;
      const visibility =
        sensitivity === "confidential" || legacy.visibility === "confidential"
          ? "confidential"
          : legacy.visibility === "public"
            ? "public"
            : "private";
      return {
        ...entry,
        summary: {
          ...withoutSensitivity,
          metadata:
            legacy.metadata === undefined ? undefined : normalizeDocumentMetadata(legacy.metadata),
          visibility,
        },
      };
    }),
  };
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
  const entry = state.entries.find((candidate) => candidate.documentId === document);
  return entry?.status === "purged"
    ? failure("document_purged", "The document was permanently deleted.")
    : updateEntry(state, document, (candidate) => ({ ...candidate, status: "active" }));
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
  return updateEntry(state, document, (entry) =>
    entry.status === "purged" ? entry : { ...entry, status: "deleted" },
  );
}

export function purgeDocument(
  state: WorkspaceCatalogState,
  document: DocumentId,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  return Effect.succeed({
    ...state,
    entries: state.entries.map((entry) =>
      entry.documentId === document
        ? {
            creationKey: entry.creationKey,
            documentId: entry.documentId,
            rfcNumber: entry.rfcNumber,
            status: "purged" as const,
          }
        : entry,
    ),
  });
}

export function applyCatalogSummary(
  state: WorkspaceCatalogState,
  summary: CatalogSummary,
): Effect.Effect<WorkspaceCatalogState, DomainError> {
  return updateEntry(state, summary.documentId, (entry) =>
    entry.status === "purged" ||
    (entry.summary !== undefined && entry.summary.revision >= summary.revision)
      ? entry
      : { ...entry, rfcNumber: summary.rfcNumber ?? entry.rfcNumber, summary },
  );
}

export function searchCatalog(
  state: WorkspaceCatalogState,
  query: string,
  options: CatalogSearchOptions = {},
): readonly CatalogSummary[] {
  const parsed = parseCatalogSearchQuery(query);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const matches = state.entries
    .filter((entry) =>
      options.onlyDeleted === true
        ? entry.status === "deleted"
        : options.includeDeleted === true || entry.status === "active",
    )
    .flatMap((entry) => (entry.summary === undefined ? [] : [entry.summary]))
    .filter((summary) => options.visible === undefined || options.visible(summary))
    .filter(
      (summary) =>
        options.publicOnly !== true ||
        (summary.visibility === "public" &&
          summary.publishedRevision !== undefined &&
          summary.metadata?.personalOwner === undefined),
    )
    .flatMap((summary) => {
      const score = scoreSummary(summary, parsed, state.people, options);
      return score === undefined ? [] : [{ score, summary }];
    });
  const summaries =
    parsed.terms.length === 0
      ? options.onlyDeleted === true
        ? matches
            .map(({ summary }) => summary)
            .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        : orderCatalog(matches.map(({ summary }) => summary))
      : matches
          .toSorted(
            (left, right) =>
              right.score - left.score ||
              Date.parse(right.summary.updatedAt) - Date.parse(left.summary.updatedAt),
          )
          .map(({ summary }) => summary);
  return summaries.slice(0, limit);
}

/** Active documents that satisfy every structured filter in the query; free text is ignored. */
export function filterCatalog(
  state: WorkspaceCatalogState,
  query: CatalogSearchQuery,
  options: Pick<CatalogSearchOptions, "currentPersonId" | "visible"> = {},
): readonly CatalogSummary[] {
  const filters = query.terms.filter((term) => term.field !== undefined);
  return state.entries.flatMap((entry) => {
    const summary = entry.summary;
    if (entry.status !== "active" || summary === undefined) return [];
    if (options.visible !== undefined && !options.visible(summary)) return [];
    if (filters.length === 0) return [summary];
    const indexed = indexSummary(summary, state.people);
    return filters.every((term) => {
      const field = term.field;
      if (field === undefined) return true;
      const matched = matchesSearchFilter(
        summary,
        indexed,
        field,
        term.value,
        options.currentPersonId,
      );
      return term.negated ? !matched : matched;
    })
      ? [summary]
      : [];
  });
}

export function parseCatalogSearchQuery(query: string): CatalogSearchQuery {
  return {
    terms: tokenizeSearchQuery(query).flatMap((rawToken): readonly CatalogSearchTerm[] => {
      const negated = rawToken.startsWith("-") && rawToken.length > 1;
      const token = negated ? rawToken.slice(1) : rawToken;
      const separator = token.indexOf(":");
      const rawField = separator === -1 ? undefined : token.slice(0, separator).toLowerCase();
      const field = rawField === undefined ? undefined : searchFieldAliases[rawField];
      const rawValue = field === undefined ? token : token.slice(separator + 1);
      const value = normalizeSearchText(rawValue);
      return value === "" ? [] : [{ field, negated, value }];
    }),
  };
}

export function publicCatalog(state: WorkspaceCatalogState): readonly CatalogSummary[] {
  return searchCatalog(state, "", { publicOnly: true, limit: 500 });
}

function orderCatalog(summaries: readonly CatalogSummary[]): readonly CatalogSummary[] {
  const rfcs = summaries
    .filter((summary) => summary.rfcNumber !== undefined)
    .toSorted((left, right) => (right.rfcNumber ?? 0) - (left.rfcNumber ?? 0));
  const notes = summaries
    .filter((summary) => summary.rfcNumber === undefined)
    .toSorted(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        right.documentId.localeCompare(left.documentId),
    );
  const ordered: CatalogSummary[] = [];
  let noteIndex = 0;
  for (const rfc of rfcs) {
    while (true) {
      const note = notes[noteIndex];
      if (note === undefined || Date.parse(note.updatedAt) <= Date.parse(rfc.updatedAt)) break;
      ordered.push(note);
      noteIndex += 1;
    }
    ordered.push(rfc);
  }
  ordered.push(...notes.slice(noteIndex));
  return ordered;
}

export function upsertPerson(
  state: WorkspaceCatalogState,
  entry: PeopleDirectoryEntry,
): WorkspaceCatalogState {
  const aliases = [...new Set(entry.aliases.map(normalizeSearchText).filter(Boolean))];
  const email = entry.person.email.trim().toLocaleLowerCase("en");
  const people = state.people.filter(
    (item) =>
      item.person.id !== entry.person.id &&
      item.person.email.trim().toLocaleLowerCase("en") !== email,
  );
  return {
    ...state,
    people: [...people, { ...entry, aliases, person: { ...entry.person, email } }],
  };
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
    .replace(/\p{Mark}+/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

interface IndexedCatalogSummary {
  readonly all: string;
  readonly approvers: string;
  readonly authors: string;
  readonly labels: readonly string[];
  readonly people: string;
  readonly reviewers: string;
  readonly rfc: string;
  readonly state: string;
  readonly title: string;
  readonly visibility: string;
}

const searchFieldAliases: Readonly<Record<string, CatalogSearchField | undefined>> = {
  approver: "approver",
  author: "author",
  from: "author",
  has: "has",
  is: "is",
  label: "label",
  person: "person",
  reviewer: "reviewer",
  rfc: "rfc",
  state: "state",
  status: "state",
  tag: "label",
  visibility: "visibility",
};

function scoreSummary(
  summary: CatalogSummary,
  query: CatalogSearchQuery,
  directory: readonly PeopleDirectoryEntry[],
  options: CatalogSearchOptions,
): number | undefined {
  if (query.terms.length === 0) return 1;
  const indexed = indexSummary(summary, directory);
  let score = 0;
  for (const term of query.terms) {
    const bodyMatched =
      term.field === undefined &&
      options.bodyMatches?.get(term.value)?.has(summary.documentId) === true;
    const matched =
      term.field === undefined
        ? bodyMatched || indexed.all.includes(term.value)
        : matchesSearchFilter(summary, indexed, term.field, term.value, options.currentPersonId);
    if (term.negated ? matched : !matched) return undefined;
    if (!term.negated) {
      score +=
        term.field === undefined
          ? scoreFreeText(summary, indexed, term.value, bodyMatched)
          : scoreFilter(term.field);
    }
  }
  return score;
}

function indexSummary(
  summary: CatalogSummary,
  directory: readonly PeopleDirectoryEntry[],
): IndexedCatalogSummary {
  const personText = (people: readonly PersonReference[]): string =>
    normalizeSearchText(
      people
        .flatMap((person) =>
          [person.displayName, person.email].concat(
            directory.find((entry) => entry.person.id === person.id)?.aliases ?? [],
          ),
        )
        .join(" "),
    );
  const authors = personText(summary.authors);
  const reviewers = personText(summary.reviewers);
  const approvers = personText(summary.approvers);
  const labels = (summary.workingLabels ?? summary.labels).map(normalizeSearchText);
  const rfc =
    summary.rfcNumber === undefined
      ? ""
      : normalizeSearchText(
          `rfc ${summary.rfcNumber} ${String(summary.rfcNumber).padStart(4, "0")}`,
        );
  const title = normalizeSearchText(summary.title);
  const state = normalizeSearchText(summary.state);
  const visibility = normalizeSearchText(summary.visibility);
  const people = `${authors} ${reviewers} ${approvers}`.trim();
  return {
    all: [
      rfc,
      title,
      labels.join(" "),
      people,
      state,
      visibility,
      summary.metadata?.relatedDocuments.map((related) => related.documentId).join(" ") ?? "",
    ]
      .filter(Boolean)
      .join(" "),
    approvers,
    authors,
    labels,
    people,
    reviewers,
    rfc,
    state,
    title,
    visibility,
  };
}

function matchesSearchFilter(
  summary: CatalogSummary,
  indexed: IndexedCatalogSummary,
  field: CatalogSearchField,
  value: string,
  currentPersonId?: PersonId,
): boolean {
  switch (field) {
    case "label":
      return indexed.labels.includes(value);
    case "state":
      return indexed.state === value;
    case "visibility":
      return indexed.visibility === value;
    case "author":
      return matchesPersonFilter(summary.authors, indexed.authors, value, currentPersonId);
    case "reviewer":
      return matchesPersonFilter(summary.reviewers, indexed.reviewers, value, currentPersonId);
    case "approver":
      return matchesPersonFilter(summary.approvers, indexed.approvers, value, currentPersonId);
    case "person":
      return matchesPersonFilter(
        [...summary.authors, ...summary.reviewers, ...summary.approvers],
        indexed.people,
        value,
        currentPersonId,
      );
    case "rfc": {
      const requested = Number(value.replace(/^rfc /u, ""));
      return Number.isSafeInteger(requested) && summary.rfcNumber === requested;
    }
    case "has":
      return value === "rfc"
        ? summary.rfcNumber !== undefined
        : value === "publication"
          ? summary.publishedRevision !== undefined
          : false;
    case "is":
      switch (value) {
        case "rfc":
          return summary.rfcNumber !== undefined;
        case "note":
          return summary.rfcNumber === undefined;
        case "published":
          return summary.publishedRevision !== undefined;
        case "unpublished":
          return summary.publishedRevision === undefined;
        case "confidential":
          return summary.visibility === "confidential";
        case "public":
          return summary.visibility === "public";
        case "private":
          return summary.visibility === "private";
        // Personal documents of the reader, and those others shared with them.
        case "personal":
          return (
            summary.metadata?.personalOwner !== undefined &&
            summary.metadata.personalOwner === currentPersonId
          );
        case "shared":
          return (
            summary.metadata?.personalOwner !== undefined &&
            summary.metadata.personalOwner !== currentPersonId
          );
        default:
          return false;
      }
  }
}

function matchesPersonFilter(
  people: readonly PersonReference[],
  indexed: string,
  value: string,
  currentPersonId?: PersonId,
): boolean {
  if (value === "me") {
    return currentPersonId !== undefined && people.some((person) => person.id === currentPersonId);
  }
  return indexed.includes(value);
}

function scoreFreeText(
  summary: CatalogSummary,
  indexed: IndexedCatalogSummary,
  value: string,
  bodyMatched: boolean,
): number {
  let score = 0;
  if (indexed.rfc === value || String(summary.rfcNumber ?? "") === String(Number(value))) {
    score += 500;
  }
  if (indexed.title === value) score += 400;
  if (indexed.title.startsWith(value)) score += 250;
  else if (indexed.title.includes(value)) score += 180;
  if (indexed.labels.includes(value)) score += 180;
  else if (indexed.labels.some((label) => label.includes(value))) score += 120;
  if (indexed.people.includes(value)) score += 100;
  if (indexed.state === value) score += 90;
  if (indexed.visibility === value) score += 60;
  if (bodyMatched) score += 20;
  return score + 1;
}

function scoreFilter(field: CatalogSearchField): number {
  switch (field) {
    case "rfc":
      return 500;
    case "label":
    case "has":
    case "is":
      return 180;
    case "author":
    case "reviewer":
    case "approver":
    case "person":
      return 120;
    case "state":
      return 100;
    case "visibility":
      return 80;
  }
}

function tokenizeSearchQuery(query: string): readonly string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const commit = (): void => {
    if (token !== "") tokens.push(token);
    token = "";
  };

  for (const character of query) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== undefined) {
      escaped = true;
    } else if (character === quote) {
      quote = undefined;
    } else if ((character === '"' || character === "'") && quote === undefined) {
      quote = character;
    } else if (/\s/u.test(character) && quote === undefined) {
      commit();
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  commit();
  return tokens;
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
