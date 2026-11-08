// Map the types-only `obsidian` package to the test stub (used with `node --import ./test/stubs/register.mjs`).
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'obsidian') return { url: ${JSON.stringify(new URL('./obsidian.ts', import.meta.url).href)}, shortCircuit: true };
  return next(spec, ctx);
}`));
