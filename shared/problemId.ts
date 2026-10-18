// Identifies problems and contests from Codeforces / AtCoder URLs.
// Shared by the VS Code extension, the bridge and the browser extension.

export type Site = 'codeforces' | 'atcoder';

/** Kind of Codeforces contest the problem lives in (decides URLs for submitting). */
export type CfKind = 'contest' | 'gym' | 'problemset' | 'group';

export interface ProblemRef {
  site: Site;
  contestId: string;
  /** Codeforces: problem index ("D2"). AtCoder: task screen name ("abc400_c"). */
  taskId: string;
  /** Letter shown on the site ("D2", "C", "Ex"). For AtCoder this comes from the page, not the URL. */
  index?: string;
  url: string;
  cfKind?: CfKind;
  /** Codeforces group id for /group/<g>/contest/<c> URLs. */
  groupId?: string;
}

export interface ContestRef {
  site: Site;
  contestId: string;
  url: string;
  cfKind?: CfKind;
  groupId?: string;
}

const CF_HOST = /(^|\.)codeforces\.(com|ml|net)$/i;
const AC_HOST = /(^|\.)atcoder\.jp$/i;

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Parses a problem page URL. Returns null for anything that is not a single problem page. */
export function parseProblemUrl(url: string): ProblemRef | null {
  const u = safeUrl(url);
  if (!u) return null;
  const p = u.pathname.replace(/\/+$/, '');
  if (CF_HOST.test(u.hostname)) {
    let m = p.match(/^\/(contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)$/);
    if (m) {
      const kind = m[1] as CfKind;
      return { site: 'codeforces', contestId: m[2], taskId: m[3].toUpperCase(), index: m[3].toUpperCase(), url: canonicalCfProblemUrl(kind, m[2], m[3]), cfKind: kind };
    }
    m = p.match(/^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)$/);
    if (m) {
      return { site: 'codeforces', contestId: m[1], taskId: m[2].toUpperCase(), index: m[2].toUpperCase(), url: canonicalCfProblemUrl('problemset', m[1], m[2]), cfKind: 'problemset' };
    }
    m = p.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)$/);
    if (m) {
      return { site: 'codeforces', contestId: m[2], taskId: m[3].toUpperCase(), index: m[3].toUpperCase(), url: `https://codeforces.com/group/${m[1]}/contest/${m[2]}/problem/${m[3].toUpperCase()}`, cfKind: 'group', groupId: m[1] };
    }
    return null;
  }
  if (AC_HOST.test(u.hostname)) {
    const m = p.match(/^\/contests\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/);
    if (m) return { site: 'atcoder', contestId: m[1], taskId: m[2], url: `https://atcoder.jp/contests/${m[1]}/tasks/${m[2]}` };
  }
  return null;
}

export function canonicalCfProblemUrl(kind: CfKind, contestId: string, index: string): string {
  const idx = index.toUpperCase();
  if (kind === 'problemset') return `https://codeforces.com/problemset/problem/${contestId}/${idx}`;
  return `https://codeforces.com/${kind === 'gym' ? 'gym' : 'contest'}/${contestId}/problem/${idx}`;
}

/** Parses a contest page URL (dashboard, task list, standings, all-problems page). */
export function parseContestUrl(url: string): ContestRef | null {
  const u = safeUrl(url);
  if (!u) return null;
  const p = u.pathname.replace(/\/+$/, '');
  if (CF_HOST.test(u.hostname)) {
    let m = p.match(/^\/(contest|gym)\/(\d+)(\/(problems|standings|my|status))?$/);
    if (m) return { site: 'codeforces', contestId: m[2], url: `https://codeforces.com/${m[1]}/${m[2]}`, cfKind: m[1] as CfKind };
    m = p.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)(\/(problems|standings|my|status))?$/);
    if (m) return { site: 'codeforces', contestId: m[2], url: `https://codeforces.com/group/${m[1]}/contest/${m[2]}`, cfKind: 'group', groupId: m[1] };
    return null;
  }
  if (AC_HOST.test(u.hostname)) {
    const m = p.match(/^\/contests\/([A-Za-z0-9_-]+)(\/(tasks|standings|submissions\/me|submissions))?$/);
    if (m && m[1] !== 'archive') return { site: 'atcoder', contestId: m[1], url: `https://atcoder.jp/contests/${m[1]}` };
  }
  return null;
}

/** Stable identity for a problem: same for contest and problemset URLs of one Codeforces problem. */
export function problemKey(ref: Pick<ProblemRef, 'site' | 'contestId' | 'taskId'>): string {
  const task = ref.site === 'codeforces' ? ref.taskId.toUpperCase() : ref.taskId.toLowerCase();
  return `${ref.site}:${ref.contestId.toLowerCase()}:${task}`;
}

export function contestKey(ref: Pick<ContestRef, 'site' | 'contestId'>): string {
  return `${ref.site}:${ref.contestId.toLowerCase()}`;
}

/** Index letter for a problem: explicit index, else derived from the AtCoder task id ("abc400_c" -> "C"). */
export function problemIndex(ref: ProblemRef): string {
  if (ref.index) return ref.index;
  if (ref.site === 'atcoder') {
    const m = ref.taskId.match(/_([a-z0-9]+)$/i);
    if (m) return m[1].toUpperCase();
  }
  return ref.taskId.toUpperCase();
}

/** Short human id: "CF 2261 D2", "abc400 C". */
export function shortProblemId(ref: ProblemRef): string {
  if (ref.site === 'codeforces') return `${ref.contestId} ${problemIndex(ref)}`;
  return `${ref.contestId} ${problemIndex(ref)}`;
}

export function siteLabel(site: Site): string {
  return site === 'codeforces' ? 'CF' : 'AtCoder';
}

/** File stem for a problem in a contest folder: "D2" -> "d2", "Ex" -> "ex". */
export function fileStemForIndex(index: string): string {
  return index.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** URL of the page where a solution to this problem is submitted. */
export function submitPageUrl(ref: ProblemRef): string {
  if (ref.site === 'atcoder') return `https://atcoder.jp/contests/${ref.contestId}/submit?taskScreenName=${ref.taskId}`;
  const idx = problemIndex(ref);
  switch (ref.cfKind) {
    case 'gym':
      return `https://codeforces.com/gym/${ref.contestId}/submit/${idx}`;
    case 'group':
      return `https://codeforces.com/group/${ref.groupId}/contest/${ref.contestId}/submit/${idx}`;
    case 'problemset':
      return `https://codeforces.com/problemset/submit/${ref.contestId}/${idx}`;
    default:
      return `https://codeforces.com/contest/${ref.contestId}/submit/${idx}`;
  }
}

/** URL of the "my submissions" page that shows verdicts after submitting. */
export function mySubmissionsUrl(ref: ProblemRef): string {
  if (ref.site === 'atcoder') return `https://atcoder.jp/contests/${ref.contestId}/submissions/me`;
  switch (ref.cfKind) {
    case 'gym':
      return `https://codeforces.com/gym/${ref.contestId}/my`;
    case 'group':
      return `https://codeforces.com/group/${ref.groupId}/contest/${ref.contestId}/my`;
    case 'problemset':
      return `https://codeforces.com/problemset/status?my=on`;
    default:
      return `https://codeforces.com/contest/${ref.contestId}/my`;
  }
}
