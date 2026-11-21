import {defineConfig} from 'vite';

export default defineConfig(() => {
  const env = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env;
  const disableHmr = env?.DISABLE_HMR === 'true';

  return {
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: !disableHmr,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: disableHmr ? null : {},
    },
  };
});
