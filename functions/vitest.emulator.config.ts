import {defineConfig} from "vitest/config";

/** Tests that talk to the Firestore emulator. Run through `npm run test:emulator`, which starts it. */
export default defineConfig({
  test: {
    include: ["test/emulator/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
