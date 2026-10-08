import { defineConfig } from 'vitest/config';

// Pruebas contra la Emulator Suite. Se ejecutan con:
//   npm run test:emulator   (firebase emulators:exec las arranca)
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.emulator.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    fileParallelism: false,
  },
});
