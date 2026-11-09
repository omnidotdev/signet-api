import type { KnipConfig } from "knip";

/**
 * Knip configuration.
 * @see https://knip.dev/overview/configuration
 */
const knipConfig: KnipConfig = {
  // exported types consumed only within their own module are public API surface,
  // not dead code
  ignoreExportsUsedInFile: true,
  // release tooling (invoked in CI) and a GitHub dependency Knip cannot resolve
  ignoreDependencies: ["@changesets/cli", "@omnidotdev/providers"],
};

export default knipConfig;
