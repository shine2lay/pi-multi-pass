# Fork-only code

Feature code for this fork lives here as plain modules, each imported from
`../multi-sub.ts` with a minimal hook (import + call site):

```ts
import { something } from "./mine/<feature>.ts";
```

Rules

- **No `index.ts` in this directory.** pi treats `extensions/*/index.ts` as a separate
  extension entry point. Without one, pi ignores this folder entirely and these files are
  reached only through imports from `multi-sub.ts`.
- One feature per patch, documented in `../../PATCHES.md`. Use a small module family when
  provider parsing, persistence, pure policy, and orchestration need independent contracts.
- Quota routing: `anthropic-quota.ts` parses facts; `quota-state.ts` stores them;
  `account-policy.ts` ranks accounts; `quota-routing.ts` coordinates selection. None owns
  model preference: ordered pools/chains remain the source of truth.
- All logic here; keep the touch on `multi-sub.ts` as small as possible so upstream rebases
  conflict rarely and trivially.
- Import pi packages the same way `multi-sub.ts` does (`@earendil-works/pi-ai`, etc.).
