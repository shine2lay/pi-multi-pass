// mine/chatgpt-limit-continue: pi's own retry classifier, isRetryableAssistantError, from the pi on PATH
// (its @earendil-works/pi-ai dist/utils/retry.js, which has no imports). Checks that run the real multi-sub.ts
// in a VM put it in the context, so piWillRetryTurn decides with the classifier pi itself uses.
// Throws, naming what is missing, when pi or its pi-ai can't be found.
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function commandOnPath(command) {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = dir ? path.join(dir, command) : "";
		if (candidate && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return fs.realpathSync(candidate);
	}
	throw new Error(`${command} is not on PATH: the checks load pi's retry classifier from the installed pi`);
}

function piPackageDir(cli) {
	for (let dir = path.dirname(cli); dir !== path.dirname(dir); dir = path.dirname(dir)) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === PI_PACKAGE) return dir;
	}
	throw new Error(`no ${PI_PACKAGE} package above ${cli}`);
}

function retryModulePath() {
	const piDir = piPackageDir(commandOnPath("pi"));
	// pi-ai sits under pi-coding-agent (npm install -g) or next to it (hoisted).
	for (const piAi of [path.join(piDir, "node_modules/@earendil-works/pi-ai"), path.join(path.dirname(piDir), "pi-ai")]) {
		const file = path.join(piAi, "dist/utils/retry.js");
		if (fs.existsSync(file)) return file;
	}
	throw new Error(`no @earendil-works/pi-ai dist/utils/retry.js for the pi at ${piDir}`);
}

const retry = await import(pathToFileURL(retryModulePath()).href);
if (typeof retry.isRetryableAssistantError !== "function") {
	throw new Error("pi-ai dist/utils/retry.js exports no isRetryableAssistantError function");
}

export const { isRetryableAssistantError } = retry;
