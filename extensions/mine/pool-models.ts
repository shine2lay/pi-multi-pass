/**
 * mine/antigravity-chain-entries: the model ids a pool can pick (PATCHES.md).
 *
 * pi-ai's built-in catalog lists only pi-ai's own providers. A provider another extension adds
 * (pi-antigravity's "antigravity", through pi.registerProvider) exists only in pi's live model
 * registry, so upstream's built-in-only list left every Antigravity chain entry "invalid model: no
 * selectable models" and the chain never moved a chat there. A pool's models are therefore the
 * built-in ones for its base provider, then the registry's models whose provider is the base
 * provider or a member, each id once. The registry is read on every call, never cached: an
 * extension may register its provider after multi-pass loads.
 *
 * The registry is always the handling chat's, passed in by the caller: the module is loaded once for
 * every chat of a folder, so a stored registry would be some other chat's, and stale (it throws) once
 * that chat's session is replaced (Ops #769).
 *
 * No registry (an older pi, or a host without one) -> built-in models only, with one plain warning;
 * models are never guessed.
 */

/** The part of pi's ModelRegistry this needs: every model pi knows now, extension providers included. */
export interface RegisteredModelSource {
	getAll(): ReadonlyArray<{ provider?: unknown; id?: unknown }>;
}

/** The part of a pool this reads. */
export interface PoolModelScope {
	name?: string;
	baseProvider: string;
	members: readonly string[];
}

export const NO_REGISTRY_WARNING =
	"multi-pass: pi's model registry is not available, so pools list only pi-ai's built-in models; "
	+ "chain entries on a provider an extension adds (such as antigravity) read as invalid and are skipped.";

export class PoolModelCatalog {
	private readonly builtinIds: (provider: string) => readonly string[];
	private readonly warn: (message: string) => void;
	private warned = false;

	/** builtinIds: pi-ai's built-in model ids for a provider ([] when it has none). warn: where the one warning goes. */
	constructor(builtinIds: (provider: string) => readonly string[], warn: (message: string) => void) {
		if (typeof builtinIds !== "function") throw new TypeError("PoolModelCatalog needs builtinIds(provider)");
		if (typeof warn !== "function") throw new TypeError("PoolModelCatalog needs warn(message)");
		this.builtinIds = builtinIds;
		this.warn = warn;
	}

	/**
	 * The ids the pool can pick: built-in first, then registry-only ones, each once. registry: the model
	 * registry of the chat this is for, or undefined when it has none (built-in only, one warning).
	 */
	modelIds(pool: PoolModelScope, registry: RegisteredModelSource | undefined): string[] {
		if (arguments.length < 2) {
			throw new TypeError("PoolModelCatalog.modelIds needs the chat's model registry (undefined when it has none)");
		}
		if (!pool || typeof pool.baseProvider !== "string" || pool.baseProvider.length === 0) {
			throw new TypeError(`pool ${JSON.stringify(pool?.name ?? "")} needs a baseProvider to list its models`);
		}
		if (!Array.isArray(pool.members)) {
			throw new TypeError(`pool ${JSON.stringify(pool.name ?? pool.baseProvider)} needs a members list to list its models`);
		}
		const ids = new Set<string>(this.builtinIds(pool.baseProvider));
		if (!registry || typeof registry.getAll !== "function") {
			if (!this.warned) {
				this.warned = true;
				this.warn(NO_REGISTRY_WARNING);
			}
			return [...ids];
		}
		const models = registry.getAll();
		if (!Array.isArray(models)) throw new TypeError("multi-pass: pi's model registry getAll() did not return a list");
		const providers = new Set<string>([pool.baseProvider, ...pool.members]);
		for (const model of models) {
			if (typeof model?.provider === "string" && typeof model.id === "string" && providers.has(model.provider)) {
				ids.add(model.id);
			}
		}
		return [...ids];
	}
}
