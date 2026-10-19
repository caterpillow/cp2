// Identifies problems and contests from judge URLs.
// Shared by the VS Code extension, the bridge and the browser extension.

export type Site = 'codeforces' | 'atcoder' | 'dmoj' | 'qoj' | 'ojuz' | 'orac2' | 'web';

/** Kind of Codeforces contest the problem lives in (decides URLs for submitting). */
export type CfKind = 'contest' | 'gym' | 'problemset' | 'group';

export interface ProblemRef {
  site: Site;
  /** Contest the problem was opened from ('' when the site's problem ids are global). */
  contestId: string;
  /** Codeforces: problem index ("D2"). AtCoder: task screen name ("abc400_c"). DMOJ: problem code. Web: the URL. */
  taskId: string;
  /** Label shown on the site ("D2", "C", "Ex"). For AtCoder this comes from the page, not the URL. */
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
const DMOJ_HOST = /(^|\.)dmoj\.ca$/i;
const QOJ_HOST = /(^|\.)qoj\.ac$/i;
const OJUZ_HOST = /(^|\.)oj\.uz$/i;
const ORAC_HOST = /(^|\.)orac2\.info$/i;

/** Sites whose problem ids are unique on their own (the contest is not part of the identity). */
const GLOBAL_IDS = new Set<Site>(['dmoj', 'qoj', 'ojuz', 'orac2', 'web']);

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function siteOfUrl(url: string): Site | null {
  const u = safeUrl(url);
  if (!u) return null;
  const h = u.hostname;
  if (CF_HOST.test(h)) return 'codeforces';
  if (AC_HOST.test(h)) return 'atcoder';
  if (DMOJ_HOST.test(h)) return 'dmoj';
  if (QOJ_HOST.test(h)) return 'qoj';
  if (OJUZ_HOST.test(h)) return 'ojuz';
  if (ORAC_HOST.test(h)) return 'orac2';
  return null;
}

/** Parses a problem page URL. Returns null for anything that is not a single problem page. */
export function parseProblemUrl(url: string): ProblemRef | null {
  const u = safeUrl(url);
  if (!u) return null;
  const p = u.pathname.replace(/\/+$/, '');
  switch (siteOfUrl(url)) {
    case 'codeforces': {
      let m = p.match(/^\/(contest|gym)\/(\d+)\/problem\/([A-Za-z0-9]+)$/);
      if (m) {
        const kind = m[1] as CfKind;
        return { site: 'codeforces', contestId: m[2], taskId: m[3].toUpperCase(), index: m[3].toUpperCase(), url: canonicalCfProblemUrl(kind, m[2], m[3]), cfKind: kind };
      }
      m = p.match(/^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)$/);
      if (m) return { site: 'codeforces', contestId: m[1], taskId: m[2].toUpperCase(), index: m[2].toUpperCase(), url: canonicalCfProblemUrl('problemset', m[1], m[2]), cfKind: 'problemset' };
      m = p.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)$/);
      if (m) return { site: 'codeforces', contestId: m[2], taskId: m[3].toUpperCase(), index: m[3].toUpperCase(), url: `https://codeforces.com/group/${m[1]}/contest/${m[2]}/problem/${m[3].toUpperCase()}`, cfKind: 'group', groupId: m[1] };
      return null;
    }
    case 'atcoder': {
      const m = p.match(/^\/contests\/([A-Za-z0-9_-]+)\/tasks\/([A-Za-z0-9_-]+)$/);
      return m ? { site: 'atcoder', contestId: m[1], taskId: m[2], url: `https://atcoder.jp/contests/${m[1]}/tasks/${m[2]}` } : null;
    }
    case 'dmoj': {
      const m = p.match(/^\/problem\/([A-Za-z0-9_]+)$/);
      return m ? { site: 'dmoj', contestId: '', taskId: m[1], index: m[1], url: `https://dmoj.ca/problem/${m[1]}` } : null;
    }
    case 'qoj': {
      const m = p.match(/^(?:\/contest\/(\d+))?\/problem\/(\d+)$/);
      return m ? { site: 'qoj', contestId: m[1] ?? '', taskId: m[2], url: m[1] ? `https://qoj.ac/contest/${m[1]}/problem/${m[2]}` : `https://qoj.ac/problem/${m[2]}` } : null;
    }
    case 'ojuz': {
      const m = p.match(/^\/problem\/view\/([A-Za-z0-9_-]+)$/);
      return m ? { site: 'ojuz', contestId: '', taskId: m[1], url: `https://oj.uz/problem/view/${m[1]}` } : null;
    }
    case 'orac2': {
      const m = p.match(/^\/problem\/(\d+)$/);
      return m ? { site: 'orac2', contestId: '', taskId: m[1], url: `https://orac2.info/problem/${m[1]}/` } : null;
    }
  }
  return null;
}

/** Any other page imported through the toolbar icon. */
export function webRef(url: string): ProblemRef {
  const u = safeUrl(url);
  const clean = u ? `${u.origin}${u.pathname}${u.search}` : url;
  return { site: 'web', contestId: '', taskId: clean, url: clean };
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
  switch (siteOfUrl(url)) {
    case 'codeforces': {
      let m = p.match(/^\/(contest|gym)\/(\d+)(\/(problems|standings|my|status))?$/);
      if (m) return { site: 'codeforces', contestId: m[2], url: `https://codeforces.com/${m[1]}/${m[2]}`, cfKind: m[1] as CfKind };
      m = p.match(/^\/group\/([A-Za-z0-9]+)\/contest\/(\d+)(\/(problems|standings|my|status))?$/);
      if (m) return { site: 'codeforces', contestId: m[2], url: `https://codeforces.com/group/${m[1]}/contest/${m[2]}`, cfKind: 'group', groupId: m[1] };
      return null;
    }
    case 'atcoder': {
      const m = p.match(/^\/contests\/([A-Za-z0-9_-]+)(\/(tasks|standings|submissions\/me|submissions))?$/);
      return m && m[1] !== 'archive' ? { site: 'atcoder', contestId: m[1], url: `https://atcoder.jp/contests/${m[1]}` } : null;
    }
    case 'dmoj': {
      const m = p.match(/^\/contest\/([A-Za-z0-9_]+)(\/(ranking|stats))?$/);
      return m ? { site: 'dmoj', contestId: m[1], url: `https://dmoj.ca/contest/${m[1]}` } : null;
    }
    case 'qoj': {
      const m = p.match(/^\/contest\/(\d+)(\/(standings|submissions))?$/);
      return m ? { site: 'qoj', contestId: m[1], url: `https://qoj.ac/contest/${m[1]}` } : null;
    }
  }
  return null;
}

/** Stable identity for a problem: same for contest and problemset URLs of one Codeforces problem. */
export function problemKey(ref: Pick<ProblemRef, 'site' | 'contestId' | 'taskId'>): string {
  if (GLOBAL_IDS.has(ref.site)) return `${ref.site}::${ref.site === 'web' ? ref.taskId : ref.taskId.toLowerCase()}`;
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
  return ref.site === 'codeforces' ? ref.taskId.toUpperCase() : ref.taskId;
}

/** Short human id: "2261 D2", "abc400 C", "dmoj ccc22s1". */
export function shortProblemId(ref: ProblemRef): string {
  switch (ref.site) {
    case 'codeforces':
    case 'atcoder':
      return `${ref.contestId} ${problemIndex(ref)}`;
    case 'dmoj':
      return `DMOJ ${ref.taskId}`;
    case 'qoj':
      return `QOJ ${ref.taskId}`;
    case 'ojuz':
      return `oj.uz ${ref.taskId}`;
    case 'orac2':
      return `ORAC ${ref.taskId}`;
    default: {
      const u = safeUrl(ref.url);
      return u ? u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '').slice(-24) : '') : ref.url.slice(0, 32);
    }
  }
}

export function siteLabel(site: Site): string {
  return { codeforces: 'CF', atcoder: 'AtCoder', dmoj: 'DMOJ', qoj: 'QOJ', ojuz: 'oj.uz', orac2: 'ORAC', web: 'web' }[site];
}

/** Sites cp2 can submit to. */
export function canSubmit(site: Site): boolean {
  return site === 'codeforces' || site === 'atcoder' || site === 'dmoj';
}

/** File stem for a problem in a contest folder: "D2" -> "d2", "Ex" -> "ex", "bts24d" -> "bts24d". */
export function fileStemForIndex(index: string): string {
  return index.toLowerCase().replace(/[^a-z0-9_]+/g, '');
}

/** URL of the page where a solution to this problem is submitted. */
export function submitPageUrl(ref: ProblemRef): string {
  if (ref.site === 'atcoder') return `https://atcoder.jp/contests/${ref.contestId}/submit?taskScreenName=${ref.taskId}`;
  if (ref.site === 'dmoj') return `https://dmoj.ca/problem/${ref.taskId}/submit`;
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

/** URL of the page that lists your submissions (verdicts are read from it). */
export function mySubmissionsUrl(ref: ProblemRef): string {
  if (ref.site === 'atcoder') return `https://atcoder.jp/contests/${ref.contestId}/submissions/me`;
  if (ref.site === 'dmoj') return `https://dmoj.ca/problem/${ref.taskId}`;
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
