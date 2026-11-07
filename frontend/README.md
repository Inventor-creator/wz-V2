# MyApp Frontend

A React 19 + TypeScript + Vite + Tailwind CSS frontend scaffold.

This is a **skeleton**: auth, routing, theming, layout, and the API client are
wired up, while all domain views have been gutted to placeholder stubs that you
fill in.

## Stack

- **React 19** + **TypeScript**
- **Vite 8** (with React Compiler + Tailwind CSS v4)
- **React Router 7**
- **Axios** (with a configured API client)
- **Recharts** (available for charts)

## What is already working

| Area | File | Status |
|------|------|--------|
| Build / dev / lint config | `vite.config.ts`, `tsconfig*`, `eslint.config.js` | Ready |
| Theme (light/dark) | `contexts/ThemeContext.tsx`, `components/ThemeToggle.tsx` | Ready |
| API client | `api.ts` | Ready |
| Multi-entity scoping (X-Gym-Id header) | `contexts/ActiveEntityContext.tsx` | Ready |
| Auth guard | `components/ProtectedRoute.tsx` | Ready |
| Routing + shell | `App.tsx`, `pages/*`, `components/Sidebar.tsx` | Ready |
| Responsive shell | `Dashboard.tsx` + `components/mobile/*` | Ready |

## What you need to implement

- **`components/*View.tsx`** and **`components/mobile/*`** — replace the
  placeholder `TODO` views with your real feature UI
- **`pages/AdminDashboard.tsx`** and **`pages/SelectGym.tsx`** — fill in the
  admin and selection logic

## Setup

```bash
npm install
cp .env.example .env        # optional - override VITE_API_URL
npm run dev
```

The app will be available at `http://localhost:5173`.

## Scripts

| Command           | Description                     |
|-------------------|----------------------------------|
| `npm run dev`     | Start the Vite dev server        |
| `npm run build`   | Type-check and build for production |
| `npm run lint`    | Run ESLint                       |
| `npm run preview` | Preview the production build     |

## Project Structure

```
frontend/
├── src/
│   ├── api.ts               # Axios instance (base URL, credentials)
│   ├── App.tsx              # Route definitions
│   ├── contexts/            # ThemeContext, ActiveEntityContext (X-* header)
│   ├── hooks/               # useMediaQuery
│   ├── pages/               # LoginPage, LoginError, Select, Dashboard, Admin
│   └── components/          # Sidebar, ProtectedRoute, ThemeToggle, *View stubs
│       └── mobile/          # Mobile-specific shell + view stubs
└── vite.config.ts
```

## Conventions

- The backend scopes most endpoints by an `X-Gym-Id` request header. The
  `ActiveEntityContext` sets that header whenever an entity is selected. Adjust
  the header name in `ActiveEntityContext.tsx` if your backend uses a different
  one.
- Type-only imports must use `import type { ... }` (`verbatimModuleSyntax`).
- Unused locals/parameters fail the build, so keep stubs clean as you develop.