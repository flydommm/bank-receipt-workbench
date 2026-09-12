const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCommit, validateCommitList, checkPullRequest } = require('./check-dco.cjs');

const sha = (index) => index.toString(16).padStart(40, '0');
const signer = 'Example Author <author@example.invalid>';
const signedMessage = `Example change\n\nSigned-off-by: ${signer}`;
function commit(index = 1, message = signedMessage, author = { name: 'Example Author', email: 'author@example.invalid' }) {
  return { sha: sha(index), commit: { author, message }, author: { login: 'irrelevant-account' } };
}

test('standard sign-off matches the raw Git author, not the GitHub account', () => {
  assert.deepEqual(checkCommit(commit()), []);
  assert.ok(checkCommit(commit(1, 'Example change')).length > 0);
  assert.ok(checkCommit(commit(1, 'Change\n\nSigned-off-by: Someone Else <other@example.invalid>')).length > 0);
});

test('Unicode, normalized spaces, CRLF and privacy email work without ASCII names', () => {
  const author = { name: '示例  作者', email: '123+example@users.noreply.github.com' };
  assert.deepEqual(checkCommit(commit(1, 'Change\r\n\r\nSigned-off-by: 示例 作者 <123+example@USERS.NOREPLY.GITHUB.COM>\r\n', author)), []);
  assert.deepEqual(checkCommit(commit(1, 'Change\n\nSigned-off-by: José <a@example.invalid>', { name: 'Jose\u0301', email: 'a@example.invalid' })), []);
});

test('each co-author needs their own matching sign-off', () => {
  const message = `${signedMessage}\nCo-authored-by: Another Author <another@example.invalid>`;
  assert.ok(checkCommit(commit(1, message)).includes('contributor-signoff-missing'));
  assert.deepEqual(checkCommit(commit(1, `${message}\nSigned-off-by: Another Author <another@example.invalid>`)), []);
  assert.ok(checkCommit(commit(1, `${signedMessage}\nCo-authored-by: Missing Email`)).includes('malformed-identity-trailer'));
});

test('body quotes and malformed terminal paragraphs do not count as signatures', () => {
  const messages = [
    `${signedMessage}\n\nThis is only a quoted example.`,
    `Change\n\n> Signed-off-by: ${signer}`,
    `Change\n\nSigned-off-by: ${signer}\nThis is not a trailer`,
    `Change\n\nSigned-off-by: ${signer} unexpected suffix`,
    `${signedMessage}\nSigned-off-by: Bad <not-an-email>`,
  ];
  for (const message of messages) assert.ok(checkCommit(commit(1, message)).length > 0);
  assert.deepEqual(checkCommit(commit(1, `${signedMessage}\nReviewed-by: Reviewer <reviewer@example.invalid>`)), []);
});

test('invalid author metadata, unsigned merge commits and bots get no exemption', () => {
  assert.ok(checkCommit(commit(1, signedMessage, { name: 'Example Author\nInjected', email: 'author@example.invalid' })).length > 0);
  assert.ok(checkCommit(commit(1, signedMessage, { name: 'Example Author', email: null })).length > 0);
  assert.ok(checkCommit(commit(1, "Merge branch 'main'", { name: 'Example Bot', email: 'bot@example.invalid' })).length > 0);
  assert.ok(checkCommit({}).length > 0);
});

test('full commit coverage is mandatory, including the head and all paginated commits', () => {
  const commits = Array.from({ length: 250 }, (_, index) => commit(index + 1));
  assert.deepEqual(validateCommitList(commits, 250, sha(250)), []);
  const altered = [...commits];
  altered[140] = commit(141, 'Unsigned on page two');
  assert.ok(validateCommitList(altered, 250, sha(250)).some((failure) => failure.startsWith(sha(141).slice(0, 12))));
  for (const [list, count, head] of [
    [commits, 251, sha(250)], [commits.slice(0, 100), 250, sha(250)],
    [[commit(), commit()], 2, sha(1)], [[commit()], 1, sha(2)],
    [[], 0, sha(1)], [[{ ...commit(), sha: '::error::unsafe' }], 1, sha(1)],
  ]) assert.throws(() => validateCommitList(list, count, head));
});

function harness({ commits = [commit()], count = commits.length, beforePatch = {}, afterPatch = {}, listError = false, statusError = false } = {}) {
  const head = commits.at(-1)?.sha ?? sha(1);
  const pr = {
    number: 7, state: 'open', head: { sha: head },
    base: { sha: sha(999), ref: 'main', repo: { full_name: 'example/project' } }, commits: count,
  };
  const context = { eventName: 'pull_request_target', repo: { owner: 'example', repo: 'project' }, payload: { pull_request: pr }, serverUrl: 'https://github.com', runId: 123 };
  const statuses = [];
  const errors = [];
  const failed = [];
  const infos = [];
  let reads = 0;
  let lists = 0;
  const listCommits = () => {};
  const github = {
    rest: {
      repos: { createCommitStatus: async (args) => { statuses.push(args); if (statusError) throw new Error('secret API response'); } },
      pulls: {
        listCommits,
        get: async (args) => {
          assert.deepEqual(args, { owner: 'example', repo: 'project', pull_number: 7 });
          reads += 1;
          return { data: { ...pr, ...(reads === 1 ? beforePatch : afterPatch) } };
        },
      },
    },
    paginate: async (method, args) => {
      lists += 1;
      assert.equal(method, listCommits);
      assert.deepEqual(args, { owner: 'example', repo: 'project', pull_number: 7, per_page: 100 });
      if (listError) throw new Error('secret API response');
      return commits;
    },
  };
  const core = { error: (message) => errors.push(message), setFailed: (message) => failed.push(message), info: (message) => infos.push(message) };
  return { github, context, core, statuses, errors, failed, infos, counts: () => ({ reads, lists }) };
}

test('trusted workflow publishes a DCO status to the exact PR head after rereading metadata', async () => {
  const input = harness({ commits: Array.from({ length: 101 }, (_, index) => commit(index + 1)) });
  await checkPullRequest(input);
  assert.deepEqual(input.statuses.map((status) => status.state), ['pending', 'success']);
  assert.ok(input.statuses.every((status) => status.sha === sha(101) && status.context === 'DCO'));
  assert.equal(input.statuses[1].target_url, 'https://github.com/example/project/actions/runs/123');
  assert.deepEqual(input.counts(), { reads: 2, lists: 1 });
  assert.deepEqual(input.failed, []);
});

test('invalid sign-offs get failure; logs do not repeat malicious commit content or identities', async () => {
  const input = harness({ commits: [commit(1, '::error::attacker\n$(secret)\n\nSigned-off-by: nobody <nobody@example.invalid>')] });
  await checkPullRequest(input);
  assert.deepEqual(input.statuses.map((status) => status.state), ['pending', 'failure']);
  assert.equal(input.failed.length, 1);
  assert.doesNotMatch(JSON.stringify([input.errors, input.failed, input.infos]), /attacker|secret|nobody@example/);
});

test('changed head, base, count or closed PR cannot get success', async () => {
  for (const afterPatch of [
    { head: { sha: sha(2) } }, { base: { sha: sha(998), ref: 'main', repo: { full_name: 'example/project' } } },
    { commits: 2 }, { state: 'closed' },
  ]) {
    const input = harness({ afterPatch });
    await checkPullRequest(input);
    assert.deepEqual(input.statuses.map((status) => status.state), ['pending', 'error']);
    assert.equal(input.failed.length, 1);
  }
});

test('a rerun can validate an unchanged PR head after main has advanced', async () => {
  const currentBase = { sha: sha(1000), ref: 'main', repo: { full_name: 'example/project' } };
  const input = harness({ beforePatch: { base: currentBase }, afterPatch: { base: currentBase } });
  await checkPullRequest(input);
  assert.deepEqual(input.statuses.map((status) => status.state), ['pending', 'success']);
  assert.ok(input.statuses.every((status) => status.sha === sha(1)));
  assert.deepEqual(input.failed, []);
});

test('stale events, over-limit counts, partial API results and API failures fail closed', async () => {
  for (const options of [
    { beforePatch: { head: { sha: sha(2) } } }, { count: 251 }, { count: 2 }, { listError: true },
  ]) {
    const input = harness(options);
    await checkPullRequest(input);
    assert.deepEqual(input.statuses.map((status) => status.state), ['pending', 'error']);
    assert.equal(input.failed.length, 1);
    assert.doesNotMatch(JSON.stringify(input.errors), /secret API response/);
  }
});

test('wrong event/repository is rejected before any status writes', async () => {
  for (const tamper of [
    (input) => { input.context.eventName = 'pull_request'; },
    (input) => { input.context.payload.pull_request.base.repo.full_name = 'attacker/other'; },
  ]) {
    const input = harness();
    tamper(input);
    await checkPullRequest(input);
    assert.deepEqual(input.statuses, []);
    assert.equal(input.failed.length, 1);
  }
});

test('a status publishing failure never reports success or exposes API details', async () => {
  const input = harness({ statusError: true });
  await checkPullRequest(input);
  assert.equal(input.failed.length, 1);
  assert.doesNotMatch(JSON.stringify([input.errors, input.failed]), /secret API response/);
  assert.ok(input.statuses.every((status) => status.state !== 'success'));
});
