import { h as CLAUDE_CODE_PROVIDER } from "./events-CKwSqljn.mjs";
import { f as CLAUDE_COMMANDS_SERVICE, t as canonicalClaudeModelId, u as claudePresenterDefinitions } from "./model-catalog-Bz0PxsFj.mjs";
//#region src/preset-route.ts
const name = "claude-code-preset-route";
const inject = ["tools", "commands"];
function apply(ctx, config = {}) {
	ctx.on("agent/request", async (_payload, next) => {
		const upstream = await next();
		return {
			...upstream,
			provider: CLAUDE_CODE_PROVIDER,
			model: canonicalClaudeModelId(config.model ?? upstream.model ?? "default")
		};
	});
	ctx.provide(CLAUDE_COMMANDS_SERVICE, { list: (agent) => ctx.commands.list(agent) });
	for (const definition of claudePresenterDefinitions()) ctx.effect(() => ctx.tools.register(definition), `dsh-claude: ${definition.name} presentation`);
	ctx.inject(["jobs"], (jobsCtx) => {
		jobsCtx.effect(() => jobsCtx.jobs.attachController("dsh-claude"), "dsh-claude: job controller");
	});
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=preset-route.mjs.map