// ESLint des Module-Repos = Konfiguration des Core (Modulgrenzen, Core-Interna, Svelte/TS-Regeln),
// Muster relativ zu diesem Ordner. Umgebung zuerst setzen, dann die Core-Konfiguration laden.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.env.ATRIUM_ESLINT_ROOT = root;
process.env.ATRIUM_MODULES_DIR ??= join(root, 'modules');

const core = (await import('./.core/eslint.config.js')).default;

/**
 * Mit nur einem Modul im Verzeichnis erzeugt der Core für „relative Importe in andere Module“ ein Muster mit
 * leerer `group`-Liste, das ESLint als ungültige Konfiguration ablehnt. Solche leeren Muster entfernen
 * (es gibt dann ohnehin keine fremden Module, in die man relativ importieren könnte).
 */
function dropEmptyImportPatterns(config) {
	const rule = config.rules?.['@typescript-eslint/no-restricted-imports'];
	if (!Array.isArray(rule)) return config;
	const [level, ...options] = rule;
	const fixed = options.map((o) =>
		o && Array.isArray(o.patterns)
			? { ...o, patterns: o.patterns.filter((p) => !Array.isArray(p.group) || p.group.length > 0) }
			: o
	);
	return {
		...config,
		rules: { ...config.rules, '@typescript-eslint/no-restricted-imports': [level, ...fixed] }
	};
}

export default [
	...core.map(dropEmptyImportPatterns),
	{ ignores: ['.core/', 'modules/node_modules/', '.data/', 'test-results/', 'playwright-report/'] }
];
