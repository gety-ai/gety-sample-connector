/**
 * Keeps package.json in sync with manifest.json, the single source of the
 * connector's metadata. Gety reads the manifest of an npm package from the
 * `gety` object of its package.json, so this script copies the whole manifest
 * there and derives `version`, `description` and `files` from it; the other
 * fields of package.json are left as they are.
 *
 *   deno task sync         write the derived fields
 *   deno task sync:check   fail when package.json is out of date or a file it
 *                          publishes is missing (runs before `npm publish`)
 */

interface Manifest {
	version: string;
	description?: string;
	entry: string;
	icon?: string;
}

const root = new URL('../', import.meta.url);
const packageUrl = new URL('package.json', root);

if (import.meta.main) {
	const check = Deno.args.includes('--check');
	const manifest: Manifest = JSON.parse(
		await Deno.readTextFile(new URL('manifest.json', root)),
	);
	const text = await Deno.readTextFile(packageUrl);
	const pkg: Record<string, unknown> = JSON.parse(text);

	pkg.version = manifest.version;
	pkg.description = (manifest.description ?? '').split(/\r?\n/)[0].trim();
	// Once `files` is set, npm packs only those files (plus package.json, the
	// README and a license): the entry and everything it loads at run time, and
	// CHANGELOG.md, which Gety shows as release notes. A manifest.json in the
	// package is not read.
	const files = [
		manifest.entry,
		`${manifest.entry}.map`,
		...(manifest.icon ? [manifest.icon] : []),
		'CHANGELOG.md',
	].map((path) => path.replace(/^\.\//, ''));
	pkg.files = files;
	pkg.gety = manifest;
	const synced = `${JSON.stringify(pkg, null, '\t')}\n`;

	if (check) {
		const errors: string[] = [];
		if (synced !== text) {
			errors.push(
				'package.json is out of date with manifest.json; run `deno task sync`',
			);
		}
		for (const file of files) {
			try {
				await Deno.stat(new URL(file, root));
			} catch (error) {
				if (!(error instanceof Deno.errors.NotFound)) {
					throw error;
				}
				errors.push(`${file} is missing; run \`deno task build\``);
			}
		}
		for (const error of errors) {
			console.error(`error: ${error}`);
		}
		Deno.exit(errors.length > 0 ? 1 : 0);
	}
	if (synced !== text) {
		await Deno.writeTextFile(packageUrl, synced);
		console.log('synced package.json');
	}
}
