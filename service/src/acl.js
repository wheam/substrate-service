// zone ACL：解析实例 governance/zones.md 顶部 YAML 块，按 privacy 控制读取。
// 只解析本引擎约定的固定形状（zones: 列表 + 平铺标量字段），不引 YAML 依赖——与引擎 doctor 的做法一致。
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function parseZones(instanceDir) {
  const raw = readFileSync(path.join(instanceDir, 'governance', 'zones.md'), 'utf8');
  const fence = raw.match(/```yaml\n([\s\S]*?)```/);
  if (!fence) throw new Error('governance/zones.md 里找不到 yaml 块');
  const zones = [];
  let current = null;
  for (const line of fence[1].split('\n')) {
    const item = line.match(/^  - (\w+):\s*(.*)$/);
    const field = line.match(/^    (\w+):\s*(.*)$/);
    if (item) {
      current = { [item[1]]: stripScalar(item[2]) };
      zones.push(current);
    } else if (field && current) {
      current[field[1]] = stripScalar(field[2]);
    }
  }
  return zones;
}

// YAML 标量归一：剥一层首尾引号 + trim。导出供 tier.js 复用（缺陷4：tier 写法变体去引号——单一实现，杜绝分叉）。
export function stripScalar(v) {
  return String(v).replace(/^["']|["']$/g, '').trim();
}

export function zoneFor(zones, relPath) {
  return zones.find((z) => z.path && relPath.startsWith(z.path)) ?? null;
}

// 单个 zone 是否对该 trust 可读（zone 可为 null）。sensitive 只放高信任；其余（含未注册 null）放行。
// index-store 查询侧据此把「可读 zone 集合」预过滤进 SQL（ACL 在 LIMIT 之前生效）。
export function canReadZone(zone, trust) {
  if (zone?.privacy === 'sensitive') return trust === 'high';
  return true;
}

export function canRead(zones, relPath, trust) {
  return canReadZone(zoneFor(zones, relPath), trust);
}
