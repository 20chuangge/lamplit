/**
 * modelerrors.mjs - what a model provider's error means, in words a new user
 * can act on (1.5.30).
 *
 * The providers answer in English JSON ("model HTTP 401: {"error":{"message":
 * "Authentication Fails, Your api key ... is invalid"...}}"). The first-run
 * guide, 测试连接 and a turn that stops on a model error showed that as is.
 * Here it becomes what happened and what to do; the raw text stays in
 * `detail` for whoever needs it.
 */

const RULES = [
  {
    code: 'KEY_INVALID',
    test: /HTTP 40[13]\b|authenticat|invalid[\s_-]*(api[\s_-]*)?key|incorrect api key|unauthori[sz]ed|api key.*(invalid|not valid|wrong)|no api key|missing api key/i,
    text: '密钥不对：服务商说这个密钥无效。检查有没有复制全（前后不要带空格），或者到服务商网站重新建一个。',
  },
  {
    code: 'NO_BALANCE',
    test: /HTTP 402\b|insufficient[\s_-]*(balance|quota|credit|funds)|余额不足|欠费|quota.*exceed|exceeded.*quota|billing|payment required|arrear/i,
    text: '账户没钱了：服务商说余额不足。到服务商网站充值后再试（DeepSeek 等新账号要先充值才能用）。',
  },
  {
    code: 'RATE_LIMIT',
    test: /HTTP 429\b|rate[\s_-]*limit|too many requests|请求过于频繁|限流/i,
    text: '请求太多被限速了：等一两分钟再试；经常这样的话，到服务商网站提高额度或换一家。',
  },
  {
    code: 'MODEL_NOT_FOUND',
    test: /HTTP 404\b|model[^.]{0,40}(not exist|does not exist|not found|not available|不存在)|unknown model|invalid model/i,
    text: '服务商没有这个模型：到「设置 → 模型」换一个模型名，或者用服务商推荐的默认模型。',
  },
  {
    code: 'TOO_LONG',
    test: /context[\s_-]*(length|window)|maximum context|too (long|many tokens)|prompt is too long|超出.*长度/i,
    text: '这次要发给模型的内容太长了：开一个新对话，或把长材料放进文件让助手去读。',
  },
  {
    code: 'PROVIDER_DOWN',
    test: /HTTP 5\d\d\b|overloaded|server error|service unavailable|bad gateway|internal error|服务繁忙/i,
    text: '服务商那边暂时出错了（不是你的问题）：过一会儿再试；一直这样就换一家或换个模型。',
  },
  {
    code: 'UNREACHABLE',
    test: /model request failed|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|timed? ?out|timeout|aborted/i,
    text: '连不上服务商：检查这台机器能不能上网；开着代理软件的话，看它是不是挡住或绕远了（设置 → 机器 → 网络诊断）。',
  },
];

/** -> {code, text, detail}: what it means and what to do; the raw message in `detail`. */
export function explainModelError(error) {
  const raw = String(error?.message ?? error ?? '').trim();
  const rule = RULES.find((r) => r.test.test(raw));
  if (rule) return { code: rule.code, text: rule.text, detail: raw.slice(0, 300) };
  // Unknown: keep it short and say where it came from.
  const said = /"message"\s*:\s*"([^"]{1,160})"/.exec(raw)?.[1] || raw.replace(/^model (HTTP \d+|stream error):\s*/i, '').slice(0, 160);
  return { code: 'MODEL_ERROR', text: `模型服务商返回了错误：${said || '没有说原因'}。可以到「设置 → 模型」点「测试连接」再试一次。`, detail: raw.slice(0, 300) };
}
