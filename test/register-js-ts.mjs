/**
 * Test-only module resolution hook.
 *
 * Source files use TypeScript NodeNext-style specifiers (e.g. "./types.js"
 * for the file types.ts). Plain `node --test` cannot resolve those, so map
 * a missing relative ".js" module to its ".ts" source file when it exists.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (err) {
			const isRelativeJs =
				err?.code === "ERR_MODULE_NOT_FOUND" &&
				specifier.endsWith(".js") &&
				(specifier.startsWith("./") || specifier.startsWith("../"));
			if (!isRelativeJs || !context.parentURL) throw err;
			const tsSpecifier = specifier.slice(0, -".js".length) + ".ts";
			try {
				if (existsSync(fileURLToPath(new URL(tsSpecifier, context.parentURL)))) {
					return nextResolve(tsSpecifier, context);
				}
			} catch {
				/* fall through to the original error */
			}
			throw err;
		}
	},
});
