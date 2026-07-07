# Allowed dependencies (the ui-react toolkit superset)

The components under `src/components/ui/` are the **canonical shadcn/ui set**
(generated with `shadcn@4 add`, `radix` base, `neutral` base color — the shadcn
default). These are the ONLY packages the build image ships. Import from this
list — anything else fails the build (the container has no network and never runs
`install`). To add a dependency: add it to `builder/base/package.json`, bump
`builder/base/toolkit.version`, and rebuild the base image (`builder/build-base.sh`).

## Runtime
| Package | Use |
|---|---|
| `react`, `react-dom` | React 19 |
| `react-router-dom` | routing — use **`HashRouter`** (static preview, no server) |
| `radix-ui` | primitives behind most `components/ui/*` |
| `@base-ui/react` | primitive behind `combobox` |
| `lucide-react` | icons (import named glyphs; **never** emoji) |
| `class-variance-authority`, `clsx`, `tailwind-merge` | variants + `cn` |
| `tw-animate-css` | animation utilities (imported in `index.css`) |
| `shadcn` | provides `shadcn/tailwind.css` (imported in `index.css`) |
| `@fontsource-variable/geist` | default font (imported in `index.css`) |
| `cmdk` | `command` |
| `embla-carousel-react` | `carousel` |
| `input-otp` | `input-otp` |
| `vaul` | `drawer` |
| `sonner`, `next-themes` | `sonner` toaster |
| `react-hook-form`, `@hookform/resolvers`, `zod` | `form` + validation |
| `react-day-picker`, `date-fns` | `calendar` + dates |
| `react-resizable-panels` | `resizable` |
| `recharts` | `chart` |

## Build-time (do not import in app code)
`vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`,
`vite-plugin-singlefile`, `typescript`, `@types/react`, `@types/react-dom`.

## Conventions
- Import UI primitives from `@/components/ui/<name>` (the shadcn set), not from the
  raw `radix-ui` / `@base-ui/react` packages.
- `cn` from `@/lib/utils`.
- Style with Tailwind classes that map to theme tokens (`bg-primary`,
  `text-muted-foreground`, `border-border`, …); theme values live in
  `src/index.css` `:root` / `.dark` (default = shadcn **neutral**).
