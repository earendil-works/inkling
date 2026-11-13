import { Data, Effect } from "effect";

import type { DocumentResponse } from "@earendil-works/inkling-protocol";

import { metadataWithFrontmatter } from "./components/document-metadata.ts";
import { documentRenderSettings, renderMarkdown } from "./markdown.tsx";
import { documentExportFileName } from "./ui.ts";
import type { ReferenceResolutionRecord } from "./markdown.tsx";

export type DocumentExportFormat = "docx" | "pdf";

export class DocumentExportError extends Data.TaggedError("DocumentExportError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** A run of text with one style. */
interface Run {
  readonly bold: boolean;
  readonly code: boolean;
  readonly href: string | undefined;
  readonly italic: boolean;
  readonly text: string;
}

type Block =
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly runs: readonly Run[] }
  | {
      readonly depth: number;
      readonly kind: "item";
      readonly list: number;
      readonly marker: string;
      readonly runs: readonly Run[];
    }
  | { readonly kind: "paragraph"; readonly quote: boolean; readonly runs: readonly Run[] }
  | { readonly kind: "rule" }
  | { readonly kind: "table"; readonly rows: readonly (readonly (readonly Run[])[])[] };

/**
 * Renders a document as the reader does, converts it into a .docx or .pdf file and downloads it.
 * The libraries load on demand so they stay out of the reader's bundle.
 */
export function downloadDocument(
  format: DocumentExportFormat,
  response: DocumentResponse,
  references: ReferenceResolutionRecord | undefined,
): Effect.Effect<void, DocumentExportError> {
  const fail = (cause: unknown): DocumentExportError =>
    new DocumentExportError({ cause, message: `Could not create the .${format} file.` });
  return renderMarkdown(
    response.body,
    false,
    documentRenderSettings(response.metadata, references),
  ).pipe(
    Effect.mapError(fail),
    Effect.flatMap((rendered) =>
      Effect.tryPromise({
        catch: fail,
        try: async () => {
          const { title } = metadataWithFrontmatter(
            response.metadata,
            rendered.frontmatter,
            rendered.title,
          );
          const article = new DOMParser().parseFromString(rendered.html, "text/html").body;
          const blocks = articleBlocks(article);
          const blob =
            format === "docx" ? await docxBlob(title, blocks) : await pdfBlob(title, blocks);
          const url = URL.createObjectURL(blob);
          try {
            const link = document.createElement("a");
            link.href = url;
            link.download = documentExportFileName(title, response.metadata.rfcNumber, format);
            link.click();
          } finally {
            setTimeout(() => URL.revokeObjectURL(url), 0);
          }
        },
      }),
    ),
  );
}

const plain: Run = { bold: false, code: false, href: undefined, italic: false, text: "" };

function articleBlocks(root: Element): Block[] {
  const blocks: Block[] = [];
  let lists = 0;
  const visit = (parent: Element, quote: boolean): void => {
    let pending: Run[] = [];
    const flush = (): void => {
      const runs = trimRuns(pending);
      if (runs.length > 0) blocks.push({ kind: "paragraph", quote, runs });
      pending = [];
    };
    for (const node of parent.childNodes) {
      if (!(node instanceof Element)) {
        pending.push(...inlineRuns(node, plain));
        continue;
      }
      const tag = node.tagName.toLowerCase();
      if (node.matches("[data-mermaid]")) {
        flush();
        blocks.push({
          kind: "code",
          text: (node.querySelector("code")?.textContent ?? "").replace(/\n$/u, ""),
        });
      } else if (/^h[1-6]$/u.test(tag)) {
        flush();
        blocks.push({
          kind: "heading",
          level: Number(tag[1]),
          runs: trimRuns(inlineRuns(node, plain)),
        });
      } else if (tag === "p") {
        flush();
        const runs = trimRuns(inlineRuns(node, plain));
        if (runs.length > 0) blocks.push({ kind: "paragraph", quote, runs });
      } else if (tag === "ul" || tag === "ol") {
        flush();
        visitList(node, 0);
      } else if (tag === "pre") {
        flush();
        blocks.push({ kind: "code", text: (node.textContent ?? "").replace(/\n$/u, "") });
      } else if (tag === "blockquote") {
        flush();
        visit(node, true);
      } else if (tag === "table") {
        flush();
        const rows = [...node.querySelectorAll("tr")].map((row) =>
          [...row.querySelectorAll("th, td")].map((cell) => {
            const bold = cell.tagName.toLowerCase() === "th";
            return trimRuns(inlineRuns(cell, { ...plain, bold }));
          }),
        );
        if (rows.length > 0) blocks.push({ kind: "table", rows });
      } else if (tag === "hr") {
        flush();
        blocks.push({ kind: "rule" });
      } else if (isBlockContainer(node)) {
        flush();
        visit(node, quote);
      } else {
        pending.push(...inlineRuns(node, plain));
      }
    }
    flush();
  };
  const visitList = (list: Element, depth: number): void => {
    const id = lists++;
    const ordered = list.tagName.toLowerCase() === "ol";
    let number = Number(list.getAttribute("start") ?? "1");
    for (const item of list.children) {
      if (item.tagName.toLowerCase() !== "li") continue;
      const runs: Run[] = [];
      const nested: Element[] = [];
      for (const child of item.childNodes) {
        if (child instanceof Element && /^(ul|ol)$/iu.test(child.tagName)) nested.push(child);
        else {
          if (runs.length > 0 && child instanceof Element && child.tagName.toLowerCase() === "p") {
            runs.push({ ...plain, text: " " });
          }
          runs.push(...inlineRuns(child, plain));
        }
      }
      const marker = ordered ? `${number++}.` : "•";
      blocks.push({ depth, kind: "item", list: id, marker, runs: trimRuns(runs) });
      for (const child of nested) visitList(child, depth + 1);
    }
  };
  visit(root, false);
  return blocks;
}

function isBlockContainer(element: Element): boolean {
  return [...element.children].some((child) =>
    /^(address|article|aside|blockquote|details|div|dl|figure|h[1-6]|hr|ol|p|pre|section|table|ul)$/iu.test(
      child.tagName,
    ),
  );
}

function inlineRuns(node: Node, style: Run): Run[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = style.code
      ? (node.textContent ?? "")
      : (node.textContent ?? "").replace(/\s+/gu, " ");
    return text === "" ? [] : [{ ...style, text }];
  }
  if (!(node instanceof Element)) return [];
  if (node.matches(".inkling-heading-anchor, button, svg, script, style, template")) return [];
  const tag = node.tagName.toLowerCase();
  if (tag === "br") return [{ ...style, text: "\n" }];
  if (tag === "img") {
    const alt = node.getAttribute("alt") ?? "";
    return alt === "" ? [] : [{ ...style, text: alt }];
  }
  let next = style;
  if (tag === "strong" || tag === "b") next = { ...next, bold: true };
  if (tag === "em" || tag === "i") next = { ...next, italic: true };
  if (tag === "code" || tag === "kbd") next = { ...next, code: true };
  if (tag === "a") {
    const href = node.getAttribute("href");
    if (href !== null && !href.startsWith("#")) {
      next = { ...next, href: new URL(href, location.href).href };
    }
  }
  return [...node.childNodes].flatMap((child) => inlineRuns(child, next));
}

function trimRuns(runs: readonly Run[]): Run[] {
  const result = runs.map((run) => ({ ...run }));
  const first = result[0];
  if (first !== undefined && !first.code) result[0] = { ...first, text: first.text.trimStart() };
  const lastIndex = result.length - 1;
  const last = result[lastIndex];
  if (last !== undefined && !last.code) result[lastIndex] = { ...last, text: last.text.trimEnd() };
  return result.filter((run) => run.text !== "");
}

const monospace = "Courier New";

async function docxBlob(title: string, blocks: readonly Block[]): Promise<Blob> {
  const docx = await import("docx");
  const headingLevels = [
    docx.HeadingLevel.HEADING_1,
    docx.HeadingLevel.HEADING_2,
    docx.HeadingLevel.HEADING_3,
    docx.HeadingLevel.HEADING_4,
    docx.HeadingLevel.HEADING_5,
    docx.HeadingLevel.HEADING_6,
  ];
  const runs = (
    items: readonly Run[],
  ): (InstanceType<typeof docx.TextRun> | InstanceType<typeof docx.ExternalHyperlink>)[] =>
    items.flatMap((run) =>
      run.text.split("\n").map((text, index) => {
        const textRun = new docx.TextRun({
          bold: run.bold,
          ...(index === 0 ? {} : { break: 1 }),
          ...(run.code ? { font: monospace } : {}),
          italics: run.italic,
          ...(run.href === undefined ? {} : { style: "Hyperlink" }),
          text,
        });
        return run.href === undefined
          ? textRun
          : new docx.ExternalHyperlink({ children: [textRun], link: run.href });
      }),
    );
  const ordered = new Set(
    blocks.flatMap((block) => (block.kind === "item" && block.marker !== "•" ? [block.list] : [])),
  );
  const children = blocks.map((block) => {
    switch (block.kind) {
      case "heading":
        return new docx.Paragraph({
          children: runs(block.runs),
          heading: headingLevels[block.level - 1] ?? docx.HeadingLevel.HEADING_6,
        });
      case "paragraph":
        return new docx.Paragraph({
          children: runs(
            block.quote ? block.runs.map((run) => ({ ...run, italic: true })) : block.runs,
          ),
          ...(block.quote ? { indent: { left: 720 } } : {}),
        });
      case "item":
        return new docx.Paragraph({
          children: runs(block.runs),
          ...(ordered.has(block.list)
            ? { numbering: { instance: block.list, level: block.depth, reference: "ordered" } }
            : { bullet: { level: block.depth } }),
        });
      case "code":
        return new docx.Paragraph({
          children: block.text.split("\n").map(
            (text, index) =>
              new docx.TextRun({
                ...(index === 0 ? {} : { break: 1 }),
                font: monospace,
                size: 19,
                text,
              }),
          ),
          shading: { fill: "F2F2F2", type: docx.ShadingType.CLEAR },
        });
      case "rule":
        return new docx.Paragraph({ thematicBreak: true });
      case "table":
        return new docx.Table({
          rows: block.rows.map(
            (row) =>
              new docx.TableRow({
                children: row.map(
                  (cell) =>
                    new docx.TableCell({
                      children: [new docx.Paragraph({ children: runs(cell) })],
                    }),
                ),
              }),
          ),
          width: { size: 100, type: docx.WidthType.PERCENTAGE },
        });
    }
  });
  const document = new docx.Document({
    numbering: {
      config: [
        {
          levels: Array.from({ length: 9 }, (_, level) => ({
            alignment: docx.AlignmentType.START,
            format: docx.LevelFormat.DECIMAL,
            level,
            style: { paragraph: { indent: { hanging: 360, left: 720 * (level + 1) } } },
            text: `%${level + 1}.`,
          })),
          reference: "ordered",
        },
      ],
    },
    sections: [
      {
        children: [
          new docx.Paragraph({ heading: docx.HeadingLevel.TITLE, text: title }),
          ...children,
        ],
      },
    ],
    title,
  });
  return docx.Packer.toBlob(document);
}

async function pdfBlob(title: string, blocks: readonly Block[]): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ format: "a4", unit: "pt" });
  pdf.setProperties({ title });
  const margin = 56;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const width = pageWidth - margin * 2;
  let y = margin;

  const ensure = (height: number): void => {
    if (y + height <= pageHeight - margin) return;
    pdf.addPage();
    y = margin;
  };
  const font = (run: Run): void => {
    const style =
      run.bold && run.italic ? "bolditalic" : run.bold ? "bold" : run.italic ? "italic" : "normal";
    pdf.setFont(run.code ? "courier" : "helvetica", style);
  };
  /** Lays styled runs out word by word and wraps them within the given width. */
  const flow = (items: readonly Run[], size: number, left: number, available: number): void => {
    const lineHeight = size * 1.4;
    pdf.setFontSize(size);
    let x = left;
    ensure(lineHeight);
    for (const run of items) {
      font(run);
      pdf.setTextColor(run.href === undefined ? "#000000" : "#1a5fb4");
      for (const piece of run.text.split(/(\s+)/u)) {
        if (piece === "") continue;
        if (piece.includes("\n")) {
          x = left;
          y += lineHeight;
          ensure(lineHeight);
          continue;
        }
        const pieceWidth = pdf.getTextWidth(piece);
        if (/^\s+$/u.test(piece)) {
          if (x > left) x += pieceWidth;
          continue;
        }
        if (x > left && x + pieceWidth > left + available) {
          x = left;
          y += lineHeight;
          ensure(lineHeight);
        }
        pdf.text(piece, x, y + size);
        if (run.href !== undefined) pdf.link(x, y, pieceWidth, size * 1.2, { url: run.href });
        x += pieceWidth;
      }
    }
    pdf.setTextColor("#000000");
    y += lineHeight;
  };

  flow([{ ...plain, bold: true, text: title }], 22, margin, width);
  y += 12;
  for (const block of blocks) {
    switch (block.kind) {
      case "heading": {
        const size = [18, 15, 13, 12, 11, 11][block.level - 1] ?? 11;
        y += size * 0.6;
        ensure(size * 3);
        flow(
          block.runs.map((run) => ({ ...run, bold: true })),
          size,
          margin,
          width,
        );
        y += 4;
        break;
      }
      case "paragraph": {
        const indent = block.quote ? 18 : 0;
        flow(
          block.quote ? block.runs.map((run) => ({ ...run, italic: true })) : block.runs,
          11,
          margin + indent,
          width - indent,
        );
        y += 6;
        break;
      }
      case "item": {
        const left = margin + 18 * (block.depth + 1);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(11);
        ensure(11 * 1.4);
        pdf.text(block.marker, left - pdf.getTextWidth(`${block.marker} `), y + 11);
        flow(block.runs, 11, left, width - (left - margin));
        y += 2;
        break;
      }
      case "code": {
        pdf.setFont("courier", "normal");
        pdf.setFontSize(9);
        const lines = block.text
          .split("\n")
          .flatMap((line) => pdf.splitTextToSize(line === "" ? " " : line, width - 12) as string[]);
        for (const line of lines) {
          ensure(13);
          pdf.setFillColor("#f2f2f2");
          pdf.rect(margin, y, width, 13, "F");
          pdf.text(line, margin + 6, y + 9.5);
          y += 13;
        }
        y += 8;
        break;
      }
      case "rule":
        ensure(12);
        pdf.setDrawColor("#999999");
        pdf.line(margin, y + 6, margin + width, y + 6);
        y += 12;
        break;
      case "table": {
        const columns = Math.max(...block.rows.map((row) => row.length), 1);
        const cellWidth = width / columns;
        pdf.setFontSize(10);
        pdf.setDrawColor("#999999");
        for (const row of block.rows) {
          const cells = row.map((cell) => {
            font(cell[0] ?? plain);
            return pdf.splitTextToSize(
              cell.map((run) => run.text).join(""),
              cellWidth - 8,
            ) as string[];
          });
          const height = Math.max(...cells.map((lines) => lines.length), 1) * 14 + 6;
          ensure(height);
          cells.forEach((lines, column) => {
            const x = margin + column * cellWidth;
            font(row[column]?.[0] ?? plain);
            pdf.rect(x, y, cellWidth, height);
            pdf.text(lines, x + 4, y + 13, { lineHeightFactor: 1.4 });
          });
          y += height;
        }
        y += 8;
        break;
      }
    }
  }
  return pdf.output("blob");
}
