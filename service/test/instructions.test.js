// instructionsFor / enrollProtocol 的纯函数单测（无需起服务）。
// 覆盖 M4 路 B：高信任客户端连接即拿到「常驻宿主自装」指引（低信任 403 于 /digest，不下发以免误导）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS, PRIMARY_RULES, SELF_WIRE, instructionsFor } from '../src/instructions.js';

test('instructionsFor：high 信任附常驻宿主自装指引，low 不附', () => {
  const high = instructionsFor({ trust: 'high' });
  assert.match(high, /常驻宿主自装/, 'high 应含自装指引');
  assert.match(high, /\/digest/, '自装指引应指向 /digest');
  assert.match(high, /\.hermes\.md/, '自装指引应给出 Hermes 的落地文件');
  const low = instructionsFor({ trust: 'low' });
  assert.ok(!low.includes('常驻宿主自装'), 'low 不该看到自装指引（/digest 对它 403）');
  assert.equal(low, INSTRUCTIONS, 'low 行为不变');
});

test('instructionsFor：primary+high = 基础 + 自装 + 主频道房规，顺序稳定', () => {
  const primary = instructionsFor({ trust: 'high', channel: 'primary' });
  assert.equal(primary, INSTRUCTIONS + SELF_WIRE + PRIMARY_RULES);
});
