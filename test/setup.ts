import { DOMParser } from 'xmldom';

// Polyfill DOMParser for Node.js test environment
if (typeof globalThis.DOMParser === 'undefined') {
  // @ts-expect-error - xmldom DOMParser is compatible enough for our usage
  globalThis.DOMParser = DOMParser;
}
