import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export const CANONICAL_SSD = '/Volumes/PortableSSD';
const OUTPUT_ROOTS = ['artifacts', '.work'];

// Resolve symlinks through the deepest existing ancestor so a not-yet-created file is still checked.
export function resolvePhysical(path) {
  let head = path;
  const tail = [];
  while (!existsSync(head)) {
    tail.unshift(basename(head));
    const parent = dirname(head);
    if (parent === head) break;
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

const within = (path, root) => path === root || path.startsWith(root + sep);

export function admitOutputPath(repo, out, { ssdRoot = CANONICAL_SSD } = {}) {
  const repoReal = resolvePhysical(repo);
  const outReal = resolvePhysical(out);
  if (!existsSync(ssdRoot)) return { ok: false, code: 'storage_unavailable', path: outReal };
  if (!within(repoReal, realpathSync(ssdRoot))) return { ok: false, code: 'storage_path_rejected', path: outReal, detail: 'repository is not on the SSD' };
  if (!OUTPUT_ROOTS.some(root => within(outReal, join(repoReal, root)))) {
    return { ok: false, code: 'storage_path_rejected', path: outReal, detail: 'output resolves outside artifacts/ and .work/' };
  }
  return { ok: true, code: 'ok', path: outReal };
}
