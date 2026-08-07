import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { snippetCompletion } from "@codemirror/autocomplete";

import { knownLifecycleStates } from "@earendil-works/jot-core";
import type { PersonDto } from "@earendil-works/jot-protocol";

export interface FrontmatterVocabulary {
  readonly labels: readonly string[];
  readonly people: readonly PersonDto[];
  readonly states: readonly string[];
}

export const frontmatterFieldCompletionDetail = "Frontmatter field";

const fieldCompletions: readonly Completion[] = [
  snippetCompletion("authors:\n\t- ${}", {
    detail: frontmatterFieldCompletionDetail,
    info: "Author email addresses. Known workspace accounts render with their display names.",
    label: "authors",
    type: "property",
  }),
  snippetCompletion("state: ${draft}", {
    detail: frontmatterFieldCompletionDetail,
    info: "Lifecycle state to apply when this revision is published.",
    label: "state",
    type: "property",
  }),
  snippetCompletion("visibility: ${workspace}", {
    detail: frontmatterFieldCompletionDetail,
    info: "Intended visibility after publication. This does not grant access while editing.",
    label: "visibility",
    type: "property",
  }),
  snippetCompletion("sensitivity: ${normal}", {
    detail: frontmatterFieldCompletionDetail,
    info: "Marks the published revision as normal or confidential.",
    label: "sensitivity",
    type: "property",
  }),
  snippetCompletion("labels:\n\t- ${}", {
    detail: frontmatterFieldCompletionDetail,
    info: "Labels used to organize this note or RFC.",
    label: "labels",
    type: "property",
  }),
];

const staticValueCompletions = {
  sensitivity: enumCompletions(["normal", "confidential"], "Sensitivity"),
  visibility: enumCompletions(["workspace", "public"], "Visibility"),
} as const;

export function makeFrontmatterCompletionSource(
  vocabulary: FrontmatterVocabulary,
): CompletionSource {
  const states = uniqueValues([...knownLifecycleStates, ...vocabulary.states]);
  const labels = uniqueValues(vocabulary.labels);
  const stateCompletions = enumCompletions(states, "Lifecycle state");
  const labelCompletions = labels.map((label): Completion => ({
    apply: yamlScalar(label),
    detail: "Existing label",
    label,
    type: "enum",
  }));
  const authorCompletions = uniquePeople(vocabulary.people).map((person): Completion => ({
    apply: yamlScalar(person.email),
    detail: person.displayName,
    label: person.email,
    type: "enum",
  }));

  return (context) => {
    const bounds = frontmatterBounds(context);
    if (bounds === undefined) return null;
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);

    const pair = /^([A-Za-z_-]+)[\t ]*:[\t ]*(.*)$/u.exec(before);
    if (pair?.[1] !== undefined && pair[2] !== undefined) {
      const key = pair[1].toLowerCase();
      const value = pair[2];
      const valueFrom = context.pos - value.length;
      if (key === "state") {
        return valueResult(context, valueFrom, stateCompletions);
      }
      if (key === "visibility" || key === "sensitivity") {
        return valueResult(context, valueFrom, staticValueCompletions[key]);
      }
      if (key === "labels") {
        return inlineListResult(context, valueFrom, value, labelCompletions);
      }
      if (key === "authors") {
        return inlineListResult(context, valueFrom, value, authorCompletions);
      }
      return null;
    }

    const blockItem = /^(\s*-\s*)(.*)$/u.exec(before);
    if (blockItem?.[1] !== undefined && blockItem[2] !== undefined) {
      const field = blockListField(
        context,
        line.number,
        blockItem[1].indexOf("-"),
        bounds.fromLine,
      );
      const options =
        field === "authors" ? authorCompletions : field === "labels" ? labelCompletions : undefined;
      if (options !== undefined) {
        return valueResult(context, line.from + blockItem[1].length, options);
      }
    }

    const key = /^(\s*)([A-Za-z_-]*)$/u.exec(before);
    if (key?.[1] === "" && key[2] !== undefined) {
      if (!context.explicit && key[2] === "" && before !== "") return null;
      const existing = existingFrontmatterKeys(
        context,
        bounds.fromLine,
        bounds.toLine,
        line.number,
      );
      return {
        from: line.from,
        options: fieldCompletions.filter((completion) => !existing.has(completion.label)),
        to: keyCompletionEnd(context, line.to),
        validFor: /^[A-Za-z_-]*$/u,
      };
    }

    return null;
  };
}

function frontmatterBounds(
  context: CompletionContext,
): { readonly fromLine: number; readonly toLine: number } | undefined {
  const document = context.state.doc;
  if (document.lines < 2 || document.line(1).text !== "---") return undefined;
  const currentLine = document.lineAt(context.pos).number;
  for (let lineNumber = 2; lineNumber <= document.lines; lineNumber += 1) {
    if (/^---[\t ]*$/u.test(document.line(lineNumber).text)) {
      return currentLine < lineNumber ? { fromLine: 2, toLine: lineNumber - 1 } : undefined;
    }
  }
  return currentLine > 1 ? { fromLine: 2, toLine: document.lines } : undefined;
}

function existingFrontmatterKeys(
  context: CompletionContext,
  fromLine: number,
  toLine: number,
  currentLine: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
    if (lineNumber === currentLine) continue;
    const key = /^([A-Za-z_-]+)[\t ]*:/u.exec(context.state.doc.line(lineNumber).text)?.[1];
    if (key !== undefined) keys.add(key.toLowerCase());
  }
  return keys;
}

function keyCompletionEnd(context: CompletionContext, lineEnd: number): number {
  const suffix = context.state.sliceDoc(context.pos, lineEnd);
  const key = /^[A-Za-z_-]*/u.exec(suffix)?.[0] ?? "";
  return context.pos + key.length;
}

function valueResult(
  context: CompletionContext,
  from: number,
  options: readonly Completion[],
): CompletionResult | null {
  if (options.length === 0) return null;
  return {
    from,
    options,
    to: scalarCompletionEnd(context),
  };
}

function scalarCompletionEnd(context: CompletionContext): number {
  const line = context.state.doc.lineAt(context.pos);
  const suffix = context.state.sliceDoc(context.pos, line.to);
  const value = /^[^,\]\n]*/u.exec(suffix)?.[0] ?? "";
  return context.pos + value.length;
}

function inlineListResult(
  context: CompletionContext,
  valueFrom: number,
  value: string,
  options: readonly Completion[],
): CompletionResult | null {
  if (options.length === 0) return null;
  const open = value.lastIndexOf("[");
  const close = value.lastIndexOf("]");
  if (open > close) {
    const separator = Math.max(open, value.lastIndexOf(","));
    const fragment = value.slice(separator + 1);
    const whitespace = /^\s*/u.exec(fragment)?.[0].length ?? 0;
    return valueResult(context, valueFrom + separator + 1 + whitespace, options);
  }
  if (value.trim() === "") {
    return {
      from: valueFrom,
      options: options.map((completion) => ({
        ...completion,
        apply: `[${yamlScalar(completion.label)}]`,
      })),
      to: context.pos,
    };
  }
  return {
    from: valueFrom,
    options: options.map((completion) => ({
      ...completion,
      apply: `[${yamlScalar(completion.label)}]`,
    })),
    to: scalarCompletionEnd(context),
  };
}

function blockListField(
  context: CompletionContext,
  currentLine: number,
  currentIndent: number,
  firstFrontmatterLine: number,
): "authors" | "labels" | undefined {
  for (let lineNumber = currentLine - 1; lineNumber >= firstFrontmatterLine; lineNumber -= 1) {
    const text = context.state.doc.line(lineNumber).text;
    if (text.trim() === "") continue;
    const indent = /^\s*/u.exec(text)?.[0].length ?? 0;
    if (indent >= currentIndent) continue;
    const field = /^(authors|labels)[\t ]*:[\t ]*$/u.exec(text)?.[1];
    return field === "authors" || field === "labels" ? field : undefined;
  }
  return undefined;
}

function enumCompletions(values: readonly string[], detail: string): readonly Completion[] {
  return values.map((value): Completion => ({
    apply: yamlScalar(value),
    detail,
    label: value,
    type: "enum",
  }));
}

function uniqueValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = value.trim();
    if (normalized === "" || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function uniquePeople(people: readonly PersonDto[]): readonly PersonDto[] {
  const byEmail = new Map<string, PersonDto>();
  for (const person of people) {
    const email = person.email.trim().toLocaleLowerCase("en");
    if (email !== "" && !byEmail.has(email)) byEmail.set(email, { ...person, email });
  }
  return [...byEmail.values()].toSorted((left, right) => left.email.localeCompare(right.email));
}

function yamlScalar(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_. /-]*$/u.test(value) &&
    !/^(?:false|null|true|yes|no|on|off)$/iu.test(value)
    ? value
    : JSON.stringify(value);
}
