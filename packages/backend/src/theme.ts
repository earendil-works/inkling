import { Data, Effect, Schema } from "effect";

const CssNumber = Schema.Number.pipe(Schema.nonNegative());
const OklchColor = Schema.String.pipe(
  Schema.pattern(
    /^oklch\(\s*(?:(?:\d+(?:\.\d+)?|\.\d+)%|(?:\d+(?:\.\d+)?|\.\d+))\s+(?:\d+(?:\.\d+)?|\.\d+)\s+-?(?:\d+(?:\.\d+)?|\.\d+)(?:deg)?(?:\s*\/\s*(?:(?:\d+(?:\.\d+)?|\.\d+)%|(?:\d+(?:\.\d+)?|\.\d+)))?\s*\)$/u,
  ),
);
const FontFamily = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(500),
  Schema.pattern(/^[\p{Letter}\p{Number}\s"'._,-]+$/u),
);
const FontImport = Schema.String.pipe(
  Schema.maxLength(2_000),
  Schema.pattern(/^https:\/\/[^\s\\"'(){}]+$/u),
);

const StateColorSchema = Schema.Struct({
  background: OklchColor,
  border: OklchColor,
  text: OklchColor,
});

const VisibilityColorSchema = Schema.Struct({
  background: OklchColor,
  border: OklchColor,
  hover: OklchColor,
  text: OklchColor,
});

const SyntaxColorSchema = Schema.Struct({
  addition: OklchColor,
  attribute: OklchColor,
  background: OklchColor,
  comment: OklchColor,
  deletion: OklchColor,
  invalid: OklchColor,
  keyword: OklchColor,
  string: OklchColor,
  symbol: OklchColor,
  text: OklchColor,
  title: OklchColor,
});

const MermaidColorSchema = Schema.Struct({
  background: OklchColor,
  line: OklchColor,
  note: OklchColor,
  noteText: OklchColor,
  primary: OklchColor,
  primaryBorder: OklchColor,
  primaryText: OklchColor,
  secondary: OklchColor,
  tertiary: OklchColor,
});

const ThemeModeSchema = Schema.Struct({
  accent: OklchColor,
  accentContrast: OklchColor,
  accentSoft: OklchColor,
  border: OklchColor,
  borderStrong: OklchColor,
  danger: OklchColor,
  editorActiveLine: OklchColor,
  editorBackground: OklchColor,
  focusRing: OklchColor,
  mermaid: MermaidColorSchema,
  muted: OklchColor,
  page: OklchColor,
  participantText: OklchColor,
  presence: Schema.Struct({
    chroma: CssNumber,
    hueOffset: Schema.Number,
    lightness: CssNumber,
  }),
  publicPage: OklchColor,
  scrim: OklchColor,
  scrimSoft: OklchColor,
  shadow: OklchColor,
  shadowSoft: OklchColor,
  shadowStrong: OklchColor,
  states: Schema.Struct({
    abandoned: StateColorSchema,
    accepted: StateColorSchema,
    discussion: StateColorSchema,
    draft: StateColorSchema,
    implemented: StateColorSchema,
    published: StateColorSchema,
  }),
  surface: OklchColor,
  surfaceMuted: OklchColor,
  syntax: SyntaxColorSchema,
  text: OklchColor,
  transparent: OklchColor,
  visibility: Schema.Struct({
    confidential: VisibilityColorSchema,
    private: VisibilityColorSchema,
    public: VisibilityColorSchema,
  }),
});

export const ThemeConfigurationSchema = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  dark: ThemeModeSchema,
  fonts: Schema.Struct({
    code: FontFamily,
    heading: FontFamily,
    imports: Schema.Array(FontImport).pipe(Schema.maxItems(8)),
    prose: FontFamily,
    ui: FontFamily,
  }),
  light: ThemeModeSchema,
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  schemaVersion: Schema.Literal(1),
});

export type ThemeConfiguration = typeof ThemeConfigurationSchema.Type;
export type ThemeMode = typeof ThemeModeSchema.Type;

export class ThemeError extends Data.TaggedError("ThemeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const inklingTheme: ThemeConfiguration = {
  schemaVersion: 1,
  name: "inkling",
  fonts: {
    imports: [
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400..800;1,400..800&family=Newsreader:ital,opsz,wght@0,6..72,400..800;1,6..72,400..800&display=swap",
    ],
    prose: '"Newsreader", Georgia, "Times New Roman", serif',
    heading: '"Newsreader", Georgia, "Times New Roman", serif',
    ui: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
    code: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  },
  light: {
    page: "oklch(98.20% 0.0041 91.45)",
    publicPage: "oklch(96.13% 0.0070 88.64)",
    surface: "oklch(99.67% 0.0054 95.10)",
    surfaceMuted: "oklch(95.48% 0.0054 95.10)",
    editorBackground: "oklch(96.95% 0.0045 91.50)",
    editorActiveLine: "oklch(94.70% 0.0055 91.50)",
    text: "oklch(32.50% 0.0054 91.55)",
    transparent: "oklch(0% 0 0 / 0%)",
    muted: "oklch(54.97% 0.0085 80.71)",
    border: "oklch(87.37% 0.0088 84.58)",
    borderStrong: "oklch(78.38% 0.0108 81.79)",
    accent: "oklch(32.50% 0.0054 91.55)",
    accentContrast: "oklch(98.20% 0.0041 91.45)",
    accentSoft: "oklch(92.48% 0.0083 91.49)",
    focusRing: "oklch(57.01% 0.0774 55.02)",
    danger: "oklch(51.04% 0.1316 30.47)",
    shadow: "oklch(32.50% 0.0054 91.55 / 14%)",
    shadowSoft: "oklch(0% 0 0 / 8%)",
    shadowStrong: "oklch(0% 0 0 / 18%)",
    scrim: "oklch(14.89% 0.0080 164.48 / 42%)",
    scrimSoft: "oklch(17.46% 0.0112 163.33 / 18%)",
    participantText: "oklch(18% 0.02 260)",
    presence: { chroma: 0.16, hueOffset: 0, lightness: 68 },
    states: {
      draft: {
        background: "oklch(92.94% 0.0132 82.40)",
        border: "oklch(85.85% 0.0232 78.20)",
        text: "oklch(51.53% 0.0204 72.87)",
      },
      discussion: {
        background: "oklch(92.28% 0.0267 125.63)",
        border: "oklch(85.48% 0.0442 125.88)",
        text: "oklch(47.85% 0.0628 133.30)",
      },
      published: {
        background: "oklch(92.26% 0.0180 245.40)",
        border: "oklch(85.93% 0.0300 248.18)",
        text: "oklch(46.98% 0.0585 246.66)",
      },
      accepted: {
        background: "oklch(91.93% 0.0216 158.57)",
        border: "oklch(84.13% 0.0339 156.42)",
        text: "oklch(47.05% 0.0595 154.64)",
      },
      implemented: {
        background: "oklch(53.83% 0.0467 148.02)",
        border: "oklch(47.95% 0.0456 150.22)",
        text: "oklch(95.99% 0.0147 132.47)",
      },
      abandoned: {
        background: "oklch(90.79% 0.0231 41.40)",
        border: "oklch(83.69% 0.0370 39.30)",
        text: "oklch(48.46% 0.0884 28.22)",
      },
    },
    visibility: {
      public: {
        background: "oklch(97.53% 0.0058 153.78)",
        hover: "oklch(96.05% 0.0099 155.10)",
        border: "oklch(85.98% 0.0246 155.08)",
        text: "oklch(49.74% 0.0363 156.26)",
      },
      private: {
        background: "oklch(97.57% 0.0136 92.98)",
        hover: "oklch(95.80% 0.0205 91.58)",
        border: "oklch(86.32% 0.0506 93.42)",
        text: "oklch(52.58% 0.0445 91.28)",
      },
      confidential: {
        background: "oklch(96.71% 0.0087 26.02)",
        hover: "oklch(94.67% 0.0144 28.02)",
        border: "oklch(83.95% 0.0327 29.79)",
        text: "oklch(49.30% 0.0415 33.46)",
      },
    },
    syntax: {
      background: "oklch(95.48% 0.0054 95.10)",
      text: "oklch(32.50% 0.0054 91.55)",
      comment: "oklch(55.75% 0.0091 73.68)",
      keyword: "oklch(50.81% 0.1317 6.62)",
      title: "oklch(51.09% 0.1208 292.20)",
      attribute: "oklch(50.01% 0.0887 226.40)",
      string: "oklch(48.76% 0.1012 153.62)",
      symbol: "oklch(54.04% 0.1165 50.79)",
      addition: "oklch(94.55% 0.0281 155.29)",
      deletion: "oklch(92.10% 0.0291 25.56)",
      invalid: "oklch(54.78% 0.1502 31.38)",
    },
    mermaid: {
      background: "oklch(100% 0 0)",
      primary: "oklch(95.48% 0.0054 95.10)",
      primaryText: "oklch(32.50% 0.0054 91.55)",
      primaryBorder: "oklch(78.38% 0.0108 81.79)",
      line: "oklch(54.97% 0.0085 80.71)",
      secondary: "oklch(92.26% 0.0180 245.40)",
      tertiary: "oklch(92.28% 0.0267 125.63)",
      note: "oklch(97.57% 0.0136 92.98)",
      noteText: "oklch(32.50% 0.0054 91.55)",
    },
  },
  dark: {
    page: "oklch(29.75% 0.0038 84.58)",
    publicPage: "oklch(29.75% 0.0038 84.58)",
    surface: "oklch(32.10% 0.0054 91.55)",
    surfaceMuted: "oklch(34.45% 0.0053 91.54)",
    editorBackground: "oklch(32.45% 0.0050 90)",
    editorActiveLine: "oklch(35.20% 0.0055 90)",
    text: "oklch(97.61% 0.0041 91.45)",
    transparent: "oklch(0% 0 0 / 0%)",
    muted: "oklch(72.91% 0.0092 84.58)",
    border: "oklch(40.22% 0.0071 84.59)",
    borderStrong: "oklch(50.05% 0.0101 84.59)",
    accent: "oklch(97.61% 0.0041 91.45)",
    accentContrast: "oklch(29.75% 0.0038 84.58)",
    accentSoft: "oklch(37.97% 0.0072 84.59)",
    focusRing: "oklch(75.08% 0.0796 57.86)",
    danger: "oklch(71.93% 0.1404 31.44)",
    shadow: "oklch(0% 0 0 / 32%)",
    shadowSoft: "oklch(0% 0 0 / 18%)",
    shadowStrong: "oklch(0% 0 0 / 36%)",
    scrim: "oklch(0% 0 0 / 55%)",
    scrimSoft: "oklch(0% 0 0 / 28%)",
    participantText: "oklch(18% 0.02 260)",
    presence: { chroma: 0.14, hueOffset: 0, lightness: 76 },
    states: {
      draft: {
        background: "oklch(26.56% 0.0117 84.58)",
        border: "oklch(37.33% 0.0179 84.57)",
        text: "oklch(80.30% 0.0253 77.42)",
      },
      discussion: {
        background: "oklch(28.91% 0.0352 147.60)",
        border: "oklch(43.64% 0.0588 142.90)",
        text: "oklch(84.27% 0.0697 134.06)",
      },
      published: {
        background: "oklch(27.80% 0.0293 245.00)",
        border: "oklch(42.31% 0.0526 251.08)",
        text: "oklch(85.84% 0.0464 247.36)",
      },
      accepted: {
        background: "oklch(28.86% 0.0332 155.96)",
        border: "oklch(45.40% 0.0584 153.28)",
        text: "oklch(86.32% 0.0547 152.51)",
      },
      implemented: {
        background: "oklch(42.94% 0.0746 149.70)",
        border: "oklch(55.56% 0.0905 149.58)",
        text: "oklch(96.94% 0.0173 140.02)",
      },
      abandoned: {
        background: "oklch(26.67% 0.0329 16.39)",
        border: "oklch(41.48% 0.0563 19.74)",
        text: "oklch(83.33% 0.0631 23.39)",
      },
    },
    visibility: {
      public: {
        background: "oklch(34.65% 0.0085 159.66)",
        hover: "oklch(37.00% 0.0135 158.26)",
        border: "oklch(50.15% 0.0241 156.25)",
        text: "oklch(86.06% 0.0238 153.40)",
      },
      private: {
        background: "oklch(34.07% 0.0106 91.65)",
        hover: "oklch(36.04% 0.0140 89.87)",
        border: "oklch(51.35% 0.0370 93.74)",
        text: "oklch(86.99% 0.0428 92.23)",
      },
      confidential: {
        background: "oklch(33.10% 0.0087 28.94)",
        hover: "oklch(35.37% 0.0128 25.33)",
        border: "oklch(49.80% 0.0283 30.66)",
        text: "oklch(84.77% 0.0266 29.44)",
      },
    },
    syntax: {
      background: "oklch(25.65% 0.0040 84.58)",
      text: "oklch(95.53% 0.0070 88.64)",
      comment: "oklch(68.04% 0.0094 84.58)",
      keyword: "oklch(76.95% 0.1398 10.38)",
      title: "oklch(81.47% 0.1026 293.42)",
      attribute: "oklch(81.71% 0.0865 230.56)",
      string: "oklch(82.48% 0.0826 154.59)",
      symbol: "oklch(79.74% 0.1082 62.09)",
      addition: "oklch(32.32% 0.0557 155.24)",
      deletion: "oklch(31.48% 0.0609 24.10)",
      invalid: "oklch(71.93% 0.1404 31.44)",
    },
    mermaid: {
      background: "oklch(25.65% 0.0040 84.58)",
      primary: "oklch(34.45% 0.0053 91.54)",
      primaryText: "oklch(97.61% 0.0041 91.45)",
      primaryBorder: "oklch(50.05% 0.0101 84.59)",
      line: "oklch(72.91% 0.0092 84.58)",
      secondary: "oklch(27.80% 0.0293 245.00)",
      tertiary: "oklch(28.91% 0.0352 147.60)",
      note: "oklch(34.07% 0.0106 91.65)",
      noteText: "oklch(97.61% 0.0041 91.45)",
    },
  },
};

export const paperTheme: ThemeConfiguration = {
  ...inklingTheme,
  name: "paper",
  fonts: {
    imports: [
      "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,600;1,400&family=Literata:ital,opsz,wght@0,7..72,400..700;1,7..72,400..700&display=swap",
    ],
    prose: '"Literata", Georgia, "Times New Roman", serif',
    heading: '"Literata", Georgia, "Times New Roman", serif',
    ui: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
    code: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
  },
  light: {
    ...inklingTheme.light,
    page: "oklch(94.80% 0.028 84)",
    publicPage: "oklch(92.80% 0.033 78)",
    surface: "oklch(97.10% 0.022 88)",
    surfaceMuted: "oklch(91.80% 0.031 82)",
    editorBackground: "oklch(95.60% 0.021 87)",
    editorActiveLine: "oklch(92.70% 0.029 84)",
    text: "oklch(30% 0.035 54)",
    muted: "oklch(51% 0.033 62)",
    border: "oklch(81% 0.045 76)",
    borderStrong: "oklch(70% 0.055 68)",
    accent: "oklch(48% 0.125 45)",
    accentContrast: "oklch(97% 0.018 87)",
    accentSoft: "oklch(88% 0.055 60)",
    focusRing: "oklch(60% 0.145 48)",
    danger: "oklch(50% 0.15 28)",
    shadow: "oklch(25% 0.035 50 / 18%)",
    shadowSoft: "oklch(20% 0.025 50 / 10%)",
    shadowStrong: "oklch(20% 0.025 50 / 24%)",
    scrim: "oklch(17% 0.03 50 / 48%)",
    scrimSoft: "oklch(17% 0.03 50 / 22%)",
    participantText: "oklch(20% 0.03 55)",
    presence: { chroma: 0.13, hueOffset: 24, lightness: 66 },
    states: {
      draft: {
        background: "oklch(91% 0.035 82)",
        border: "oklch(80% 0.05 76)",
        text: "oklch(49% 0.055 68)",
      },
      discussion: {
        background: "oklch(90% 0.045 112)",
        border: "oklch(78% 0.065 112)",
        text: "oklch(45% 0.075 122)",
      },
      published: {
        background: "oklch(90% 0.035 242)",
        border: "oklch(78% 0.055 242)",
        text: "oklch(43% 0.075 245)",
      },
      accepted: {
        background: "oklch(89% 0.04 151)",
        border: "oklch(77% 0.065 151)",
        text: "oklch(43% 0.075 151)",
      },
      implemented: {
        background: "oklch(47% 0.07 145)",
        border: "oklch(40% 0.065 145)",
        text: "oklch(95% 0.025 90)",
      },
      abandoned: {
        background: "oklch(88% 0.045 35)",
        border: "oklch(75% 0.075 35)",
        text: "oklch(45% 0.11 30)",
      },
    },
    visibility: {
      public: {
        background: "oklch(93% 0.03 145)",
        hover: "oklch(90% 0.04 145)",
        border: "oklch(78% 0.06 145)",
        text: "oklch(43% 0.07 145)",
      },
      private: {
        background: "oklch(92% 0.045 85)",
        hover: "oklch(89% 0.055 82)",
        border: "oklch(78% 0.075 80)",
        text: "oklch(46% 0.07 70)",
      },
      confidential: {
        background: "oklch(91% 0.035 30)",
        hover: "oklch(88% 0.05 30)",
        border: "oklch(75% 0.075 30)",
        text: "oklch(44% 0.095 28)",
      },
    },
    syntax: {
      background: "oklch(92.80% 0.028 84)",
      text: "oklch(30% 0.035 54)",
      comment: "oklch(54% 0.04 67)",
      keyword: "oklch(47% 0.14 27)",
      title: "oklch(45% 0.10 300)",
      attribute: "oklch(45% 0.09 235)",
      string: "oklch(43% 0.10 145)",
      symbol: "oklch(50% 0.12 70)",
      addition: "oklch(88% 0.055 145)",
      deletion: "oklch(87% 0.055 28)",
      invalid: "oklch(50% 0.15 28)",
    },
    mermaid: {
      background: "oklch(97.10% 0.022 88)",
      primary: "oklch(91.80% 0.031 82)",
      primaryText: "oklch(30% 0.035 54)",
      primaryBorder: "oklch(70% 0.055 68)",
      line: "oklch(51% 0.033 62)",
      secondary: "oklch(88% 0.055 60)",
      tertiary: "oklch(90% 0.045 112)",
      note: "oklch(92% 0.045 85)",
      noteText: "oklch(30% 0.035 54)",
    },
  },
  dark: {
    ...inklingTheme.dark,
    page: "oklch(22.50% 0.025 52)",
    publicPage: "oklch(21% 0.026 52)",
    surface: "oklch(26% 0.028 56)",
    surfaceMuted: "oklch(30% 0.03 58)",
    editorBackground: "oklch(24.80% 0.026 54)",
    editorActiveLine: "oklch(29% 0.031 58)",
    text: "oklch(91% 0.025 82)",
    muted: "oklch(70% 0.035 72)",
    border: "oklch(38% 0.04 61)",
    borderStrong: "oklch(48% 0.05 64)",
    accent: "oklch(73% 0.13 55)",
    accentContrast: "oklch(23% 0.026 52)",
    accentSoft: "oklch(34% 0.065 49)",
    focusRing: "oklch(78% 0.12 70)",
    danger: "oklch(72% 0.15 28)",
    shadow: "oklch(10% 0.02 48 / 42%)",
    shadowSoft: "oklch(10% 0.02 48 / 24%)",
    shadowStrong: "oklch(8% 0.02 48 / 50%)",
    scrim: "oklch(8% 0.02 48 / 62%)",
    scrimSoft: "oklch(8% 0.02 48 / 34%)",
    participantText: "oklch(18% 0.03 55)",
    presence: { chroma: 0.12, hueOffset: 24, lightness: 74 },
    visibility: {
      public: {
        background: "oklch(30% 0.035 145)",
        hover: "oklch(34% 0.045 145)",
        border: "oklch(47% 0.065 145)",
        text: "oklch(82% 0.06 145)",
      },
      private: {
        background: "oklch(31% 0.04 78)",
        hover: "oklch(35% 0.05 76)",
        border: "oklch(49% 0.07 74)",
        text: "oklch(84% 0.07 82)",
      },
      confidential: {
        background: "oklch(29% 0.04 28)",
        hover: "oklch(33% 0.05 28)",
        border: "oklch(47% 0.07 28)",
        text: "oklch(82% 0.07 30)",
      },
    },
    syntax: {
      background: "oklch(23.50% 0.025 52)",
      text: "oklch(90% 0.025 82)",
      comment: "oklch(65% 0.04 70)",
      keyword: "oklch(79% 0.14 35)",
      title: "oklch(82% 0.10 305)",
      attribute: "oklch(79% 0.09 235)",
      string: "oklch(79% 0.10 145)",
      symbol: "oklch(83% 0.13 75)",
      addition: "oklch(30% 0.065 145)",
      deletion: "oklch(30% 0.075 28)",
      invalid: "oklch(72% 0.15 28)",
    },
    mermaid: {
      background: "oklch(23.50% 0.025 52)",
      primary: "oklch(30% 0.03 58)",
      primaryText: "oklch(91% 0.025 82)",
      primaryBorder: "oklch(48% 0.05 64)",
      line: "oklch(70% 0.035 72)",
      secondary: "oklch(34% 0.065 49)",
      tertiary: "oklch(30% 0.05 112)",
      note: "oklch(31% 0.04 78)",
      noteText: "oklch(91% 0.025 82)",
    },
  },
};

export const defaultTheme = inklingTheme;

export const bundledThemes = {
  inkling: inklingTheme,
  paper: paperTheme,
} as const satisfies Readonly<Record<string, ThemeConfiguration>>;

export function findBundledTheme(selection: string | undefined): ThemeConfiguration | undefined {
  const name = selection?.trim().toLowerCase();
  if (name === undefined || name === "" || name === "default") return inklingTheme;
  return bundledThemes[name as keyof typeof bundledThemes];
}

export function decodeThemeJson(source: string): Effect.Effect<ThemeConfiguration, ThemeError> {
  return Effect.try({
    catch: (cause) => new ThemeError({ cause, message: "Theme JSON is not valid JSON." }),
    try: () => JSON.parse(source) as unknown,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ThemeConfigurationSchema)),
    Effect.mapError(
      (cause) =>
        new ThemeError({
          cause,
          message: cause instanceof ThemeError ? cause.message : "Theme JSON is invalid.",
        }),
    ),
  );
}

export function themeStylesheet(theme: ThemeConfiguration): string {
  const imports = theme.fonts.imports.map((url) => `@import url("${url}");`).join("\n");
  const fonts = [
    `  --serif: ${theme.fonts.prose};`,
    `  --heading: ${theme.fonts.heading};`,
    `  --sans: ${theme.fonts.ui};`,
    `  --mono: ${theme.fonts.code};`,
  ].join("\n");
  const light = modeVariables(theme.light);
  const dark = modeVariables(theme.dark);
  return `${imports}${imports === "" ? "" : "\n\n"}:root {\n  color-scheme: light;\n${fonts}\n${light}\n}\n\n:root[data-theme="dark"] {\n  color-scheme: dark;\n${dark}\n}\n\n@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n    color-scheme: dark;\n${dark}\n  }\n}\n`;
}

export function themeCssResponse(theme: ThemeConfiguration): Response {
  return new Response(themeStylesheet(theme), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "text/css; charset=UTF-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function modeVariables(mode: ThemeMode): string {
  const values: Readonly<Record<string, string | number>> = {
    "--page": mode.page,
    "--surface": mode.surface,
    "--surface-muted": mode.surfaceMuted,
    "--editor-background": mode.editorBackground,
    "--editor-active-line-background": mode.editorActiveLine,
    "--text": mode.text,
    "--transparent": mode.transparent,
    "--muted": mode.muted,
    "--border": mode.border,
    "--border-strong": mode.borderStrong,
    "--accent": mode.accent,
    "--accent-contrast": mode.accentContrast,
    "--accent-soft": mode.accentSoft,
    "--focus-ring": mode.focusRing,
    "--danger": mode.danger,
    "--shadow-color": mode.shadow,
    "--shadow-soft": mode.shadowSoft,
    "--shadow-strong": mode.shadowStrong,
    "--scrim": mode.scrim,
    "--scrim-soft": mode.scrimSoft,
    "--participant-text": mode.participantText,
    "--presence-lightness": mode.presence.lightness,
    "--presence-chroma": mode.presence.chroma,
    "--presence-hue-offset": mode.presence.hueOffset,
    "--state-draft-bg": mode.states.draft.background,
    "--state-draft-border": mode.states.draft.border,
    "--state-draft-text": mode.states.draft.text,
    "--state-discussion-bg": mode.states.discussion.background,
    "--state-discussion-border": mode.states.discussion.border,
    "--state-discussion-text": mode.states.discussion.text,
    "--state-published-bg": mode.states.published.background,
    "--state-published-border": mode.states.published.border,
    "--state-published-text": mode.states.published.text,
    "--state-accepted-bg": mode.states.accepted.background,
    "--state-accepted-border": mode.states.accepted.border,
    "--state-accepted-text": mode.states.accepted.text,
    "--state-implemented-bg": mode.states.implemented.background,
    "--state-implemented-border": mode.states.implemented.border,
    "--state-implemented-text": mode.states.implemented.text,
    "--state-abandoned-bg": mode.states.abandoned.background,
    "--state-abandoned-border": mode.states.abandoned.border,
    "--state-abandoned-text": mode.states.abandoned.text,
    "--visibility-public-bg": mode.visibility.public.background,
    "--visibility-public-hover": mode.visibility.public.hover,
    "--visibility-public-border": mode.visibility.public.border,
    "--visibility-public-text": mode.visibility.public.text,
    "--visibility-private-bg": mode.visibility.private.background,
    "--visibility-private-hover": mode.visibility.private.hover,
    "--visibility-private-border": mode.visibility.private.border,
    "--visibility-private-text": mode.visibility.private.text,
    "--visibility-confidential-bg": mode.visibility.confidential.background,
    "--visibility-confidential-hover": mode.visibility.confidential.hover,
    "--visibility-confidential-border": mode.visibility.confidential.border,
    "--visibility-confidential-text": mode.visibility.confidential.text,
    "--code-background": mode.syntax.background,
    "--code-text": mode.syntax.text,
    "--code-comment": mode.syntax.comment,
    "--code-keyword": mode.syntax.keyword,
    "--code-title": mode.syntax.title,
    "--code-attribute": mode.syntax.attribute,
    "--code-string": mode.syntax.string,
    "--code-symbol": mode.syntax.symbol,
    "--code-addition": mode.syntax.addition,
    "--code-deletion": mode.syntax.deletion,
    "--code-invalid": mode.syntax.invalid,
    "--mermaid-background": mode.mermaid.background,
    "--mermaid-primary": mode.mermaid.primary,
    "--mermaid-primary-text": mode.mermaid.primaryText,
    "--mermaid-primary-border": mode.mermaid.primaryBorder,
    "--mermaid-line": mode.mermaid.line,
    "--mermaid-secondary": mode.mermaid.secondary,
    "--mermaid-tertiary": mode.mermaid.tertiary,
    "--mermaid-note": mode.mermaid.note,
    "--mermaid-note-text": mode.mermaid.noteText,
    "--public-page": mode.publicPage,
    "--public-paper": mode.surface,
    "--public-muted-surface": mode.surfaceMuted,
    "--public-text": mode.text,
    "--public-muted": mode.muted,
    "--public-border": mode.border,
    "--public-border-strong": mode.borderStrong,
  };
  return Object.entries(values)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
}
