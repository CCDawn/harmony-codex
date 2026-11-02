import { DESKTOP_MODULE_GRAPH_LOADER } from './desktopModuleGraph.js';

// Use the running app's existing receiver: it owns chunk assembly and ACKs.
// Raw window messages can be transport envelopes rather than mcp responses.
// Resolve by capabilities instead of retaining a build-specific hashed export.
export const LOAD_DESKTOP_HOST_MESSAGES = String.raw`
const desktopMessages = await (window.__codexHarmonyHostMessages ??= (async () => {
  ${DESKTOP_MODULE_GRAPH_LOADER}
  for await (const {assetUrl, source} of activeDesktopModules()) {
    if (!source.includes('hostMessageInterceptors') || !source.includes('startWindowMessageListener')) continue;
    const module = await import(assetUrl);
    for (const candidate of Object.values(module)) {
      if (typeof candidate !== 'object' || candidate === null
          || typeof candidate.subscribe !== 'function'
          || typeof candidate.dispatchHostMessage !== 'function'
          || typeof candidate.startWindowMessageListener !== 'function') continue;
      if (candidate.initialized !== false) return candidate;
    }
  }
  throw new Error('Codex desktop assembled message receiver unavailable');
})().catch(error => {
  delete window.__codexHarmonyHostMessages;
  throw error;
}));
`;
