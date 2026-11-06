/**
 * The Deno command line Gety launches a connector poll with, ported from the
 * Gety host so dev/runner.ts runs connectors under the same sandbox:
 *
 * - `parsePermissions`: libs/gety-deno-connectors/src/permissions/parse.rs
 * - `deriveLaunch`: libs/gety-deno-connectors/src/launch.rs, with the
 *   `config_field` resolution of permissions/derive.rs and the base grants of
 *   permissions/report.rs
 *
 * vendor/gety-deno/SOURCE.json records the hashes of those files;
 * `deno task sync-sdk` reports when they change.
 */

export type PermissionOs = 'macos' | 'windows' | 'linux';

const OS_ORDER: PermissionOs[] = ['macos', 'windows', 'linux'];

export type NetGrant =
	| { kind: 'any' }
	| { kind: 'host'; host: string; port: number | null }
	| { kind: 'domain'; suffix: string }
	| { kind: 'config_field'; field: string };

export type ReadGrant =
	| { kind: 'home'; rel: string; os: PermissionOs[] | null }
	| { kind: 'config_field'; field: string };

/** Sandbox grants, each list sorted and deduplicated as the host's sets are. */
export interface PermissionSet {
	net: NetGrant[];
	read: ReadGrant[];
	env: string[];
	run: string[];
}

export type ParsedPermissions = 'unrestricted' | PermissionSet;

export interface ConfigField {
	id: string;
	type: string;
}

export interface LaunchPaths {
	/** Runtime root holding host/runner.ts and the SDK. */
	runtime: string;
	runnerTs: string;
	importMap: string;
	/** Connector code directory and its entry, relative to it. */
	code: string;
	entryRel: string;
	/** Persistent data directory; also the working directory. */
	data: string;
	/** This session's temp directory. */
	tmp: string;
	denoDir: string;
	home: string;
}

export interface HostEnv {
	path?: string;
	/** Names of every host environment variable. */
	names: string[];
}

export interface LaunchPlan {
	/** Arguments after the `deno` binary. */
	args: string[];
	envSet: [string, string][];
	envRemove: string[];
	cwd: string;
}

/** A `config_field` value that cannot be granted (a configuration error). */
export class DerivedValueError extends Error {
	constructor(field: string, reason: string) {
		super(`config field \`${field}\` ${reason}`);
		this.name = 'DerivedValueError';
	}
}

/** `Deno.*` system-information APIs every sandboxed connector may use. */
const SYSTEM_INFO_APIS = [
	'homedir',
	'cpus',
	'systemMemoryInfo',
	'osRelease',
	'osUptime',
	'loadavg',
	'statfs',
];

/** Environment variables that point at the session temp directory. */
const TMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'];

/** Appended to `PATH` on macOS when missing (Finder starts apps without Homebrew). */
const MACOS_EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];

const PERMISSION_KEYS = ['net', 'read', 'env', 'run'];
const MAX_HOST_NAME_LEN = 253;
const MAX_LABEL_LEN = 63;
const NET_FORMS =
	'expected "*", "host", "host:port", "*.domain", an IPv4 address or "[IPv6]"';

/**
 * Validate a manifest `permissions` value against the manifest's config
 * fields. A missing value or `"unrestricted"` means full privileges; an
 * explicit `null` is invalid, as in Gety. Throws
 * with the host's `permissions.<key>[<index>]: <problem>` messages.
 */
export function parsePermissions(
	raw: unknown,
	fields: ConfigField[],
): ParsedPermissions {
	if (raw === undefined || raw === 'unrestricted') {
		return 'unrestricted';
	}
	if (!isPlainObject(raw)) {
		throw invalid(
			'permissions',
			`expected "unrestricted" or an object, got ${JSON.stringify(raw)}`,
		);
	}
	for (const [key, entries] of Object.entries(raw)) {
		if (!PERMISSION_KEYS.includes(key)) {
			throw invalid(
				`permissions.${key}`,
				'unknown key; allowed keys are net, read, env, run',
			);
		}
		if (!Array.isArray(entries)) {
			throw invalid(`permissions.${key}`, 'expected an array');
		}
		entries.forEach((entry, index) =>
			checkEntryShape(key, `permissions.${key}[${index}]`, entry)
		);
	}

	// Shapes are valid from here on; the checks below only narrow the types.
	const set: PermissionSet = { net: [], read: [], env: [], run: [] };
	const entries = (key: string): unknown[] => {
		const list = raw[key];
		return Array.isArray(list) ? list : [];
	};
	entries('net').forEach((entry, index) => {
		const path = `permissions.net[${index}]`;
		const field = fieldRef(entry);
		if (typeof entry === 'string') {
			set.net.push(parseOrThrow(path, () => parseNetLiteral(entry)));
		} else if (field != null) {
			checkFieldRef(path, field, 'text', fields);
			set.net.push({ kind: 'config_field', field });
		}
	});
	entries('read').forEach((entry, index) => {
		const path = `permissions.read[${index}]`;
		const field = fieldRef(entry);
		if (typeof entry === 'string') {
			const rel = parseOrThrow(path, () => parseHomePath(entry));
			set.read.push({ kind: 'home', rel, os: null });
		} else if (field != null) {
			checkFieldRef(path, field, 'directory', fields);
			set.read.push({ kind: 'config_field', field });
		} else if (
			isPlainObject(entry) && typeof entry.path === 'string' &&
			Array.isArray(entry.os)
		) {
			const scopedPath = entry.path;
			const rel = parseOrThrow(`${path}.path`, () => parseHomePath(scopedPath));
			const listed: unknown[] = entry.os;
			const os = OS_ORDER.filter((name) => listed.includes(name));
			set.read.push({ kind: 'home', rel, os });
		}
	});
	entries('env').forEach((name, index) => {
		if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw invalid(
				`permissions.env[${index}]`,
				`${
					JSON.stringify(name)
				} is not a variable name (expected ^[A-Za-z_][A-Za-z0-9_]*$)`,
			);
		}
		set.env.push(name);
	});
	entries('run').forEach((name, index) => {
		const path = `permissions.run[${index}]`;
		if (typeof name !== 'string' || /[/\\]/.test(name)) {
			throw invalid(
				path,
				`${
					JSON.stringify(name)
				} must be a program name without path separators`,
			);
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
			throw invalid(
				path,
				`${
					JSON.stringify(name)
				} is not a program name (expected ^[A-Za-z0-9][A-Za-z0-9._+-]*$)`,
			);
		}
		set.run.push(name);
	});

	return {
		net: sortedUnique(set.net, compareNet),
		read: sortedUnique(set.read, compareRead),
		env: sortedUnique(set.env, compareStrings),
		run: sortedUnique(set.run, compareStrings),
	};
}

/**
 * Arguments, environment changes and working directory of one poll, as the
 * host derives them. Throws {@link DerivedValueError} when a `config_field`
 * value cannot be granted.
 */
export function deriveLaunch(
	permissions: ParsedPermissions,
	config: unknown,
	paths: LaunchPaths,
	env: HostEnv,
	os: PermissionOs,
): LaunchPlan {
	const args = ['run'];
	if (permissions === 'unrestricted') {
		args.push('--allow-all', '--no-prompt', '--no-config');
		args.push(`--import-map=${paths.importMap}`);
	} else {
		args.push('--no-prompt', '--no-config', '--no-remote', '--no-npm');
		args.push(`--import-map=${paths.importMap}`);
		args.push(...sandboxGrants(permissions, config, paths, os));
	}
	args.push(paths.runnerTs, paths.code, paths.entryRel);

	const envSet: [string, string][] = [['DENO_DIR', paths.denoDir]];
	for (const name of TMP_ENV_VARS) {
		envSet.push([name, paths.tmp]);
	}
	if (os === 'macos') {
		envSet.push(['PATH', macosPath(env.path)]);
	}
	// Deno refuses to spawn allow-listed programs while any of these is set.
	const envRemove = permissions !== 'unrestricted' && permissions.run.length > 0
		? env.names.filter((name) =>
			name.startsWith('LD_') || name.startsWith('DYLD_')
		)
		: [];

	return { args, envSet, envRemove, cwd: paths.data };
}

function sandboxGrants(
	set: PermissionSet,
	config: unknown,
	paths: LaunchPaths,
	os: PermissionOs,
): string[] {
	const data = pathEntry(paths.data, os);
	const tmp = pathEntry(paths.tmp, os);
	const read = [
		pathEntry(paths.runtime, os),
		pathEntry(paths.code, os),
		data,
		tmp,
	];
	const write = [data, tmp];
	for (const grant of set.read) {
		if (grant.kind === 'home') {
			if (grant.os != null && !grant.os.includes(os)) {
				continue;
			}
			const separator = os === 'windows' ? '\\' : '/';
			const segments = grant.rel.split('/').filter((segment) => segment !== '');
			const path = [hostPath(paths.home, os), ...segments].join(separator);
			read.push(path.replaceAll(',', ',,'));
		} else {
			const value = deriveReadValue(grant.field, config, os);
			if (value != null) {
				read.push(pathEntry(value, os));
			}
		}
	}
	const args = [
		`--allow-read=${read.join(',')}`,
		`--allow-write=${write.join(',')}`,
		`--allow-env=${[...TMP_ENV_VARS, ...set.env].join(',')}`,
		'--ignore-env',
		`--allow-sys=${SYSTEM_INFO_APIS.join(',')}`,
	];
	const hosts = grantedHosts(set, config);
	if (hosts == null) {
		args.push('--allow-net');
	} else if (hosts.length > 0) {
		// Deno rejects an empty list, so a declaration that resolves to no host
		// grants no network at all.
		args.push(`--allow-net=${hosts.join(',')}`);
	}
	if (set.run.length > 0) {
		args.push(`--allow-run=${set.run.join(',')}`);
	}
	return args;
}

/** Hosts `set.net` grants under `config`; `null` means any host. */
function grantedHosts(set: PermissionSet, config: unknown): string[] | null {
	if (set.net.some((grant) => grant.kind === 'any')) {
		return null;
	}
	const hosts: string[] = [];
	for (const grant of set.net) {
		if (grant.kind === 'config_field') {
			const host = deriveNetValue(grant.field, config);
			if (host != null) {
				hosts.push(host);
			}
		} else {
			hosts.push(netGrantText(grant));
		}
	}
	return hosts;
}

/**
 * The trimmed string value of a (dotted) config field; `null` when absent,
 * not a string, or blank.
 */
function configString(config: unknown, field: string): string | null {
	let value = config;
	for (const part of field.split('.')) {
		if (!isPlainObject(value)) {
			return null;
		}
		value = value[part];
	}
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

function deriveNetValue(field: string, config: unknown): string | null {
	const value = configString(config, field);
	if (value == null) {
		return null;
	}
	if (value.includes('*')) {
		throw new DerivedValueError(field, 'must not contain a wildcard');
	}
	const schemeEnd = value.indexOf('://');
	let authority = value;
	if (schemeEnd !== -1) {
		authority = value.slice(schemeEnd + 3).split(/[/?#]/)[0];
		authority = authority.slice(authority.lastIndexOf('@') + 1);
	}
	try {
		const grant = parseNetLiteral(authority.toLowerCase());
		if (grant.kind === 'host') {
			return netGrantText(grant);
		}
	} catch {
		// Reported below with the host's wording.
	}
	throw new DerivedValueError(
		field,
		'must be a URL or host name, such as https://example.com or example.com:8443',
	);
}

function deriveReadValue(
	field: string,
	config: unknown,
	os: PermissionOs,
): string | null {
	const value = configString(config, field);
	if (value == null) {
		return null;
	}
	const absolute = os === 'windows'
		? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') ||
			value.startsWith('//')
		: value.startsWith('/');
	if (!absolute) {
		throw new DerivedValueError(field, 'must be an absolute path');
	}
	return value;
}

function parseNetLiteral(value: string): NetGrant {
	if (value === '*') {
		return { kind: 'any' };
	}
	const schemeEnd = value.indexOf('://');
	if (schemeEnd !== -1) {
		const authority = value.slice(schemeEnd + 3).split(/[/?#]/)[0];
		const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
		throw `${JSON.stringify(value)} must be a host, not a URL; write ${
			JSON.stringify(host)
		}`;
	}
	if (/[/?#@]/.test(value)) {
		const prefix = value.split(/[/?#]/)[0];
		const host = prefix.slice(prefix.lastIndexOf('@') + 1);
		throw `${
			JSON.stringify(value)
		} must be a host without a path or user info; write ${
			JSON.stringify(host)
		}`;
	}
	if (value.startsWith('*.')) {
		const suffix = value.slice(2);
		if (suffix.includes(':')) {
			throw `${
				JSON.stringify(value)
			}: wildcard domains match any port and cannot have one`;
		}
		checkHostName(value, suffix);
		return { kind: 'domain', suffix };
	}
	if (value.startsWith('[')) {
		const close = value.indexOf(']');
		if (close === -1) {
			throw `${JSON.stringify(value)}: missing "]" after the IPv6 address`;
		}
		const address = value.slice(1, close);
		const after = value.slice(close + 1);
		const host = canonicalIpv6(address);
		if (host == null) {
			throw `${JSON.stringify(value)}: ${
				JSON.stringify(address)
			} is not an IPv6 address`;
		}
		if (after === '') {
			return { kind: 'host', host, port: null };
		}
		if (!after.startsWith(':')) {
			throw `${JSON.stringify(value)}; ${NET_FORMS}`;
		}
		return { kind: 'host', host, port: parsePort(value, after.slice(1)) };
	}
	if (value.split(':').length > 2) {
		throw `${
			JSON.stringify(value)
		}: IPv6 addresses must be written in brackets, e.g. "[::1]" or "[::1]:8080"`;
	}
	const colon = value.indexOf(':');
	const host = colon === -1 ? value : value.slice(0, colon);
	const port = colon === -1 ? null : parsePort(value, value.slice(colon + 1));
	if (
		/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
			.test(host)
	) {
		return { kind: 'host', host, port };
	}
	checkHostName(value, host);
	return { kind: 'host', host, port };
}

/**
 * Bracketed canonical form of an IPv6 address, or `null` if it is not one.
 * Rust prints IPv4-mapped addresses in dotted form (`::ffff:1.2.3.4`) where
 * the URL parser prints hex; nothing else differs.
 */
function canonicalIpv6(address: string): string | null {
	if (!/^[0-9A-Fa-f:.]+$/.test(address)) {
		return null;
	}
	try {
		return new URL(`http://[${address}]/`).hostname;
	} catch {
		return null;
	}
}

function parsePort(value: string, port: string): number {
	const parsed = Number(port);
	if (
		/^[1-9]\d*$/.test(port) && Number.isInteger(parsed) && parsed <= 65535
	) {
		return parsed;
	}
	throw `${JSON.stringify(value)}: port ${
		JSON.stringify(port)
	} must be a number from 1 to 65535`;
}

function checkHostName(value: string, host: string): void {
	if (/[^\p{ASCII}]/u.test(host)) {
		throw `${
			JSON.stringify(value)
		}: internationalized domain names must be written in punycode (xn--...)`;
	}
	if (/[A-Z]/.test(host)) {
		throw `${JSON.stringify(value)}: host names must be lowercase; write ${
			JSON.stringify(value.toLowerCase())
		}`;
	}
	const labelsOk = host !== '' && host.length <= MAX_HOST_NAME_LEN &&
		host.split('.').every((label) =>
			label !== '' && label.length <= MAX_LABEL_LEN &&
			!label.startsWith('-') && !label.endsWith('-') &&
			/^[a-z0-9-]+$/.test(label)
		);
	if (!labelsOk) {
		throw `${JSON.stringify(value)} is not a valid host; ${NET_FORMS}`;
	}
}

function parseHomePath(value: string): string {
	if (value === '~') {
		return '';
	}
	if (!value.startsWith('~/')) {
		const looksAbsolute = /^[/\\]/.test(value) || /^[A-Za-z]:/.test(value);
		throw looksAbsolute
			? `${
				JSON.stringify(value)
			} is an absolute path; use a path under "~" or a directory config field`
			: `${JSON.stringify(value)} must be "~" or start with "~/"`;
	}
	const rest = value.slice(2).replace(/\/$/, '');
	if (rest === '') {
		return '';
	}
	for (const segment of rest.split('/')) {
		if (
			segment === '' || segment === '.' || segment === '..' ||
			segment.includes('\\')
		) {
			throw `${JSON.stringify(value)} has an invalid path segment ${
				JSON.stringify(segment)
			}; segments must be non-empty, not "." or "..", and use "/" as the separator`;
		}
	}
	return rest;
}

/** The field id of a `{ "config_field": "<id>" }` entry, else `null`. */
function fieldRef(entry: unknown): string | null {
	return isPlainObject(entry) && Object.keys(entry).length === 1 &&
			typeof entry.config_field === 'string'
		? entry.config_field
		: null;
}

function checkEntryShape(key: string, path: string, entry: unknown): void {
	const isFieldRef = fieldRef(entry) != null;
	if (key === 'net') {
		if (typeof entry !== 'string' && !isFieldRef) {
			throw invalid(
				path,
				`expected a host string or { "config_field": "<id>" }, got ${
					JSON.stringify(entry)
				}`,
			);
		}
		return;
	}
	if (key !== 'read') {
		if (typeof entry !== 'string') {
			throw invalid(path, `expected a string, got ${JSON.stringify(entry)}`);
		}
		return;
	}
	if (typeof entry === 'string' || isFieldRef) {
		return;
	}
	const expected =
		'expected a path string, { "path": "<path>", "os": [...] } or { "config_field": "<id>" }';
	const keys = isPlainObject(entry) ? Object.keys(entry).sort() : [];
	if (
		!isPlainObject(entry) || keys.join() !== 'os,path' ||
		typeof entry.path !== 'string'
	) {
		throw invalid(path, `${expected}, got ${JSON.stringify(entry)}`);
	}
	if (!Array.isArray(entry.os)) {
		throw invalid(`${path}.os`, 'expected an array');
	}
	if (entry.os.length === 0) {
		throw invalid(
			`${path}.os`,
			'must list at least one of macos, windows, linux',
		);
	}
	entry.os.forEach((os: unknown, index: number) => {
		if (!OS_ORDER.some((name) => name === os)) {
			throw invalid(
				`${path}.os[${index}]`,
				`unknown os ${JSON.stringify(os)}; expected macos, windows or linux`,
			);
		}
	});
}

function checkFieldRef(
	path: string,
	fieldId: string,
	expected: 'text' | 'directory',
	fields: ConfigField[],
): void {
	const field = fields.find((candidate) => candidate.id === fieldId);
	if (field == null) {
		throw invalid(
			path,
			`config field ${
				JSON.stringify(fieldId)
			} is not declared in config.fields`,
		);
	}
	if (field.type === 'password') {
		throw invalid(
			path,
			`must not reference password field ${
				JSON.stringify(fieldId)
			}; its value would be shown in the permission dialog`,
		);
	}
	if (field.type !== expected) {
		throw invalid(
			path,
			`config field ${JSON.stringify(fieldId)} must be a ${expected} field`,
		);
	}
}

function parseOrThrow<T>(path: string, parse: () => T): T {
	try {
		return parse();
	} catch (detail) {
		throw invalid(path, String(detail));
	}
}

function invalid(path: string, detail: string): Error {
	return new Error(`invalid permissions: ${path}: ${detail}`);
}

function netGrantText(grant: NetGrant): string {
	switch (grant.kind) {
		case 'any':
			return '*';
		case 'host':
			return grant.port == null ? grant.host : `${grant.host}:${grant.port}`;
		case 'domain':
			return `*.${grant.suffix}`;
		case 'config_field':
			return `{ config_field: ${grant.field} }`;
	}
}

/** A path as a Deno permission list entry: commas escaped as `,,`. */
function pathEntry(path: string, os: PermissionOs): string {
	return hostPath(path, os).replaceAll(',', ',,');
}

/** Windows verbatim prefixes removed: `\\?\C:\x` → `C:\x`, `\\?\UNC\s\x` → `\\s\x`. */
function hostPath(path: string, os: PermissionOs): string {
	if (os !== 'windows') {
		return path;
	}
	if (path.startsWith('\\\\?\\UNC\\')) {
		return `\\\\${path.slice(8)}`;
	}
	if (path.startsWith('\\\\?\\') && path[5] === ':') {
		return path.slice(4);
	}
	return path;
}

function macosPath(host: string | undefined): string {
	let path = host ?? '';
	const present = path.split(':');
	for (const dir of MACOS_EXTRA_PATH) {
		if (!present.includes(dir)) {
			path = path === '' ? dir : `${path}:${dir}`;
		}
	}
	return path;
}

// Orderings of the host's `BTreeSet`s (derived `Ord` of the Rust enums), so
// list arguments come out in the same order.

const NET_KIND_ORDER = ['any', 'host', 'domain', 'config_field'];

function compareNet(a: NetGrant, b: NetGrant): number {
	if (a.kind !== b.kind) {
		return NET_KIND_ORDER.indexOf(a.kind) - NET_KIND_ORDER.indexOf(b.kind);
	}
	if (a.kind === 'host' && b.kind === 'host') {
		return compareStrings(a.host, b.host) ||
			(a.port ?? -1) - (b.port ?? -1);
	}
	return compareStrings(netGrantText(a), netGrantText(b));
}

function compareRead(a: ReadGrant, b: ReadGrant): number {
	if (a.kind === 'home' && b.kind === 'home') {
		return compareStrings(a.rel, b.rel) || compareOsSets(a.os, b.os);
	}
	if (a.kind === 'config_field' && b.kind === 'config_field') {
		return compareStrings(a.field, b.field);
	}
	return a.kind === 'home' ? -1 : 1;
}

function compareOsSets(
	a: PermissionOs[] | null,
	b: PermissionOs[] | null,
): number {
	if (a == null || b == null) {
		return (a == null ? 0 : 1) - (b == null ? 0 : 1);
	}
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		const order = OS_ORDER.indexOf(a[index]) - OS_ORDER.indexOf(b[index]);
		if (order !== 0) {
			return order;
		}
	}
	return a.length - b.length;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique<T>(items: T[], compare: (a: T, b: T) => number): T[] {
	return [...items].sort(compare).filter((item, index, sorted) =>
		index === 0 || compare(sorted[index - 1], item) !== 0
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
