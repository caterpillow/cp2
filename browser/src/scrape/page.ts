// Classifies a page and runs the matching scraper.

import { parseContestUrl, parseProblemUrl, Site, siteOfUrl } from '../../../shared/problemId';
import type { ContestInfo, ProblemData } from '../../../shared/protocol';
import { scrapeAcContest, scrapeAcTask } from './atcoder';
import { scrapeCfContest, scrapeCfProblem, scrapeCfProblemsPage } from './codeforces';
import { scrapeDmojContest, scrapeDmojProblem, scrapeGeneric, scrapeOjuzProblem, scrapeOracProblem, scrapeQojContest, scrapeQojProblem } from './sites';
import { parseAcSubmissions, parseCfSubmissions, parseDmojSubmissions, VerdictRow } from './verdicts';

export type PageKind = 'problem' | 'problems' | 'contest' | 'submissions' | 'other';

export interface PageInfo {
  kind: PageKind;
  site: Site | null;
  url: string;
  problem: ProblemData | null;
  contest: ContestInfo | null;
}

export function siteOf(url: string): Site | null {
  return siteOfUrl(url);
}

function isSubmissionsPath(site: Site, path: string): boolean {
  switch (site) {
    case 'codeforces':
      return /\/(my|status)$/.test(path) || /^\/submissions\//.test(path) || /^\/problemset\/status/.test(path);
    case 'atcoder':
      return /\/submissions(\/me)?$/.test(path);
    case 'dmoj':
      return /^\/submission\/\d+$/.test(path) || /^\/submissions\//.test(path) || /\/submissions\//.test(path);
    default:
      return /submission/.test(path);
  }
}

function scrapeProblem(site: Site, doc: Document, url: string): ProblemData | null {
  switch (site) {
    case 'codeforces':
      return scrapeCfProblem(doc, url);
    case 'atcoder':
      return scrapeAcTask(doc, url);
    case 'dmoj':
      return scrapeDmojProblem(doc, url);
    case 'qoj':
      return scrapeQojProblem(doc, url);
    case 'ojuz':
      return scrapeOjuzProblem(doc, url);
    case 'orac2':
      return scrapeOracProblem(doc, url);
    default:
      return null;
  }
}

function scrapeContest(site: Site, doc: Document, url: string): ContestInfo | null {
  switch (site) {
    case 'codeforces':
      return scrapeCfContest(doc, url);
    case 'atcoder':
      return scrapeAcContest(doc, url);
    case 'dmoj':
      return scrapeDmojContest(doc, url);
    case 'qoj':
      return scrapeQojContest(doc, url);
    default:
      return null;
  }
}

/**
 * `generic`: the page is not a known judge (toolbar icon on any site) — find samples heuristically.
 */
export function analyzePage(doc: Document, url: string, pick?: { index?: string; y?: number; generic?: boolean }): PageInfo {
  const site = siteOf(url);
  const info: PageInfo = { kind: 'other', site, url, problem: null, contest: null };
  if (!site) {
    if (pick?.generic) {
      info.kind = 'problem';
      info.site = 'web';
      info.problem = scrapeGeneric(doc, url);
    }
    return info;
  }
  const path = new URL(url).pathname.replace(/\/+$/, '');
  if (parseProblemUrl(url)) {
    info.kind = 'problem';
    info.problem = scrapeProblem(site, doc, url);
    return info;
  }
  if (site === 'orac2' && !/\/(submissions?|hof|feedback)(\/|$)/.test(path)) {
    // ORAC sets (problem of the week, ...) have their own URL shapes: go by the page content.
    const p = scrapeOracProblem(doc, url);
    if (p) {
      info.kind = 'problem';
      info.problem = p;
      return info;
    }
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
    info.contest = scrapeContest(site, doc, url);
  }
  if (info.kind === 'other' && pick?.generic) {
    info.kind = 'problem';
    info.problem = scrapeGeneric(doc, url);
  }
  return info;
}

export function submissionRows(doc: Document, url: string): VerdictRow[] {
  switch (siteOf(url)) {
    case 'codeforces':
      return parseCfSubmissions(doc);
    case 'dmoj':
      return parseDmojSubmissions(doc);
    default:
      return parseAcSubmissions(doc);
  }
}
