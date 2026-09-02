// Generate a @solana/kit TypeScript client from the reconstructed program's Anchor IDL.
// The renderer emits a `<out>/src/generated` module; we flatten it into app/src/generated
// so imports are just `@/generated`.
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { readFileSync, rmSync, renameSync, existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const idlPath = join(here, '..', '..', 'target', 'idl', 'fbyt_vault.json');
const finalDir = join(here, '..', 'src', 'generated');

const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));

const tmp = mkdtempSync(join(here, '..', '.codama-')); // same filesystem for renameSync
await codama.accept(renderVisitor(tmp)); // render writes files asynchronously

const inner = join(tmp, 'src', 'generated');
const moduleDir = existsSync(inner) ? inner : tmp;
if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
renameSync(moduleDir, finalDir);
rmSync(tmp, { recursive: true, force: true });
console.log(`generated client -> ${finalDir} (from ${idlPath})`);
