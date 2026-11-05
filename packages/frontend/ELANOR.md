# Elanor

The frontend builds its UI from the [Elanor](https://github.com/earendil-works/elanor) design system. Its packages come
from npm, and `package.json` pins each one to an exact version:

| Package                              | Contents                                                     |
| ------------------------------------ | ------------------------------------------------------------ |
| `@earendil-works/elanor-react`       | React components (Base UI) and precompiled component CSS     |
| `@earendil-works/elanor-icons-react` | Material Symbols components                                  |
| `@earendil-works/design-tokens`      | Token CSS and catalogues; Inkling uses the `earendil` brand  |
| `@earendil-works/elanor-fonts`       | Mallos Serif and Commit Mono, CSS entry points, and licenses |

They are development dependencies because Vite bundles them; published Inkling packages never depend on them.

## Components and docs

Use Elanor's components and their documented props. The documentation is the `.mdx` file next to each component in
`packages/react/src/` of the Elanor repository at the release tag (`v<version>`) of the pinned version.

## Styles

`src/styles/index.css` declares the cascade layers and imports `@earendil-works/elanor-react/elanor.min.css`. Elanor's
JavaScript does not import component CSS. Inkling's own CSS Modules are unlayered, so they win over Elanor's layered
styles.

## Fonts and tokens

The Vite plugin in `scripts/elanor-assets.ts` serves the font package's CSS, font files, and licenses at
`/fonts/elanor/`, and the `earendil` brand tokens followed by Inkling's domain tokens at `/tokens.css`. It serves them
directly in development and emits them unchanged into the build, so the application shell and the server-rendered public
and OAuth pages share the same URLs. A deployment theme (`/theme.css`) loads after the tokens and overrides them. Tokens
select font families; the font stylesheets only register faces.

## Updating

Dependabot (`.github/dependabot.yml`) checks npm daily and opens one PR that moves all four packages to Elanor's newest
release, updating `package.json` and `pnpm-lock.yaml` together. It ignores major releases, so moving to Elanor 1.0 is a
deliberate change.

Keep the four packages in one update: `elanor-react` depends on an exact `elanor-icons-react` version, and a mismatch
installs two copies of the icons.
