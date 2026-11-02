// Injected into a desktop renderer evaluation. One evaluation shares a bounded
// graph between consumers; a later evaluation always starts from the live entry.
export const DESKTOP_MODULE_GRAPH_LOADER = String.raw`
const entry = [...document.scripts].find(script => script.type === 'module' && script.src);
if (!entry) throw Object.assign(new Error('Desktop module entry unavailable'), {failureClass:'api_compatibility'});
const entryUrl = new URL(entry.src);
const entryDirectory = entryUrl.pathname.slice(0, entryUrl.pathname.lastIndexOf('/') + 1);
const queue = [], visited = new Set(), loaded = [];
let graphTruncated = false;
const moduleLimit = 64;
const addImports = (source, parentUrl) => {
  // Skip comments and quoted content while matching actual import specifiers.
  // Template expressions are deliberately opaque; they are not static paths.
  const pattern = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|\b(?:import(?:\s|\/\*[\s\S]*?\*\/)*(?:\((?:\s|\/\*[\s\S]*?\*\/)*)?|from(?:\s|\/\*[\s\S]*?\*\/)*)(["'\x60])([^"'\x60\r\n]+)\1/g;
  for (const match of source.matchAll(pattern)) {
    if (!match[2] || match[2].includes('\\') || !/^(?:\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(match[2])) continue;
    let url;
    try { url = new URL(match[2], parentUrl); } catch { continue; }
    if (url.protocol !== entryUrl.protocol || url.host !== entryUrl.host || url.search || url.hash
      || url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) !== entryDirectory
      || !/^(?:app-(?:shared|initial|primary|main|runtime)|renderer-app-server-managers)-[a-z0-9_-]+\.js$/i.test(url.pathname.split('/').at(-1))) continue;
    if (visited.has(url.href)) continue;
    if (queue.length >= moduleLimit) { graphTruncated = true; break; }
    visited.add(url.href);
    queue.push(url.href);
  }
};
let entrySource;
try {
  const response = await fetch(entry.src);
  if (response.ok === false) throw new Error('entry fetch failed');
  entrySource = await response.text();
} catch {
  throw Object.assign(new Error('Desktop module entry unavailable'), {failureClass:'api_compatibility'});
}
addImports(entrySource, entry.src);
async function* activeDesktopModules() {
  let index = 0;
  while (true) {
    if (index >= queue.length) {
      if (graphTruncated) throw Object.assign(new Error('Desktop module graph limit exceeded'), {failureClass:'api_compatibility'});
      return;
    }
    let item = loaded[index];
    if (!item) {
      const assetUrl = queue[index];
      try {
        const response = await fetch(assetUrl);
        if (response.ok === false) throw new Error('asset fetch failed');
        const source = await response.text();
        addImports(source, assetUrl);
        item = {assetUrl, source};
        loaded[index] = item;
      } catch { index++; continue; }
    }
    index++;
    yield item;
  }
}
`;
