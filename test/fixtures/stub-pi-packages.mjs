/**
 * Minimal stand-ins for the pi packages, so index.ts can be imported in unit
 * tests without the real pi runtime (used by test/child-warning.test.mjs,
 * which redirects the package specifiers here via a module resolve hook).
 *
 * Only the names imported at module level by index.ts / render.ts / types.ts
 * are provided; the values are never actually used by the tests.
 */
export const Type = {
	Object: (v) => v,
	String: (v) => v,
	Number: (v) => v,
	Optional: (v) => v,
};

export function getMarkdownTheme() {
	return {};
}

export class Container {}
export class Markdown {}
export class Spacer {}
export class Text {}
