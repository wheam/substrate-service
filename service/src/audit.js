// 全量审计：每次工具调用一行 JSON（谁、何时、调了什么、成败、耗时）。
// stdout 即 Railway 日志；另可选追加到 volume 上的文件（AUDIT_FILE）。
import { appendFileSync } from 'node:fs';

export function createAudit({ file } = {}) {
  return function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    console.log(`AUDIT ${line}`);
    if (file) {
      try { appendFileSync(file, line + '\n'); } catch { /* 审计文件写失败不影响主流程 */ }
    }
  };
}
