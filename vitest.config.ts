import { defineConfig } from 'vitest/config';

// Unit tests cover pure logic only (no Electron, no DOM), so a plain node
// environment is enough. Scoped to src/ test files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
