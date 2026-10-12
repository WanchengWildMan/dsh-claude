import { s as redactText } from "./events-CKwSqljn.mjs";
import { query } from "@anthropic-ai/claude-agent-sdk";
//#region src/command-bridge.ts
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_HINT_CHARS = 120;
/** DSH registry names reject `:`, but plugin-qualified Claude skills carry it
*  (e.g. `awesome-skills:ci-deploy`). Derive a registry-safe public name while
*  forwarding keeps the exact Claude-side name. */
function registryName(claudeName) {
	if (COMMAND_NAME.test(claudeName)) return claudeName;
	const short = claudeName.includes(":") ? claudeName.slice(claudeName.lastIndexOf(":") + 1) : void 0;
	if (short !== void 0 && COMMAND_NAME.test(short)) return short;
	const sanitized = claudeName.replaceAll(":", "-").toLowerCase();
	return COMMAND_NAME.test(sanitized) ? sanitized : void 0;
}
/**
* Names registered as CLIENT-side commandUi contributions (not host
* commands). The DSH web command palette fails its whole command group when
* a host command name equals a contribution name
* ("contribution /model collides with a host command"), so these can never
* be registered by this bridge. Keep in sync with the client bundles:
* dsh-client-ui-model-selection registers "model".
*/
const CLIENT_CONTRIBUTION_NAMES = /* @__PURE__ */ new Set(["model"]);
/**
* Cordis service name the preset route provides (behind an entry-local
* isolate realm, so each session gets its own instance) and the host reads
* back with the agent-preset registry's `serviceFor(agent, name)`
* — the supported cross-scope read for callers that already hold the agent.
*/
const CLAUDE_COMMANDS_SERVICE = "claudeCommands";
function bounded(value, maxChars) {
	return redactText(value, maxChars);
}
function projectClaudeCommands(catalog, target) {
	const reservedNames = new Set(target.list().map((command) => command.name));
	for (const name of CLIENT_CONTRIBUTION_NAMES) reservedNames.add(name);
	const assigned = /* @__PURE__ */ new Set();
	const views = [];
	for (const command of catalog) {
		const names = [command.name, ...command.aliases ?? []];
		const commandBases = /* @__PURE__ */ new Set();
		for (const claudeName of names) {
			const base = registryName(claudeName);
			if (base === void 0 || commandBases.has(base)) continue;
			commandBases.add(base);
			let publicName = base;
			let prefixed = false;
			if (reservedNames.has(publicName) || assigned.has(publicName)) {
				publicName = `claude-${base}`;
				prefixed = true;
			}
			if (!COMMAND_NAME.test(publicName) || reservedNames.has(publicName) || assigned.has(publicName)) continue;
			const description = bounded(command.description || `Claude Code /${command.name}`, MAX_DESCRIPTION_CHARS);
			const hint = bounded(command.argumentHint ?? "", MAX_HINT_CHARS);
			views.push({
				publicName,
				claudeName,
				description,
				...hint.length === 0 ? {} : { hint },
				prefixed
			});
			assigned.add(publicName);
		}
	}
	return views;
}
//#endregion
//#region src/presenters.ts
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function str(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function resultText(result) {
	return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
/** Bash: a terminal card headed by the command, described above by Claude's own summary. */
function bashCallView(args) {
	const command = str(record(args)?.command);
	if (command === void 0) return void 0;
	const description = str(record(args)?.description);
	return {
		card: "terminal",
		title: command,
		...description === void 0 ? {} : { description }
	};
}
function terminalResultView(_args, result) {
	const output = resultText(result);
	return output.length === 0 ? void 0 : {
		card: "terminal",
		output
	};
}
/** Read: a generic read card that follow-alongs the file window. */
function readCallView(args) {
	const arguments_ = record(args);
	const path = str(arguments_?.file_path);
	if (path === void 0) return void 0;
	const offset = typeof arguments_?.offset === "number" ? arguments_.offset : void 0;
	return {
		card: "generic",
		kind: "read",
		title: `Read ${path}`,
		locations: [{
			path,
			...offset === void 0 ? {} : { line: offset }
		}]
	};
}
function fileDiffs(args) {
	const arguments_ = record(args);
	const path = str(arguments_?.file_path);
	if (path === void 0) return void 0;
	if (Array.isArray(arguments_?.edits)) {
		const diffs = [];
		for (const edit of arguments_.edits) {
			const item = record(edit);
			const oldText = str(item?.old_string);
			const newText = str(item?.new_string);
			if (newText === void 0) continue;
			diffs.push({
				path,
				oldText: oldText ?? null,
				newText
			});
		}
		return diffs.length > 0 ? diffs : void 0;
	}
	const newText = str(arguments_?.new_string) ?? arguments_?.content;
	if (typeof newText !== "string" || newText.length === 0) return void 0;
	return [{
		path,
		oldText: str(arguments_?.old_string) ?? null,
		newText
	}];
}
/** Edit / MultiEdit / Write: inline diff cards derived from the call arguments. */
function diffCallView(args) {
	const arguments_ = record(args);
	const path = str(arguments_?.file_path);
	const diffs = fileDiffs(args);
	if (path === void 0 || diffs === void 0) return void 0;
	return {
		card: "diff",
		title: `${typeof arguments_?.new_string === "string" || Array.isArray(arguments_?.edits) ? "Edit" : "Write"} ${path}`,
		diffs,
		locations: [{ path }]
	};
}
/** Edit / MultiEdit / Write results: the same diff, again.
*
*  A completed card replaces the pending one, so a mutation that returns no
*  result view loses its diff to the raw result text. The plugin transcript
*  drops the diff on failure and shows the error instead; mirror that. */
function diffResultView(args, result) {
	if (result.isError) return void 0;
	const diffs = fileDiffs(args);
	return diffs === void 0 ? void 0 : {
		card: "diff",
		diffs
	};
}
function parsedResult(result) {
	const text = resultText(result);
	if (text.length === 0) return void 0;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
/** Grep / Glob results: the discovered paths as a search card.
*
*  Only the structured `filenames` shape is projected. A text result (Grep's
*  content mode) carries its own formatting, so it falls through to the raw
*  result content rather than being re-parsed into fake match groups. */
function searchResultView(_args, result) {
	if (result.isError) return void 0;
	const output = record(parsedResult(result));
	if (!Array.isArray(output?.filenames)) return void 0;
	const paths = output.filenames.filter((item) => typeof item === "string");
	const reported = output.numFiles;
	const total = typeof reported === "number" && Number.isInteger(reported) && reported >= paths.length ? reported : paths.length;
	return {
		card: "search",
		shape: "paths",
		paths,
		truncated: total > paths.length,
		total
	};
}
/** Grep / Glob / WebSearch: search-category cards titled by the query. */
function searchCallView(args) {
	const arguments_ = record(args);
	const query = str(arguments_?.pattern) ?? str(arguments_?.query);
	if (query === void 0) return void 0;
	const scope = str(arguments_?.path);
	return {
		card: "generic",
		kind: "search",
		title: scope === void 0 ? query : `${query} · ${scope}`,
		rawInput: args
	};
}
/** WebFetch: a fetch-category card titled by the URL. */
function fetchCallView(args) {
	const url = str(record(args)?.url);
	if (url === void 0) return void 0;
	return {
		card: "generic",
		kind: "fetch",
		title: url,
		rawInput: args
	};
}
/** ExitPlanMode: the plan itself, as prose rather than as tool arguments.
*
*  This is the one built-in tool whose whole payload is written for the user
*  to read: Claude asks to leave plan mode and the approval that follows is
*  the user agreeing to the plan. Rendering it as `Input: {"plan":"..."}`
*  buries the only thing worth reading, so the plan becomes the card body. */
function planCallView(args) {
	const plan = str(record(args)?.plan);
	return plan === void 0 ? void 0 : {
		card: "generic",
		kind: "other",
		title: "Plan ready for review",
		content: [{
			type: "text",
			text: plan
		}]
	};
}
/** Task: a subagent card titled by Claude's task description. */
function taskCallView(args) {
	const arguments_ = record(args);
	return {
		card: "generic",
		kind: "other",
		title: str(arguments_?.description) ?? str(arguments_?.subagent_type) ?? "Subagent",
		rawInput: args
	};
}
function genericTitle(title) {
	return {
		card: "generic",
		kind: "other",
		title
	};
}
function presenterDefinition(name, description, presentCall, presentResult) {
	return {
		name,
		description,
		parameters: {
			type: "object",
			properties: {}
		},
		output: {
			schema: {
				type: "object",
				properties: {}
			},
			render: () => []
		},
		execute: async () => {
			throw new Error(`dsh-claude: Claude Code owns execution of ${name}`);
		},
		...presentCall === void 0 ? {} : { presentCall },
		...presentResult === void 0 ? {} : { presentResult }
	};
}
const PRESENTATION_NOTE = "Presentation mirror of the Claude Code tool; execution is owned by Claude Code.";
/** Generic call view for dynamically observed tools (MCP tools, new built-ins). */
function genericCallView(toolName) {
	return (args) => {
		return {
			card: "generic",
			kind: "other",
			title: str(record(args)?.description) ?? toolName,
			rawInput: args
		};
	};
}
/** One presenter-only mirror for a tool name discovered at runtime. */
function dynamicPresenterDefinition(name) {
	return presenterDefinition(name, PRESENTATION_NOTE, genericCallView(name));
}
/** The presentation-only registry contributed to the Claude Code preset scope. */
function claudePresenterDefinitions() {
	return [
		presenterDefinition("Bash", PRESENTATION_NOTE, bashCallView, terminalResultView),
		presenterDefinition("PowerShell", PRESENTATION_NOTE, bashCallView, terminalResultView),
		presenterDefinition("Read", PRESENTATION_NOTE, readCallView),
		presenterDefinition("Edit", PRESENTATION_NOTE, diffCallView, diffResultView),
		presenterDefinition("MultiEdit", PRESENTATION_NOTE, diffCallView, diffResultView),
		presenterDefinition("Write", PRESENTATION_NOTE, diffCallView, diffResultView),
		presenterDefinition("NotebookEdit", PRESENTATION_NOTE, (args) => {
			const path = str(record(args)?.notebook_path);
			return path === void 0 ? void 0 : genericTitle(`NotebookEdit ${path}`);
		}),
		presenterDefinition("Grep", PRESENTATION_NOTE, searchCallView, searchResultView),
		presenterDefinition("Glob", PRESENTATION_NOTE, searchCallView, searchResultView),
		presenterDefinition("WebSearch", PRESENTATION_NOTE, searchCallView),
		presenterDefinition("WebFetch", PRESENTATION_NOTE, fetchCallView),
		presenterDefinition("Task", PRESENTATION_NOTE, taskCallView),
		presenterDefinition("ExitPlanMode", PRESENTATION_NOTE, planCallView),
		presenterDefinition("TodoWrite", PRESENTATION_NOTE, () => genericTitle("Update todos"))
	];
}
/** Names covered by the static preset-scope registry; dynamic mirrors skip them. */
const CLAUDE_PRESENTER_NAMES = new Set(claudePresenterDefinitions().map((definition) => definition.name));
//#endregion
//#region src/model-catalog.ts
/** The Claude Code model lineup, read from the running CLI instead of pinned
*  here.
*
*  Anthropic ships models between releases of this plugin -- Fable arrived in a
*  CLI update, not in one of ours -- so a table maintained here is stale the day
*  it is written, and a model the user can already pick in `/model` is missing
*  from the DSH selector until someone edits an array. The CLI answers the same
*  question itself: every session's initialize response carries the lineup it
*  would show in `/model`, already narrowed to the logged-in account's plan and
*  to any `availableModels` restriction the settings cascade imposes.
*
*  What DSH persists on a session, though, must NOT be a CLI model id. DSH
*  stores the selector row's id verbatim and matches it back by string
*  equality, so a concrete id (`claude-fable-5-1[1m]`) turns into a dangling
*  reference the moment Anthropic bumps the version -- the session keeps
*  pointing at a row nothing advertises any more, and the composer falls back
*  to printing the raw id. The selector therefore advertises an alias this
*  plugin owns (`fable[1m]`), derived from the row rather than tabulated, and
*  the CLI id it stands for is kept beside it and used only at dispatch.
*/
/** A 1M-context route spells it in the id (`opus[1m]`, `claude-fable-5-1[1m]`). */
const WIDE_ROUTE = /\[1m\]$/u;
/** What the selector shows before the lineup is known -- the probe below failed
*  or has not answered yet. `default` is the only id that is valid on every
*  release and plan; the rest are the stable `/model` spellings Claude Code has
*  kept across releases, and every one of them is a spelling the CLI accepts,
*  so a session that persists one still dispatches. */
const SEED = [
	{
		id: "default",
		value: "default",
		name: "Default (recommended)",
		description: ""
	},
	{
		id: "opus[1m]",
		value: "opus[1m]",
		name: "Opus (1M context)",
		description: "",
		contextWindow: 1e6
	},
	{
		id: "opus",
		value: "opus",
		name: "Opus",
		description: ""
	},
	{
		id: "fable",
		value: "fable",
		name: "Fable",
		description: ""
	},
	{
		id: "sonnet",
		value: "sonnet",
		name: "Sonnet",
		description: ""
	},
	{
		id: "haiku",
		value: "haiku",
		name: "Haiku",
		description: ""
	}
];
/** A 1M-context route spells it in the id, so this needs no capacity table
*  either. It is only a floor: the supervisor overrides it with the window the
*  CLI reports once a turn has run. */
function declaredContextWindow(row) {
	return WIDE_ROUTE.test(row.resolvedModel ?? row.value) ? 1e6 : void 0;
}
/**
* The selector id for one CLI row: the model's family, plus the `[1m]` marker
* when the route carries one.
*
* Derived, never tabulated -- a family this plugin has never heard of gets its
* id the same way, so a model Anthropic ships tomorrow lands in the selector
* without an edit here, and a version bump (`claude-fable-5-1` ->
* `claude-fable-5-2`) leaves an already-persisted selection pointing at the
* same row. The family is the first non-numeric segment, which covers both
* spellings Anthropic has used (`claude-fable-5-1`, `claude-3-5-sonnet-…`).
*
* Read off `value` alone, never the id it resolves to: `default` names a route
* whose resolution moves with the account and the release, so folding the
* resolved `[1m]` in would flip an already-persisted `default` to `default[1m]`
* the day Anthropic repoints it.
* @param value - the CLI's own id for the row.
* @returns the alias to advertise.
*/
function claudeModelAlias(value) {
	const wide = WIDE_ROUTE.test(value);
	const bare = value.replace(WIDE_ROUTE, "").replace(/^claude-/u, "");
	const family = bare.split("-").find((segment) => !/^\d+$/u.test(segment)) ?? bare;
	return wide ? `${family}[1m]` : family;
}
function projectModel(row, id) {
	const contextWindow = declaredContextWindow(row);
	return {
		id,
		value: row.value,
		name: row.displayName,
		description: row.description,
		...contextWindow === void 0 ? {} : { contextWindow },
		...row.supportsAutoMode === void 0 ? {} : { supportsAutoMode: row.supportsAutoMode }
	};
}
let latest;
let inflight;
/**
* Learn the lineup from one session's initialize response.
* @param models - the CLI's own `/model` rows; an empty list is ignored so a
*   CLI that answers without a catalog cannot blank the selector.
*/
/**
* The stable aliases, kept in the selector whatever this CLI release lists.
*
* The `/model` lineup is not stable across releases: 2.1.280 named Opus only
* as `opus[1m]`, 2.1.283 only as `opus`. DSH persists a selection as a row id
* and prints the raw `claude/<id>` for one no row carries, so a lineup that
* drops an alias strands every session and profile default that picked it.
* The seed aliases are spellings every release accepts, so they stay
* selectable -- after the lineup's own rows, under the seed's names.
* ponytail: the seed is the whole memory; an alias a future release adds and
* a later one drops would need remembered history.
*/
function withStableAliases(rows) {
	const listed = new Set(rows.map((row) => row.id));
	return [...rows, ...SEED.filter((row) => !listed.has(row.id))];
}
/** Ids a concrete CLI id must not claim: the lineup's own alias rows and the
*  stable aliases, whose meaning a persisted selection depends on. */
function reservedAliases(models) {
	const reserved = new Set(SEED.map((row) => row.id));
	for (const row of models) if (claudeModelAlias(row.value) === row.value) reserved.add(row.value);
	return reserved;
}
function recordClaudeModels(models) {
	if (models.length === 0) return;
	const taken = /* @__PURE__ */ new Set();
	const reserved = reservedAliases(models);
	latest = withStableAliases(models.map((row) => {
		const alias = claudeModelAlias(row.value);
		const concrete = alias !== row.value;
		const id = taken.has(alias) || concrete && reserved.has(alias) ? row.value : alias;
		taken.add(id);
		return projectModel(row, id);
	}));
}
/** The lineup to advertise: whatever the CLI last reported, else the seed. */
/** Whether the catalog is the CLI's reported lineup rather than the seed. */
function claudeLineupKnown() {
	return latest !== void 0;
}
function latestClaudeModels() {
	return latest ?? SEED;
}
/** A throwaway probe should not outlive a wedged CLI. */
const CLAUDE_MODEL_PROBE_TIMEOUT_MS = 2e4;
/**
* Read the lineup from a throwaway CLI process.
*
* Waiting for a session to start is too late: DSH loads the model catalog once
* per Host generation, at connect, and does not reload it when this plugin
* later learns the real lineup. A selector left on the seed until then hands
* out seed ids, which is exactly how a session ends up persisting an id the
* next launch cannot resolve. This query carries no tools, no permission
* bridge and no session binding: it starts, reports what `/model` would show,
* and is killed -- no prompt is ever sent, so it costs no tokens.
* @param executablePath - the resolved CLI, or '' to let the SDK find it.
* @param factory - test seam for the SDK query.
* @returns the CLI's own `/model` rows.
*/
async function probeClaudeModels(executablePath, factory = query) {
	const lifetime = new AbortController();
	const timer = setTimeout(() => lifetime.abort(), CLAUDE_MODEL_PROBE_TIMEOUT_MS);
	timer.unref?.();
	const query$1 = factory({
		prompt: (async function* () {
			await new Promise(() => {});
		})(),
		options: {
			cwd: process.cwd(),
			abortController: lifetime,
			...executablePath.length === 0 ? {} : { pathToClaudeCodeExecutable: executablePath }
		}
	});
	try {
		(async () => {
			for await (const _ of query$1);
		})().catch(() => void 0);
		return (await Promise.race([query$1.initializationResult(), new Promise((_resolve, reject) => {
			setTimeout(() => reject(/* @__PURE__ */ new Error("dsh-claude: the model lineup probe did not answer in time")), CLAUDE_MODEL_PROBE_TIMEOUT_MS).unref?.();
		})])).models;
	} finally {
		clearTimeout(timer);
		lifetime.abort();
	}
}
/**
* The lineup, learning it from the CLI the first time DSH asks for the catalog.
* @param probe - reads the CLI's rows; a failure leaves the seed in place and
*   is retried on the next catalog load.
* @returns the rows to advertise, never rejecting.
*/
function ensureClaudeModels(probe) {
	if (latest !== void 0) return Promise.resolve(latest);
	inflight ??= probe().then((models) => {
		recordClaudeModels(models);
	}).catch(() => void 0).then(() => {
		inflight = void 0;
		return latestClaudeModels();
	});
	return inflight;
}
/**
* Look one id up in the current lineup.
* @param id - the id DSH persisted on the session, which may be an alias, a
*   concrete CLI id persisted before this plugin aliased anything, or a row the
*   running CLI no longer lists.
* @returns the row, or undefined when the lineup does not cover the id.
*/
function claudeModelRow(id) {
	const rows = latestClaudeModels();
	return rows.find((row) => row.id === id) ?? rows.find((row) => row.value === id) ?? rows.find((row) => row.id === claudeModelAlias(id)) ?? rows.find((row) => row.name === id);
}
/**
* The selector id DSH should persist for a model it is about to record.
*
* DSH matches a persisted selection to a catalog row by exact id and prints
* the raw `provider/model` for one no row carries. Whatever the lineup can map
* -- a concrete CLI id (`claude-fable-5-1[1m]`), a version-bumped one, a row's
* own id -- is written back as that row's id, so the next header and the
* profile default carry a spelling the selector can show. An id the lineup
* does not cover is returned unchanged: it still dispatches, and a guess would
* change which model runs.
*/
function canonicalClaudeModelId(id) {
	return claudeModelRow(id)?.id ?? id;
}
/**
* The spelling to hand the CLI for one selector id.
* @param id - the id DSH persisted on the session.
* @returns the CLI's own id, or the selector id itself when the lineup does not
*   cover it -- the seed vocabulary is made of spellings the CLI accepts, and a
*   session persisted before this plugin aliased anything already holds one.
*/
function claudeModelValue(id) {
	return claudeModelRow(id)?.value ?? id;
}
//#endregion
export { ensureClaudeModels as a, recordClaudeModels as c, dynamicPresenterDefinition as d, CLAUDE_COMMANDS_SERVICE as f, claudeModelValue as i, CLAUDE_PRESENTER_NAMES as l, claudeLineupKnown as n, latestClaudeModels as o, projectClaudeCommands as p, claudeModelRow as r, probeClaudeModels as s, canonicalClaudeModelId as t, claudePresenterDefinitions as u };

//# sourceMappingURL=model-catalog-Bz0PxsFj.mjs.map