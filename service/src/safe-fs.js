// 读/搜/索引共用的符号链接防护。zone 与 trust 校验都按逻辑路径做；实例里一旦出现符号链接
// （经 git 同步或本地维护带进来），knowledge/ 下的一个别名就能指向 memory/ 敏感页或实例外文件，
// 让低信任读取绕过 zone 校验。recall 的证据展开早已用 realpath 拒绝这类别名（evidence.js），
// 这里让 read_page / search / 索引 / 夜班遵守同一条边界：经过符号链接的路径一律不读、不遍历。
import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

// rel（实例内相对路径，/ 分隔）的任一已存在分量是符号链接 → true。不存在的尾部不算。
export function viaSymlink(instanceDir, rel) {
  let cursor = path.resolve(instanceDir);
  for (const part of String(rel ?? '').split('/')) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    let st;
    try { st = lstatSync(cursor); }
    catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
      throw e;
    }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

// 遍历实例内的普通文件（返回 / 分隔的相对路径）。符号链接（无论指向文件还是目录）整个跳过，
// 因此也不会跟随链接成环。exts 为扩展名集合（含点），缺省不过滤。
export function walkRegularFiles(instanceDir, { exts = null } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(path.join(instanceDir, dir), { withFileTypes: true })) {
      const name = entry.name;
      if (name === '.git' || name === 'node_modules') continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile() && (!exts || exts.has(path.extname(name)))) out.push(rel);
    }
  }
  return out;
}
