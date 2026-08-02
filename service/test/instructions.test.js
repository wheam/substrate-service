// instructionsFor / enrollProtocol 的纯函数单测（无需起服务）。
// 覆盖 M4 路 B：高信任客户端连接即拿到「常驻宿主自装」指引（低信任 403 于 /digest，不下发以免误导）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHAVIOR_RULES, DIGEST_RULES, INSTRUCTIONS, PRIMARY_RULES, SELF_WIRE,
  instructionsFor, enrollProtocol,
} from '../src/instructions.js';

test('在线 instructions 与常驻 digest 复用同一份主动行为契约', () => {
  assert.ok(INSTRUCTIONS.includes(BEHAVIOR_RULES), 'MCP instructions 应包含共享行为契约');
  assert.ok(DIGEST_RULES.includes(BEHAVIOR_RULES), 'digest 应包含同一份共享行为契约');
  for (const anchor of ['读库再答', '捕获信号', '主动提议保存', '敏感边界']) {
    assert.match(BEHAVIOR_RULES, new RegExp(anchor), `共享行为契约缺少「${anchor}」`);
  }
  assert.match(BEHAVIOR_RULES, /recall/, '自然语言问题应路由到 recall');
  assert.match(BEHAVIOR_RULES, /不要等主人明确说.*查知识库/s, '应明确要求不要等待显式查库口令');
  assert.match(BEHAVIOR_RULES, /每轮答复前.*扫一遍/s, '应给模型稳定的逐轮捕获节奏');
  assert.match(BEHAVIOR_RULES, /没有相应写入工具.*高信任渠道/s, '只读客户端应有可执行的写入兜底');
});

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

test('enrollProtocol：Hermes 类宿主条目给出具体落地文件与保旧铁律', () => {
  const text = enrollProtocol('https://example.test');
  assert.match(text, /~\/\.hermes\.md/, '应点名 Hermes 的落地文件 ~/.hermes.md');
  assert.match(text, /保留旧文件/, '应写明失败保旧');
  assert.match(text, /https:\/\/example\.test\/digest/, 'digest URL 按 baseUrl 拼');
});
