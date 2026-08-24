import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: [
        'src/host/engine.ts',
        'src/host/uninstall.ts',
        'src/host/patch-editor.ts',
        'src/host/token-store.ts',
        'src/host/operation-store.ts',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
