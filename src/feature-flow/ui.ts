import { loadConfig, resolveSpecsRoot } from "../config.js";
import { listFeatureSlugs } from "../registry.js";

export function createFeatureCompletions(prefix: string) {
  return loadConfig(process.cwd()).then(async (config) => {
    const specsRoot = resolveSpecsRoot(process.cwd(), config);
    const features = await listFeatureSlugs(specsRoot);
    const items = features
      .filter((slug) => slug.startsWith(prefix.trim()))
      .map((slug) => ({ value: slug, label: slug }));
    return items.length > 0 ? items : null;
  });
}
