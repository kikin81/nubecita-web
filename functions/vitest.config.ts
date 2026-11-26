import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These need the Firestore emulator: `npm run test:emulator`.
    exclude: ["test/emulator/**"],
    environment: "node",
  },
});
