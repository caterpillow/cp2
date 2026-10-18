// Classifies a page and runs the matching scraper.

import { parseContestUrl, parseProblemUrl, Site } from '../../../shared/problemId';
import type { ContestInfo, ProblemData } from '../../../shared/protocol';
import { scrapeAcContest, scrapeAcTask } from './atcoder';
import { scrapeCfContest, scrapeCfProblem, scrapeCfProblemsPage } from './codeforces';
import { parseAcSubmissions, parseCfSubmissions, VerdictRow } from './verdicts';

export type PageKind = 'problem' | 'problems' | 'contest' | 'submissions' | 'other';

export interface PageInfo {
  kind: PageKind;
  site: Site | null;
  url: string;
  problem: ProblemData | null;
  contest: ContestInfo | null;
}

export function siteOf(url: string): Site | null {
  try {
    const h = new URL(url).hostname;
    if (/(^|\.)codeforces\.(com|ml|net)$/i.test(h)) return 'codeforces';
    if (/(^|\.)atcoder\.jp$/i.test(h)) return 'atcoder';
  } catch {
    /* not a url */
  }
  return null;
}

function isSubmissionsPath(site: Site, path: string): boolean {
  if (site === 'codeforces') return /\/(my|status)$/.test(path) || /^\/submissions\//.test(path) || /^\/problemset\/status/.test(path);
  return /\/submissions(\/me)?$/.test(path);
}

export function analyzePage(doc: Document, url: string, pick?: { index?: string; y?: number }): PageInfo {
  const site = siteOf(url);
  const info: PageInfo = { kind: 'other', site, url, problem: null, contest: null };
  if (!site) return info;
  const path = new URL(url).pathname.replace(/\/+$/, '');
  if (parseProblemUrl(url)) {
    info.kind = 'problem';
    info.problem = site === 'codeforces' ? scrapeCfProblem(doc, url) : scrapeAcTask(doc, url);
    return info;
  }
  if (isSubmissionsPath(site, path)) {
    info.kind = 'submissions';
    return info;
  }
  if (parseContestUrl(url)) {
    if (site === 'codeforces' && /\/problems$/.test(path)) {
      info.kind = 'problems';
      info.problem = scrapeCfProblemsPage(doc, url, pick);
    } else info.kind = 'contest';
    info.contest = site === 'codeforces' ? scrapeCfContest(doc, url) : scrapeAcContest(doc, url);
  }
  return info;
}

export function submissionRows(doc: Document, url: string): VerdictRow[] {
  return siteOf(url) === 'codeforces' ? parseCfSubmissions(doc) : parseAcSubmissions(doc);
}
