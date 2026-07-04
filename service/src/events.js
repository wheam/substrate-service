// capture 事件流：keeper 每次裁决追加一条，App 状态页轮询用。
// 非 canonical（真相在 git），只是给手机的便利视图；文件在 volume 上，重启恢复最近 500 条。
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KEEP = 500;

export function createEventStore({ file } = {}) {
  let events = [];
  if (file && existsSync(file)) {
    events = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }
  return {
    push(e) {
      events.push(e);
      if (events.length > KEEP) events = events.slice(-KEEP);
      if (file) {
        try {
          mkdirSync(path.dirname(file), { recursive: true });
          appendFileSync(file, JSON.stringify(e) + '\n');
        } catch (err) { console.error(`events 落盘失败：${err.message}`); }
      }
    },
    list() { return [...events]; },
  };
}
