import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { snippetCompletion } from "@codemirror/autocomplete";

import { knownLifecycleStates } from "@earendil-works/jot-core";

export interface FrontmatterVocabulary {
  readonly labels: readonly string[];
  readonly states: readonly string[];
}

export const frontmatterFieldCompletionDetail = "Frontmatter field";

const fieldCompletions: readonly Completion[] = [
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
        return inlineLabelResult(context, valueFrom, value, labelCompletions);
      }
      return null;
    }

    const blockLabel = /^(\s*-\s*)(.*)$/u.exec(before);
    if (
      blockLabel?.[1] !== undefined &&
      blockLabel[2] !== undefined &&
      isLabelsBlockItem(context, line.number, blockLabel[1].indexOf("-"), bounds.fromLine)
    ) {
      return valueResult(context, line.from + blockLabel[1].length, labelCompletions);
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

function inlineLabelResult(
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

function isLabelsBlockItem(
  context: CompletionContext,
  currentLine: number,
  currentIndent: number,
  firstFrontmatterLine: number,
): boolean {
  for (let lineNumber = currentLine - 1; lineNumber >= firstFrontmatterLine; lineNumber -= 1) {
    const text = context.state.doc.line(lineNumber).text;
    if (text.trim() === "") continue;
    const indent = /^\s*/u.exec(text)?.[0].length ?? 0;
    if (indent >= currentIndent) continue;
    return /^labels[\t ]*:[\t ]*$/u.test(text);
  }
  return false;
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

function yamlScalar(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_. /-]*$/u.test(value) &&
    !/^(?:false|null|true|yes|no|on|off)$/iu.test(value)
    ? value
    : JSON.stringify(value);
}
