import assert from 'node:assert/strict';
import GetySampleConnector, { buildSamplePollResult } from './index.ts';

Deno.test('buildSamplePollResult emits stable markdown docs', () => {
	const result = buildSamplePollResult(3);

	assert.equal(result.updates.length, 2);
	assert.deepEqual(result.state, { run_count: 3 });

	const [intro, notes] = result.updates;
	assert.equal(intro.kind, 'upsert');
	assert.equal(notes.kind, 'upsert');

	if (intro.kind !== 'upsert' || notes.kind !== 'upsert') {
		throw new Error('Expected sample updates to be upserts.');
	}

	assert.equal(intro.doc.id, 'gety-sample:introduction');
	assert.equal(intro.doc.content_format, 'markdown');
	assert.equal(intro.doc.doc_type, 'gety:sample');
	assert.match(
		intro.doc.content ?? '',
		/This connector has completed 3 poll invocation\(s\)/,
	);
	assert.deepEqual(intro.doc.metadata, {
		url: 'https://gety.ai/',
		created_at: '2026-05-12T00:00:00Z',
		source: 'gety-sample-connector',
		run_count: 3,
	});

	assert.equal(notes.doc.id, 'gety-sample:development-notes');
	assert.deepEqual(notes.doc.metadata, {
		url: 'https://gety.ai/',
		created_at: '2026-05-12T00:00:00Z',
		source: 'gety-sample-connector',
	});
});

Deno.test('a replayed poll emits the same updates and state', async () => {
	const replay = async () => {
		const connector = Object.assign(new GetySampleConnector(), {
			lastState: { run_count: 2 },
		});
		return await Array.fromAsync(connector.poll());
	};

	const first = await replay();
	assert.deepEqual(first, [buildSamplePollResult(3)]);
	assert.deepEqual(await replay(), first);
});

Deno.test('poll stops once Gety cancels it', async () => {
	const controller = new AbortController();
	controller.abort();
	const connector = Object.assign(new GetySampleConnector(), {
		signal: controller.signal,
	});

	await assert.rejects(connector.poll().next(), { name: 'AbortError' });
});
