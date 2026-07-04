// keeper 的 LLM provider（可换是既定设计）。v0：DeepSeek（OpenAI 兼容），flash 主判 + pro 升级。
export function createDeepSeekProvider({
  apiKey,
  model = 'deepseek-v4-flash',
  escalationModel = 'deepseek-v4-pro',
  baseUrl = 'https://api.deepseek.com',
  fetchImpl = fetch,
}) {
  async function judge({ system, user, escalate = false }) {
    const useModel = escalate ? escalationModel : model;
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0, // 判断要可复现（判例回归的前提）
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}：${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`模型输出不是合法 JSON：${text.slice(0, 200)}`);
    }
    return { json, usage: data.usage, model: useModel };
  }
  return { judge };
}
