import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import {
  ParsedDivisionQuota,
  ParsedLeave,
  ParsedSchedulePerson,
  ScheduleSyncResult,
} from './types';
import {
  clean,
  classifyRole,
  computeRowHash,
  parseDateOnly,
  parseDateTime,
  parseNumber,
  parseScheduleDivisions,
  parseShift,
  parseWeekPlanCell,
  DivisionRef,
} from './normalization';
import * as crypto from 'crypto';

/**
 * Reads the managers' "Dynamic Schedule - Critical Flow" workbook — the
 * people, leave, backups and per-shift quotas that the per-division source
 * sheets never carry. One spreadsheet, so the API reads it directly (the same
 * way the MSN module reads its moderation log) rather than via n8n.
 *
 * Every tab is located by header text, not row number: the tabs open with
 * titles, notes and a "Filter:" block, and the managers move things around.
 */

const TABS = {
  writers: 'Writer Info',
  editors: 'Editor Info',
  list: 'List ( Roles and Contact)',
  editorLeaves: 'CF Editor Leaves',
  writerLeaves: 'CF Writer Leaves',
  quotas: 'DailyDynamics',
  chart: 'Editorial Chart',
  divisions: 'Division Update',
} as const;

const RANGES: Record<keyof typeof TABS, string> = {
  writers: `'${TABS.writers}'!A1:M400`,
  editors: `'${TABS.editors}'!A1:L80`,
  list: `'${TABS.list}'!A1:I150`,
  editorLeaves: `'${TABS.editorLeaves}'!A1:G400`,
  writerLeaves: `'${TABS.writerLeaves}'!A1:G400`,
  quotas: `'${TABS.quotas}'!A1:D30`,
  chart: `'${TABS.chart}'!A1:N4`,
  divisions: `'${TABS.divisions}'!A1:D25`,
};

const WEEKDAY_RE = /^(sun|mon|tue|wed|thu|fri|sat)/i;
const WEEKDAY_KEY: Record<string, string> = {
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
};

type Row = any[];

function low(v: any): string {
  return clean(v).toLowerCase();
}

/** Index of the first row (within `limit`) that contains every needle. */
function findHeaderRow(rows: Row[], needles: string[], limit = 12): number {
  for (let r = 0; r < Math.min(rows.length, limit); r++) {
    const cells = (rows[r] || []).map(low);
    if (needles.every((n) => cells.some((c) => c === n || c.startsWith(n)))) return r;
  }
  return -1;
}

/** Column index of the first header cell matching any of the names. */
function col(header: Row, names: string[]): number {
  const cells = header.map(low);
  for (let c = 0; c < cells.length; c++) {
    if (names.some((n) => cells[c] === n || cells[c].startsWith(n))) return c;
  }
  return -1;
}

function sid(prefix: string, ...parts: string[]): string {
  return prefix + crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 10);
}

/**
 * The Editor Info "Backup" column is a person for most rows, but the
 * Associates' rows reuse it for notes ("Week off: Wed", "Koushik / not needed").
 * Keep only what reads as a name.
 */
/**
 * A shift clock is "6 PM - 3 AM", "09:00 - 18:00", "7 pm to 4 am". The same
 * column sometimes carries a joining date ("Jan 16th") or a bare date serial
 * for newer rows; neither is a clock and neither should be shown as one.
 */
function cleanClock(raw: any): string {
  if (typeof raw === 'number') return '';
  const s = clean(raw);
  if (!s) return '';
  if (!/\d/.test(s)) return '';
  if (!/(am|pm|:|-|–|to)/i.test(s)) return '';
  if (/^[A-Za-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?$/.test(s)) return '';
  return s;
}

function cleanBackup(raw: any): string {
  const first = clean(raw).split(/\s*\/\s*/)[0].trim();
  if (!first) return '';
  if (/week\s*off|not needed|^none$|^n\/?a$|^-+$|^tbd$/i.test(first)) return '';
  if (/[:\d]/.test(first)) return '';
  return first;
}

/** Working copy of a person while the three tabs are merged. */
interface Draft {
  name: string;
  primary: DivisionRef;
  secondary: DivisionRef[];
  role: string;
  roleGroup: string;
  pod: string;
  shift: string;
  shiftClock: string;
  weekoff: string;
  weekPlan: Record<string, { off: boolean; coverBy: string; note: string }>;
  backup: string;
  status: string;
  sources: Set<string>;
  flags: Set<string>;
  raw: any[];
}

@Injectable()
export class ScheduleSyncService {
  private readonly logger = new Logger(ScheduleSyncService.name);

  private getAuth() {
    return new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  }

  isConfigured(): boolean {
    return !!process.env.CF_SCHEDULE_SHEET_ID;
  }

  async fetch(): Promise<ScheduleSyncResult | null> {
    const sheetId = process.env.CF_SCHEDULE_SHEET_ID;
    if (!sheetId) {
      this.logger.warn('CF_SCHEDULE_SHEET_ID not configured, skipping schedule sync');
      return null;
    }

    try {
      const sheets = google.sheets({ version: 'v4', auth: this.getAuth() });
      const keys = Object.keys(RANGES) as (keyof typeof TABS)[];
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: sheetId,
        ranges: keys.map((k) => RANGES[k]),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      const got: Partial<Record<keyof typeof TABS, Row[]>> = {};
      (res.data.valueRanges || []).forEach((vr, i) => {
        got[keys[i]] = (vr.values as Row[]) || [];
      });
      return this.parse(got);
    } catch (error: any) {
      // A failed read leaves the previous schedule data in place.
      this.logger.error(`Failed to fetch schedule workbook: ${error.message}`);
      return null;
    }
  }

  /** Exposed for offline replay against an xlsx-derived fixture. */
  parse(tabs: Partial<Record<keyof typeof TABS, Row[]>>): ScheduleSyncResult {
    const people = this.parsePeople(tabs.writers || [], tabs.editors || [], tabs.list || []);
    const leaves = [
      ...this.parseLeaves(tabs.editorLeaves || [], 'editor'),
      ...this.parseLeaves(tabs.writerLeaves || [], 'writer'),
    ];
    const quotas = this.parseQuotas(tabs.quotas || [], tabs.chart || [], tabs.divisions || []);
    this.logger.log(
      `Schedule: ${people.length} people, ${leaves.length} leave records, ${quotas.length} quota rows`,
    );
    return { people, leaves, quotas };
  }

  // ── People ──

  private parsePeople(writers: Row[], editors: Row[], list: Row[]): ParsedSchedulePerson[] {
    const drafts: Draft[] = [];

    const find = (name: string, refs: DivisionRef[]): Draft | undefined => {
      const l = name.toLowerCase();
      const divs = refs.map((r) => r.division);
      // Same division first, then anywhere the exact name appears, then a
      // unique first-name match — the tabs abbreviate ("Shubhi", "Rati",
      // "Gokul Pillai" vs "Gokul Gopalakrishna Pillai").
      return (
        drafts.find((d) => d.name.toLowerCase() === l && divs.includes(d.primary.division)) ||
        drafts.find((d) => d.name.toLowerCase() === l) ||
        this.uniqueFirstToken(drafts, l)
      );
    };

    // Writer Info: several "Name | Division | Role" blocks side by side, each
    // under a POD / NON-POD caption on the row above the header.
    const wHdr = findHeaderRow(writers, ['name', 'division']);
    if (wHdr >= 0) {
      const header = writers[wHdr] || [];
      const caption = writers[wHdr - 1] || [];
      const nameCols = header
        .map((h: any, i: number) => (low(h) === 'name' ? i : -1))
        .filter((i: number) => i >= 0);
      for (let r = wHdr + 1; r < writers.length; r++) {
        const row = writers[r] || [];
        for (const c of nameCols) {
          const name = clean(row[c]);
          if (!name) continue;
          const refs = parseScheduleDivisions(row[c + 1]);
          if (!refs.length) continue;
          const role = clean(row[c + 2]);
          const cap = low(caption[c]);
          const pod =
            refs[0].division === 'Associate' ? 'Associate'
            : /non[- ]?pod/.test(cap) ? 'Non-pod'
            : /pod/.test(cap) ? 'Pod'
            : '';
          drafts.push({
            name,
            primary: refs[0],
            secondary: refs.slice(1),
            role,
            roleGroup: classifyRole(role),
            pod,
            shift: '',
            shiftClock: '',
            weekoff: '',
            weekPlan: {},
            backup: '',
            status: '',
            sources: new Set([TABS.writers]),
            flags: new Set(),
            raw: [name, row[c + 1], role],
          });
        }
      }
    }

    // Editor Info: shift, per-weekday off + cover, standing backup.
    const eHdr = findHeaderRow(editors, ['name', 'division']);
    if (eHdr >= 0) {
      const header = editors[eHdr] || [];
      const cName = col(header, ['name']);
      const cDiv = col(header, ['division']);
      const cRole = col(header, ['role']);
      const cTime = col(header, ['timings', 'timing', 'shift']);
      const cBackup = col(header, ['backup']);
      const dayCols: [number, string][] = [];
      header.forEach((h: any, i: number) => {
        const m = WEEKDAY_RE.exec(low(h));
        if (m) dayCols.push([i, WEEKDAY_KEY[m[1].toLowerCase()]]);
      });

      for (let r = eHdr + 1; r < editors.length; r++) {
        const row = editors[r] || [];
        const name = clean(row[cName]);
        if (!name) continue;
        const refs = parseScheduleDivisions(row[cDiv]);
        const roleCell = clean(row[cRole]);
        const pod =
          /associate/i.test(roleCell) ? 'Associate'
          : /non[- ]?pod/i.test(roleCell) ? 'Non-pod'
          : /pod/i.test(roleCell) ? 'Pod'
          : '';
        const plan: Draft['weekPlan'] = {};
        let weekoff = '';
        for (const [i, day] of dayCols) {
          const cell = parseWeekPlanCell(row[i]);
          cell.coverBy = cleanBackup(cell.coverBy);
          plan[day] = cell;
          if (cell.off && !weekoff) weekoff = day;
        }

        let d = find(name, refs);
        if (!d) {
          // Rows for newsroom / stables / other non-desk teams have divisions
          // the alias map does not know; they are not resources for this page.
          if (!refs.length) continue;
          d = {
            name,
            primary: refs[0],
            secondary: refs.slice(1),
            role: 'Editor',
            roleGroup: 'editor',
            pod,
            shift: '',
            shiftClock: '',
            weekoff: '',
            weekPlan: {},
            backup: '',
            status: '',
            sources: new Set(),
            flags: new Set(),
            raw: [],
          };
          drafts.push(d);
        } else {
          for (const ref of refs) {
            if (ref.division !== d.primary.division &&
                !d.secondary.some((s) => s.division === ref.division)) {
              d.secondary.push(ref);
            }
          }
          if (d.roleGroup === 'writer') {
            // Writer Info calls them a writer; the editor tabs say otherwise.
            d.roleGroup = 'editor';
            d.flags.add('role-conflict');
          }
          if (!d.pod) d.pod = pod;
        }
        d.sources.add(TABS.editors);
        d.shift = d.shift || parseShift(row[cTime]);
        d.weekPlan = plan;
        d.weekoff = d.weekoff || weekoff;
        d.backup = cleanBackup(row[cBackup]) || d.backup;
        d.raw.push(...row.slice(0, 12));
      }
    }

    // Roles & Contact: clock hours, shift, week off, active flag.
    const lHdr = findHeaderRow(list, ['editor names']);
    if (lHdr >= 0) {
      const header = list[lHdr] || [];
      const cName = col(header, ['editor names', 'name']);
      const cDiv = col(header, ['sports', 'division']);
      const cRole = col(header, ['primary positioning', 'role']);
      const cClock = col(header, ['timing']);
      const cShift = col(header, ['shift']);
      const cOff = col(header, ['week off', 'weekly off']);
      const cStatus = col(header, ['status']);

      for (let r = lHdr + 1; r < list.length; r++) {
        const row = list[r] || [];
        const name = clean(row[cName]);
        if (!name) continue; // section captions live in the Sports column only
        const refs = parseScheduleDivisions(row[cDiv]);
        if (!refs.length) continue; // execs, MSN, newsletter — not desk resources

        let d = find(name, refs);
        if (!d) {
          d = {
            name,
            primary: refs[0],
            secondary: refs.slice(1),
            role: clean(row[cRole]) || 'Editor',
            roleGroup: 'editor',
            pod: refs[0].division === 'Associate' ? 'Associate' : '',
            shift: '',
            shiftClock: '',
            weekoff: '',
            weekPlan: {},
            backup: '',
            status: '',
            sources: new Set(),
            flags: new Set(),
            raw: [],
          };
          drafts.push(d);
        } else if (d.roleGroup === 'writer') {
          d.roleGroup = 'editor';
          d.flags.add('role-conflict');
        }
        d.sources.add(TABS.list);
        d.shiftClock = cleanClock(row[cClock]) || d.shiftClock;
        d.shift = d.shift || parseShift(row[cShift]);
        d.weekoff = d.weekoff || clean(row[cOff]);
        d.status = clean(row[cStatus]) || d.status;
        if (!d.role || d.role === 'Editor') d.role = clean(row[cRole]) || d.role;
        d.raw.push(...row.slice(0, 9));
      }
    }

    return drafts.map((d) => ({
      id: sid('s', d.primary.division, d.name.toLowerCase()),
      name: d.name,
      primaryDivision: d.primary.division,
      subFeed: d.primary.subFeed,
      secondaryDivisions: d.secondary.map((s) => s.division),
      role: d.role,
      roleGroup: d.roleGroup,
      pod: d.pod,
      shift: d.shift,
      shiftClock: d.shiftClock,
      weekoff: d.weekoff,
      weekPlan: JSON.stringify(d.weekPlan),
      backup: d.backup,
      status: d.status,
      sources: [...d.sources].join(','),
      flags: [...d.flags].join(','),
      rawHash: computeRowHash(d.raw),
    }));
  }

  private uniqueFirstToken(drafts: Draft[], lowerName: string): Draft | undefined {
    const first = lowerName.split(/[\s.]+/)[0];
    if (!first) return undefined;
    const hits = drafts.filter((d) => d.name.toLowerCase().split(/[\s.]+/)[0] === first);
    return hits.length === 1 ? hits[0] : undefined;
  }

  // ── Leave logs ──

  private parseLeaves(rows: Row[], roleTag: 'writer' | 'editor'): ParsedLeave[] {
    const hdr = findHeaderRow(rows, ['name', 'leave start']);
    if (hdr < 0) return [];
    const header = rows[hdr] || [];
    const cTs = col(header, ['timestamp']);
    const cName = col(header, ['name']);
    const cStart = col(header, ['leave start']);
    const cEnd = col(header, ['leave end']);
    const cDays = col(header, ['days']);
    const cType = col(header, ['type']);

    const out: ParsedLeave[] = [];
    for (let r = hdr + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const name = clean(row[cName]);
      const start = parseDateOnly(row[cStart]);
      // The empty log carries a "No … leave records" sentence in column A.
      if (!name || !start) continue;
      const end = parseDateOnly(row[cEnd]) || start;
      const loggedAt = parseDateTime(row[cTs]);
      out.push({
        id: sid('l', loggedAt ? loggedAt.toISOString() : '', name.toLowerCase(), start),
        name,
        roleTag,
        leaveStart: start,
        leaveEnd: end,
        days: parseNumber(row[cDays]),
        type: clean(row[cType]) || 'Unspecified',
        loggedAt,
        rawHash: computeRowHash(row.slice(0, 7)),
      });
    }
    return out;
  }

  // ── Quotas ──

  private parseQuotas(dyn: Row[], chart: Row[], divUpdate: Row[]): ParsedDivisionQuota[] {
    // Editorial Chart: division labels on one row, "Operations" figures beneath.
    const chartTotals = new Map<string, number>();
    const opsRow = chart.findIndex((r) => low((r || [])[0]) === 'operations');
    if (opsRow > 0) {
      const labels = chart[opsRow - 1] || [];
      const nums = chart[opsRow] || [];
      labels.forEach((lbl: any, i: number) => {
        const refs = parseScheduleDivisions(lbl);
        const n = parseNumber(nums[i]);
        if (refs.length && n != null) {
          chartTotals.set(`${refs[0].division}|${refs[0].subFeed}`, Math.round(n));
        }
      });
    }

    // Division Update: PoC + Vision/Pod per division.
    const meta = new Map<string, { poc: string; architecture: string }>();
    const dHdr = findHeaderRow(divUpdate, ['division']);
    if (dHdr >= 0) {
      const header = divUpdate[dHdr] || [];
      const cPoc = col(header, ['le/sports poc', 'poc']);
      const cDiv = col(header, ['division']);
      const cArch = col(header, ['ops architecture', 'architecture']);
      for (let r = dHdr + 1; r < divUpdate.length; r++) {
        const row = divUpdate[r] || [];
        const refs = parseScheduleDivisions(row[cDiv]);
        if (!refs.length) continue;
        const poc = clean(row[cPoc]);
        meta.set(`${refs[0].division}|${refs[0].subFeed}`, {
          poc: /^none$/i.test(poc) ? '' : poc,
          architecture: clean(row[cArch]),
        });
      }
    }
    const metaFor = (ref: DivisionRef) =>
      meta.get(`${ref.division}|${ref.subFeed}`) ||
      meta.get(`${ref.division}|`) ||
      { poc: '', architecture: '' };

    // DailyDynamics: "Division | EMP | LNP | Total", ending at a Total row.
    const qHdr = findHeaderRow(dyn, ['division', 'emp'], 12);
    if (qHdr < 0) return [];
    const header = dyn[qHdr] || [];
    const cDiv = col(header, ['division']);
    const cEmp = col(header, ['emp']);
    const cLnp = col(header, ['lnp']);
    const cTot = col(header, ['total']);

    const out: ParsedDivisionQuota[] = [];
    for (let r = qHdr + 1; r < dyn.length; r++) {
      const row = dyn[r] || [];
      const label = clean(row[cDiv]);
      if (!label) continue;
      if (low(label) === 'total') break;
      const refs = parseScheduleDivisions(label);
      if (!refs.length) {
        this.logger.warn(`DailyDynamics: unrecognised division label "${label}"`);
        continue;
      }
      const ref = refs[0];
      const emp = Math.round(parseNumber(row[cEmp]) ?? 0);
      const lnp = Math.round(parseNumber(row[cLnp]) ?? 0);
      const total = Math.round(parseNumber(row[cTot]) ?? emp + lnp);
      const key = `${ref.division}|${ref.subFeed}`;
      const chartTotal = chartTotals.get(key) ?? null;
      const m = metaFor(ref);
      out.push({
        id: sid('q', ref.division, ref.subFeed),
        division: ref.division,
        subFeed: ref.subFeed,
        sourceName: label,
        emp,
        lnp,
        total,
        editorialChartTotal: chartTotal != null && chartTotal !== total ? chartTotal : null,
        poc: m.poc,
        architecture: m.architecture,
        rawHash: computeRowHash([label, emp, lnp, total, chartTotal, m.poc, m.architecture]),
      });
    }
    return out;
  }
}
