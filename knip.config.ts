import type { KnipConfig } from "knip";

/**
 * Knip configuration.
 * @see https://knip.dev/overview/configuration
 */
const knipConfig: KnipConfig = {
  // exported types consumed only within their own module are public API surface,
  // not dead code
  ignoreExportsUsedInFile: true,
};

export default knipConfig;
