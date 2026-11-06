import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const devRunner = fileURLToPath(new URL('./runner.ts', import.meta.url));

Deno.test('a committed poll is persisted before the next poll starts', async () => {
	const dir = await Deno.makeTempDir({ prefix: 'dev-runner-test-' });
	try {
		await Deno.mkdir(join(dir, 'dist'));
		await Deno.writeTextFile(
			join(dir, 'manifest.json'),
			JSON.stringify({
				id: 'fixture',
				name: 'Fixture',
				version: '0.0.1',
				entry: 'dist/main.js',
				permissions: {},
			}),
		);
		await Deno.writeTextFile(
			join(dir, 'dist/main.js'),
			`import { Connector } from '@gety-ai/connector-sdk';
export default class Fixture extends Connector {
	async *poll() {
		yield { updates: [], state: { cursor: (this.lastState?.cursor ?? 0) + 1 } };
	}
}
`,
		);
		const statePath = join(dir, 'state.json');
		await Deno.writeTextFile(statePath, '{"cursor":0}\n');

		const child = new Deno.Command(Deno.execPath(), {
			args: [
				'run',
				'-A',
				devRunner,
				'--deno',
				Deno.execPath(),
				'--polls',
				'2',
				'--interval',
				'60',
				'--state',
				statePath,
				'--out-dir',
				join(dir, 'runs'),
			],
			cwd: dir,
			stdin: 'null',
			stdout: 'null',
			stderr: 'piped',
		}).spawn();

		// Stop the run in the interval between the two polls. SIGTERM, because
		// Deno on Windows can only send SIGTERM and SIGKILL.
		let stderr = '';
		const decoder = new TextDecoder();
		for await (const chunk of child.stderr) {
			stderr += decoder.decode(chunk, { stream: true });
			if (stderr.includes('poll 1: success, 1 batches')) {
				child.kill('SIGTERM');
				break;
			}
		}
		await child.status;

		assert.match(stderr, /poll 1: success, 1 batches.*state committed/);
		assert.deepEqual(JSON.parse(await Deno.readTextFile(statePath)), {
			cursor: 1,
		});
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
