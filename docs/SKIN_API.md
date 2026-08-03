# CodyWeb Skin API v2

CodyWeb skins are declarative, versioned JSON packages saved with the
`.cody-skin` extension. A skin can change semantic design tokens, choose
official component recipes, and carry bounded raster assets. It cannot execute
JavaScript, inject HTML, load remote resources, or access conversation data.

## Package shape

```json
{
  "manifest": {
    "schemaVersion": 2,
    "version": "1.0.0",
    "author": "Example Studio",
    "homepage": "https://example.com/skin",
    "chromeLabel": "2007"
  },
  "id": "example-blue",
  "name": "Example Blue",
  "description": "A compact blue desktop skin.",
  "defaultColorMode": "light",
  "variants": {
    "light": {
      "tokens": {
        "color": {
          "background": "#d9eafa",
          "surface": "#c9e1f7",
          "panel": "#f8fbff",
          "elevated": "#e8f3fd",
          "text": "#173752",
          "textMuted": "#526f88",
          "border": "#77a3ca",
          "accent": "#1677c8",
          "danger": "#c83d36",
          "warning": "#d8790b",
          "success": "#207a4c",
          "info": "#1677c8",
          "codeBackground": "#112b42",
          "terminalBackground": "#10273d"
        },
        "font": { "sans": "Tahoma, Segoe UI, sans-serif", "mono": "Cascadia Code, ui-monospace, monospace" },
        "spacing": { "xs": "0.25rem", "sm": "0.5rem", "md": "0.75rem", "lg": "1rem" },
        "radius": { "sm": "0.2rem", "md": "0.3rem", "lg": "0.45rem" },
        "shadow": { "panel": "0 1px 2px #00000022", "floating": "0 12px 30px #00000033", "focus": "0 0 0 3px #1677c844" },
        "motion": { "fast": "120ms", "normal": "180ms", "slow": "240ms" },
        "density": "compact"
      },
      "syntaxTheme": "light",
      "terminalTheme": { "background": "#10273d", "foreground": "#eaf6ff" },
      "chartPalette": ["#1677c8", "#207a4c", "#d8790b"],
      "background": { "type": "solid" }
    },
    "dark": {
      "tokens": {
        "color": {
          "background": "#0d2234",
          "surface": "#132f46",
          "panel": "#193a55",
          "elevated": "#244c69",
          "text": "#edf8ff",
          "textMuted": "#a8c5d8",
          "border": "#426d8c",
          "accent": "#5eb7ff",
          "danger": "#ff7972",
          "warning": "#ffb44c",
          "success": "#55d58b",
          "info": "#5eb7ff",
          "codeBackground": "#071521",
          "terminalBackground": "#071521"
        },
        "font": { "sans": "Tahoma, Segoe UI, sans-serif", "mono": "Cascadia Code, ui-monospace, monospace" },
        "spacing": { "xs": "0.25rem", "sm": "0.5rem", "md": "0.75rem", "lg": "1rem" },
        "radius": { "sm": "0.2rem", "md": "0.3rem", "lg": "0.45rem" },
        "shadow": { "panel": "0 2px 5px #00000055", "floating": "0 16px 38px #00000077", "focus": "0 0 0 3px #5eb7ff44" },
        "motion": { "fast": "120ms", "normal": "180ms", "slow": "240ms" },
        "density": "compact"
      },
      "syntaxTheme": "dark",
      "terminalTheme": { "background": "#071521", "foreground": "#dff3ff" },
      "chartPalette": ["#5eb7ff", "#55d58b", "#ffb44c"],
      "background": { "type": "solid" }
    }
  },
  "recipes": {
    "chrome": "glossy",
    "navigation": "classic",
    "panel": "beveled",
    "control": "beveled",
    "message": "rail",
    "identity": "avatars",
    "composer": "beveled",
    "backdrop": "aero-grid"
  }
}
```

Recipes and identity assets belong to the skin and remain stable while the
selected `light` or `dark` variant supplies colors, syntax highlighting,
terminal colors, chart colors, and backdrop settings. A package may provide
one or both variants; built-in skins provide both.

Skin API v1 color-only JSON remains importable. CodyWeb migrates it to a
single-mode v2 package and fills all `native` recipe defaults before saving it
again. The unavailable mode stays disabled instead of silently selecting a
different skin.

## Recipe values

| Area | Values |
| --- | --- |
| `chrome` | `native`, `glossy`, `terminal` |
| `navigation` | `native`, `classic`, `pill` |
| `panel` | `native`, `beveled`, `glass` |
| `control` | `native`, `beveled`, `outline` |
| `message` | `native`, `bubble`, `rail` |
| `identity` | `none`, `avatars` |
| `composer` | `native`, `beveled`, `glass` |
| `backdrop` | `solid`, `aero-grid`, `grid`, `image` |

Recipes are implemented by CodyWeb and use semantic tokens. They are the
stable extension point for shapes and materials; imported packages do not
contain arbitrary CSS.

## Optional assets

`assets.background` and `assets.brandMark` accept embedded `data:` URLs for
PNG, JPEG, or WebP only. Each decoded image is limited to 500 KB and the whole
package is limited to 1.5 MB. Remote URLs and SVG are rejected. Supplying a
background asset automatically selects the `image` backdrop recipe.

```json
{
  "assets": {
    "background": "data:image/webp;base64,...",
    "brandMark": "data:image/png;base64,...",
    "assistantAvatar": "data:image/png;base64,...",
    "userAvatar": "data:image/png;base64,..."
  }
}
```

## Stable DOM contract

Skin recipes target stable semantic attributes rather than Vue implementation
classes:

```text
data-cody-region="app-shell"
data-cody-region="sidebar"
data-cody-region="sidebar-content"
data-cody-region="workspace"
data-cody-region="content"
data-cody-region="titlebar"
data-cody-region="contextbar"
data-cody-region="conversation"
data-cody-region="composer"

data-cody-component="panel"
data-cody-component="message"
data-cody-component="composer-surface"
```

The active shell exposes `data-skin-api="2"`, `data-theme-color-mode`, and one
`data-skin-recipe-*` attribute per recipe area. These attributes form the
compatibility contract. Internal class names are not part of the Skin API.

## Import and export

Open **Settings → Appearance**. “Download .cody-skin” exports the active skin;
“Import file” validates, installs, and applies a package. Imported skins can be
removed from the same panel. Built-in IDs are reserved and cannot be replaced
by imported packages.

## Security boundary

Skin API v2 deliberately excludes JavaScript, HTML, arbitrary CSS, remote
fonts, remote images, iframes, and plugins. Behavioral extensions belong in a
separate future Plugin API so installing a visual skin never grants access to
threads, tools, approvals, files, or network capabilities.
