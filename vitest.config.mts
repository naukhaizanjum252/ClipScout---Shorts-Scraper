import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@/...` is how every file in `app/` and `lib/` imports, because that is what
  // Next resolves. Without this plugin a test importing a real module by its `@`
  // path fails to resolve, and the workaround people reach for — a `vi.mock`
  // factory that re-imports the module by relative path — quietly turns a test
  // of production code into a test of a look-alike. Resolve the alias properly
  // and that whole class of mistake disappears.
  plugins: [tsconfigPaths()],

  test: {
    // `.tsx` is included deliberately. The two controls the client actually
    // asked for — approve and unlist — live in a client component, and the rule
    // that Unlist stays disabled until a reason is typed is a BEHAVIOUR. A suite
    // that can only load `.ts` cannot execute it, which is how that rule shipped
    // with no coverage the first time.
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"],

    // Node by default: almost everything under test is pure — duration parsing,
    // the uploads-playlist derivation, the cost table, the quota arithmetic, the
    // ingest state machine against an in-memory store, a static read of the
    // migrations. Nothing stands up a database or hits the network, which is the
    // point: the invariant the client is trusting (unlisted stays unlisted) is
    // proved in milliseconds and without credentials.
    //
    // Component tests opt into jsdom per file with
    //   // @vitest-environment jsdom
    // rather than the whole suite paying for a DOM it does not use.
    environment: "node",
  },
});
