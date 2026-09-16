/**
 * anthropic-probe —— 用一次**最小**请求把某个订阅的额度头「问出来」。
 *
 * 为什么需要它：Anthropic 订阅的额度不是查出来的，是**写在正常响应的响应头里**的
 * （见 anthropic-quota.ts）。所以没用过的账号在全景里只能显示「还没有数据」——而那
 * 恰恰是你最想知道余量的账号（要不要切过去？）。
 *
 * 为什么可以接受：这条请求刻意压到最小 —— `max_tokens: 1`、一个字的提示词、
 * 不要流式。它消耗的是订阅额度里可以忽略的一点点，换来的是四个窗口的真实数字。
 * 即便如此，它仍然**只在用户明确要求时**发出（`/subs limit-status --probe`），
 * 绝不在后台自动跑：默默花钱是不能接受的，哪怕只是一点点。
 *
 * 安全约定：凭据只在本模块内用于一次 Authorization 头，不写日志、不进状态框、
 * 不进任何持久化；返回的只有解析后的额度窗口。
 */

/** 最小请求体：一个 token 的上限 + 一个字的提示词。 */
export function probeBody(model: string): string {
	return JSON.stringify({
		model,
		max_tokens: 1,
		messages: [{ role: "user", content: "." }],
	});
}

/** OAuth 订阅调用所需的头（与 pi 自己的 Anthropic OAuth 传输一致）。 */
export function probeHeaders(accessToken: string): Record<string, string> {
	return {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "oauth-2025-04-20",
		authorization: `Bearer ${accessToken}`,
	};
}

export interface ProbeOutcome {
	/** 响应头（小写键）——交给 parseAnthropicQuotaHeaders 解析。 */
	headers: Record<string, string>;
	status: number;
	/** 失败原因（credential-free 短句）；成功时缺省。 */
	error?: string;
}

/**
 * 发一次探针。**任何**失败都只返回 error，不抛异常：这是「顺手多问一句」，
 * 不该让整条 /subs limit-status 挂掉。额度头在 4xx（含 429）上同样会回来，
 * 所以只要拿到响应就算有收获。
 */
export async function probeAnthropicQuota(
	accessToken: string,
	model: string,
	options: { fetchImpl?: typeof fetch; timeoutMs?: number; baseUrl?: string } = {},
): Promise<ProbeOutcome> {
	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
	try {
		const response = await doFetch(`${options.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
			method: "POST",
			headers: probeHeaders(accessToken),
			body: probeBody(model),
			signal: controller.signal,
		});
		const headers: Record<string, string> = {};
		response.headers?.forEach?.((value: string, key: string) => {
			// 只收额度相关的头，别把无关响应头（可能含账号信息）带进内存。
			if (key.toLowerCase().startsWith("anthropic-ratelimit-")) headers[key.toLowerCase()] = value;
		});
		// 读掉 body 以释放连接；内容一律丢弃（我们要的只是响应头）。
		try {
			await response.text();
		} catch {
			/* body 读不到不影响已拿到的头 */
		}
		return { headers, status: response.status };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { headers: {}, status: 0, error: message.includes("abort") ? "probe timed out" : "probe failed" };
	} finally {
		clearTimeout(timer);
	}
}
