// Checks public PR metadata only. Never check out or execute a contributor's code.
const STATUS_CONTEXT = 'DCO';
const MAX_COMMITS = 250; // GitHub's list-PR-commits endpoint has a hard cap.
const SHA = /^[0-9a-f]{40}$/;

function identity(name, email) {
  if (typeof name !== 'string' || typeof email !== 'string') return null;
  if (/[\x00-\x1f\x7f<>]/u.test(name + email)) return null;
  const normalizedName = name.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedName || !/^[^\s<>@]+@[^\s<>@]+$/u.test(normalizedEmail)) return null;
  return `${normalizedName}\n${normalizedEmail}`;
}

function trailerIdentity(value) {
  const match = /^(.+?)\s*<([^<>]+)>$/u.exec(value.trim());
  return match ? identity(match[1], match[2]) : null;
}

function checkCommit(commit) {
  const author = identity(commit?.commit?.author?.name, commit?.commit?.author?.email);
  const message = commit?.commit?.message;
  if (!author || typeof message !== 'string') return ['invalid-author-or-message'];

  // git commit -s writes trailers in a final paragraph. Text quoted in the body
  // must not count as a signature. Unknown well-formed trailers remain allowed.
  const paragraph = message.replace(/\r\n/g, '\n').trimEnd().split(/\n[ \t]*\n/u).at(-1);
  const trailers = paragraph.split('\n').map((line) => /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/u.exec(line));
  if (trailers.some((trailer) => !trailer)) return ['missing-terminal-trailers'];

  const signers = new Set();
  const authors = new Set([author]);
  const errors = new Set();
  for (const [, token, value] of trailers) {
    const key = token.toLowerCase();
    if (key !== 'signed-off-by' && key !== 'co-authored-by') continue;
    const person = trailerIdentity(value);
    if (!person) errors.add('malformed-identity-trailer');
    else (key === 'signed-off-by' ? signers : authors).add(person);
  }
  if (!signers.has(author)) errors.add('author-signoff-missing');
  if ([...authors].some((person) => !signers.has(person))) errors.add('contributor-signoff-missing');
  return [...errors];
}

function validateCommitList(commits, count, headSha) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COMMITS) {
    throw new Error('PR must contain 1-250 commits; split larger contributions into smaller PRs.');
  }
  if (!Array.isArray(commits) || commits.length !== count
    || commits.some((commit) => !SHA.test(commit?.sha ?? ''))
    || new Set(commits.map((commit) => commit.sha)).size !== count
    || !commits.some((commit) => commit.sha === headSha)) {
    throw new Error('Incomplete PR commit list; no successful DCO status can be issued.');
  }
  return commits.flatMap((commit) => checkCommit(commit).map((reason) => `${commit.sha.slice(0, 12)}: ${reason}`));
}

function requireSnapshot(pr, expected) {
  if (pr?.state !== 'open' || pr?.head?.sha !== expected.head
    || !SHA.test(pr?.base?.sha ?? '') || pr?.base?.ref !== 'main'
    || (expected.base !== undefined && pr.base.sha !== expected.base)
    || pr?.base?.repo?.full_name?.toLowerCase() !== expected.repository
    || (expected.count !== undefined && pr.commits !== expected.count)) {
    throw new Error('PR changed during validation; rerun DCO on the current PR revision.');
  }
}

async function checkPullRequest({ github, context, core }) {
  let statusArgs;
  let checked = false;
  try {
    const eventPr = context.payload?.pull_request;
    const { owner, repo } = context.repo;
    const repository = `${owner}/${repo}`.toLowerCase();
    if (context.eventName !== 'pull_request_target' || !Number.isInteger(eventPr?.number)
      || eventPr.number < 1 || !SHA.test(eventPr?.head?.sha ?? '')
      || !SHA.test(eventPr?.base?.sha ?? '')) {
      throw new Error('Expected a valid pull_request_target event.');
    }
    const snapshot = { head: eventPr.head.sha, repository };
    requireSnapshot(eventPr, snapshot);
    const apiArgs = { owner, repo, pull_number: eventPr.number };
    statusArgs = {
      owner, repo, sha: snapshot.head, context: STATUS_CONTEXT,
      target_url: `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`,
    };
    await github.rest.repos.createCommitStatus({ ...statusArgs, state: 'pending', description: 'Checking all PR author and co-author sign-offs.' });
    const { data: before } = await github.rest.pulls.get(apiArgs);
    requireSnapshot(before, snapshot);
    // A rerun retains the old event payload even if main has advanced. The
    // current API response is the base/count snapshot for this validation.
    snapshot.base = before.base.sha;
    snapshot.count = before.commits;
    if (!Number.isInteger(snapshot.count) || snapshot.count < 1 || snapshot.count > MAX_COMMITS) {
      core.error('PR must contain 1-250 commits; split larger contributions into smaller PRs.');
      throw new Error('Unsupported PR commit count.');
    }
    const commits = await github.paginate(github.rest.pulls.listCommits, { ...apiArgs, per_page: 100 });
    const failures = validateCommitList(commits, snapshot.count, snapshot.head);
    const { data: after } = await github.rest.pulls.get(apiArgs);
    requireSnapshot(after, snapshot);
    // Never log raw contributor messages/identities or interpolate them into code.
    failures.forEach((failure) => core.error(failure));
    await github.rest.repos.createCommitStatus({
      ...statusArgs,
      state: failures.length ? 'failure' : 'success',
      description: failures.length ? 'Missing or invalid sign-off; see CONTRIBUTING.md and this check log.' : `DCO trailers verified for all ${commits.length} PR commits.`,
    });
    checked = true;
    if (failures.length) core.setFailed('DCO sign-off validation failed. See CONTRIBUTING.md; never sign on behalf of others.');
    else core.info(`DCO passed for ${commits.length} commits. Provenance and permission still require maintainer review.`);
  } catch {
    // API errors can include request details; keep logs static and fail closed.
    if (statusArgs && !checked) {
      try {
        await github.rest.repos.createCommitStatus({ ...statusArgs, state: 'error', description: 'Unable to verify the complete current PR; rerun the check or ask a maintainer.' });
      } catch {
        core.error('Could not publish DCO status. Do not merge while the required status is missing or pending.');
      }
    }
    core.setFailed('DCO could not verify this PR revision. Check event, commit count and GitHub API availability, then rerun.');
  }
}

module.exports = { checkCommit, validateCommitList, checkPullRequest };
