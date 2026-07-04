// 飞书自定义机器人通知（哑通路、单向播报）。签名算法见飞书官方「自定义机器人安全设置」。
import crypto from 'node:crypto';

export function feishuSign(secret, timestampSec) {
  // 官方算法：key = `${timestamp}\n${secret}`，message 为空，HmacSHA256 后 base64
  return crypto.createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

export function createNotifier({ webhookUrl, secret, fetchImpl = fetch }) {
  async function notify(text) {
    if (!webhookUrl) {
      console.log(`NOTIFY(webhook 未配置) ${text.replace(/\n/g, ' | ')}`);
      return { ok: false, skipped: true };
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = { timestamp, sign: feishuSign(secret ?? '', timestamp), msg_type: 'text', content: { text } };
    try {
      const res = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      const ok = Boolean(res.ok) && (data.code === 0 || data.StatusCode === 0);
      if (!ok) console.error(`notify 失败：${JSON.stringify(data).slice(0, 200)}`);
      return { ok, resp: data };
    } catch (e) {
      console.error(`notify 异常：${e.message}`);
      return { ok: false, error: e.message };
    }
  }
  return { notify };
}
