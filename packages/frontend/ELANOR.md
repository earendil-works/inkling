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

Pick an Elanor `main` commit whose Preview packages run succeeded, and replace the commit in all four URLs:

```sh
sha=$(git ls-remote git@github.com:earendil-works/elanor.git refs/heads/main | cut -f1)
sed -i.bak -E "s#(pkg\.earendil\.com/@earendil-works/[a-z-]+@)[0-9a-f]{40}#\1$sha#" package.json && rm package.json.bak
pnpm install
```

Commit `package.json` and `pnpm-lock.yaml` together.

Builds of a commit expire 30 days after upload. Before that, a maintainer can keep one by running Elanor's **Preview
packages** workflow with the commit SHA; it stays available as `main-<first 12 SHA characters>`, and the URLs can use that
label instead. Released versions (`vX.Y.Z`) are kept too, and once Elanor publishes to npm, plain version ranges replace
the URLs.
