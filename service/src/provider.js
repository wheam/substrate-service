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
    const body = {
      model: useModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    };
    if (escalate) {
      // 升级档要的就是深想；预算须容得下 reasoning + JSON
      body.thinking = { type: 'enabled' };
      body.max_tokens = 8000;
    } else {
      // 主判官关思考：v4 默认开思考，reasoning 会吃光 max_tokens 致正文为空；
      // 且思考模式下 temperature 无效——关掉才真正可复现（判例回归的前提）
      body.thinking = { type: 'disabled' };
      body.temperature = 0;
      body.max_tokens = 2000;
    }
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}：${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text.trim()) {
      const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      throw new Error(`模型输出为空（finish_reason=${choice?.finish_reason}，reasoning_tokens=${reasoningTokens}）`);
    }
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
